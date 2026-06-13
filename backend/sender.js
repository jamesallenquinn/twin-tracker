// Twin Tracker scheduled backend.
// - Imports SNOO sleep sessions into Firestore (SNOO = source of truth for sleep).
// - Sends web-push alerts (tired / feed-due / napping-too-long) with throttling.
// Firestore rules are open, so we read/write over REST with the public web API key.

const PROJECT = "twin-feeding-log-tracker";
const API_KEY = "AIzaSyBfeIYcl4QDymvqfN8n7r8nhc72sbJP9y8"; // public web key
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;

const DRY_RUN = String(process.env.DRY_RUN || "true") !== "false";

const TIRED_AWAKE_MIN = 3 * 60;     // awake this long -> tired warning
const FEED_DUE_MIN = 3 * 60;        // since last bottle -> feed due
const NAP_TOO_LONG_MIN = 2 * 60;    // active nap this long -> napping warning
const THROTTLE_MIN = 90;            // don't repeat the same alert within this window
const MIN_SESSION_MIN = 5;          // ignore SNOO on/off blips shorter than this
const MAX_SLEEP_MS = 12 * 3600000;  // cap an auto-closed orphaned sleep at 12h
const TZ = "America/Los_Angeles";
const TWIN_BABY_IDS = { Rowan: null, Julian: null }; // resolved by name at runtime
const BABIES = ["Rowan", "Julian"];

// ---- Firestore REST ----
function decodeValue(v) {
  if (v == null) return null;
  if ("stringValue" in v) return v.stringValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("timestampValue" in v) return v.timestampValue;
  if ("mapValue" in v) { const o = {}, f = v.mapValue.fields || {}; for (const k in f) o[k] = decodeValue(f[k]); return o; }
  if ("arrayValue" in v) return (v.arrayValue.values || []).map(decodeValue);
  return null;
}
function decodeDoc(d) { const o = { _id: d.name.split("/").pop() }, f = d.fields || {}; for (const k in f) o[k] = decodeValue(f[k]); return o; }
function encodeValue(v) {
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number") return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  return { stringValue: String(v) };
}
async function listCollection(name) {
  let docs = [], pageToken = "";
  do {
    const url = `${BASE}/${name}?key=${API_KEY}&pageSize=300${pageToken ? "&pageToken=" + encodeURIComponent(pageToken) : ""}`;
    const res = await fetch(url);
    if (!res.ok) { if (res.status === 404) return docs; throw new Error(`Firestore ${name} ${res.status}: ${await res.text()}`); }
    const data = await res.json();
    (data.documents || []).forEach(d => docs.push(decodeDoc(d)));
    pageToken = data.nextPageToken || "";
  } while (pageToken);
  return docs;
}
async function patchDoc(collection, docId, obj) {
  const fields = {}; Object.keys(obj).forEach(k => fields[k] = encodeValue(obj[k]));
  const url = `${BASE}/${collection}/${encodeURIComponent(docId)}?key=${API_KEY}`;
  const res = await fetch(url, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ fields }) });
  if (!res.ok) throw new Error(`Firestore PATCH ${collection}/${docId} ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}
async function deleteDocRest(collection, docId) {
  await fetch(`${BASE}/${collection}/${encodeURIComponent(docId)}?key=${API_KEY}`, { method: "DELETE" });
}

// ---- helpers ----
const minsSince = iso => Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
const fmt = m => (m >= 60 ? Math.floor(m / 60) + "h " + (m % 60) + "m" : m + "m");
function inferSleepTypeNY(iso) {
  let h = Number(new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "2-digit", hour12: false }).format(new Date(iso))) % 24;
  return (h >= 21 || h < 7) ? "bedtime" : "nap";
}
function activeNap(naps, baby) { return naps.find(n => n.baby === baby && !n.endTime); }
function lastCompletedNap(naps, baby) { return naps.filter(n => n.baby === baby && n.endTime).sort((a, b) => new Date(b.endTime) - new Date(a.endTime))[0]; }
function lastBottle(feeds, baby) { return feeds.filter(f => f.baby === baby).sort((a, b) => new Date(b.time) - new Date(a.time))[0]; }
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function runQuery(structuredQuery) {
  const res = await fetch(`${BASE}:runQuery?key=${API_KEY}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ structuredQuery }) });
  if (!res.ok) throw new Error(`Firestore runQuery ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return (data || []).filter(r => r.document).map(r => decodeDoc(r.document));
}
function queryRecent(name, field, limit) {
  return runQuery({ from: [{ collectionId: name }], orderBy: [{ field: { fieldPath: field }, direction: "DESCENDING" }], limit });
}
function queryEquals(name, field, value, limit = 50) {
  return runQuery({ from: [{ collectionId: name }], where: { fieldFilter: { field: { fieldPath: field }, op: "EQUAL", value: { stringValue: value } } }, limit });
}
// Lean reads so a 2-min loop stays well under Firestore's free 50k/day: recent feeds/naps + any open naps.
async function loadRecent() {
  const [recentFeeds, recentNaps, openNaps] = await Promise.all([
    queryRecent("feedingLogs", "time", 24),
    queryRecent("napLogs", "startTime", 24),
    queryEquals("napLogs", "endTime", "")
  ]);
  const napMap = {}; [...recentNaps, ...openNaps].forEach(n => napMap[n._id] = n);
  return { feeds: recentFeeds, naps: Object.values(napMap) };
}
// Cache the SNOO token so we don't hit the (unofficial) login endpoint every pass.
let snooTok = { token: null, ts: 0 };
async function getSnooToken() {
  if (snooTok.token && Date.now() - snooTok.ts < 50 * 60000) return snooTok.token;
  const email = process.env.SNOO_EMAIL, password = process.env.SNOO_PASSWORD;
  if (!email || !password) return null;
  const { snooLogin } = require("./snoo");
  snooTok = { token: (await snooLogin(email, password)).idToken, ts: Date.now() };
  return snooTok.token;
}

// ---- SNOO import (source of truth for sleep) ----
async function importSnoo(dryRun) {
  const { snooGet, EP } = require("./snoo");
  const idToken = await getSnooToken();
  if (!idToken) { console.log("[snoo] no credentials set, skipping import"); return; }
  let babies;
  try { babies = await snooGet(idToken, EP.babies); } catch (e) { console.log("[snoo] babies failed:", e.message); snooTok = { token: null, ts: 0 }; return; }
  (Array.isArray(babies) ? babies : []).forEach(b => { const n = b.babyName || b.name; if (n in TWIN_BABY_IDS) TWIN_BABY_IDS[n] = b._id || b.babyId; });

  let openSnoo = [];
  try { openSnoo = (await queryEquals("napLogs", "endTime", "")).filter(n => n.source === "snoo"); } catch (e) { console.log("[snoo] open-naps query failed:", e.message); }
  const now = Date.now();

  for (const baby of BABIES) {
    const id = TWIN_BABY_IDS[baby];
    if (!id) { console.log(`[snoo] no SNOO baby named ${baby}`); continue; }
    let s;
    try { s = await snooGet(idToken, EP.lastSession(id)); } catch (e) { console.log(`[snoo] session ${baby}: ${e.message}`); continue; }
    if (!s || !s.startTime) { console.log(`[snoo] ${baby}: no session data`); continue; }
    const levels = s.levels || [];
    const completed = levels.length > 0 && levels[levels.length - 1].level === "ONLINE";
    const startIso = new Date(s.startTime).toISOString();
    const startMs = new Date(startIso).getTime();
    const realEndIso = s.endTime ? new Date(s.endTime).toISOString() : "";
    const sleepType = inferSleepTypeNY(startIso);
    const docId = `snoo-${baby}-${startMs}`;

    // SAFEGUARD: only the CURRENT session may stay open. Close every other open SNOO
    // entry for this baby (a missed wake-up) so nothing is ever stuck "asleep" forever.
    const opens = openSnoo.filter(n => n.baby === baby);
    for (const d of opens) {
      const dStartMs = new Date(d.startTime).getTime();
      if (dStartMs === startMs) continue; // the current session, handled below
      const closeMs = Math.max(dStartMs + 60000, Math.min(startMs, dStartMs + MAX_SLEEP_MS));
      const closeIso = new Date(closeMs).toISOString();
      if (dryRun) { console.log(`[snoo] WOULD close orphaned open ${d._id} -> ${closeIso}`); }
      else { try { await patchDoc("napLogs", d._id, { baby, startTime: d.startTime, endTime: closeIso, sleepType: d.sleepType || inferSleepTypeNY(d.startTime), source: "snoo" }); console.log(`[snoo] closed orphaned open ${d._id} -> ${closeIso}`); } catch (e) { console.log(`[snoo] close ${d._id}: ${e.message}`); } }
    }

    // SAFEGUARD: ignore on/off blips shorter than the minimum.
    const durMin = (completed ? new Date(realEndIso).getTime() : now) - startMs;
    if (completed && durMin / 60000 < MIN_SESSION_MIN) { console.log(`[snoo] ${baby}: skip blip (${(durMin / 60000).toFixed(1)}m)`); continue; }

    const endIso = completed ? realEndIso : ""; // ongoing stays open (live); the sweep guarantees it closes
    const fields = { baby, startTime: startIso, endTime: endIso, sleepType, source: "snoo" };
    const desc = `${baby} ${startIso} -> ${endIso || "(sleeping)"} [${sleepType}] ~${Math.round(durMin / 60000)}m`;
    if (dryRun) { console.log(`[snoo] WOULD upsert ${docId}: ${desc}`); }
    else { try { await patchDoc("napLogs", docId, fields); console.log(`[snoo] upserted ${docId}: ${desc}`); } catch (e) { console.log(`[snoo] write ${baby}: ${e.message}`); } }
  }
}

// ---- alerts + push ----
function evaluateAlerts(feeds, naps) {
  const alerts = [];
  for (const baby of BABIES) {
    const nap = activeNap(naps, baby);
    if (nap) {
      const type = nap.sleepType || inferSleepTypeNY(nap.startTime);
      if (type !== "bedtime") {
        const dur = minsSince(nap.startTime);
        if (dur >= NAP_TOO_LONG_MIN) alerts.push({ baby, kind: "napping", title: "Long nap", body: `${baby} has been napping ${fmt(dur)}.` });
      }
      continue; // asleep -> no tired/feed alerts
    }
    const last = lastCompletedNap(naps, baby);
    if (last) { const awake = minsSince(last.endTime); if (awake >= TIRED_AWAKE_MIN) alerts.push({ baby, kind: "tired", title: "Tired baby", body: `${baby} has been awake ${fmt(awake)}.` }); }
    const bottle = lastBottle(feeds, baby);
    if (bottle) { const since = minsSince(bottle.time); if (since >= FEED_DUE_MIN) alerts.push({ baby, kind: "feed", title: "Feed due", body: `${baby}'s last bottle was ${fmt(since)} ago.` }); }
  }
  return alerts;
}

async function sendPushAlerts(dryRun, feeds, naps) {
  const alerts = evaluateAlerts(feeds, naps);
  console.log(`[push] ${alerts.length} alert(s) currently active.`);
  alerts.forEach(a => console.log(`   - [${a.kind}] ${a.body}`));
  if (!alerts.length) return;

  let subs = [], state = {};
  try {
    subs = await listCollection("pushSubs");
    (await listCollection("alertState")).forEach(d => state[d._id] = d);
  } catch (e) {
    console.log("[push] push collections not accessible yet — Firestore rules need pushSubs/alertState. Skipping push.", e.message);
    return;
  }
  if (!subs.length) console.log("[push] no subscriptions registered yet (install the app + Enable Notifications).");

  let webpush = null;
  if (!dryRun && subs.length) {
    webpush = require("web-push");
    webpush.setVapidDetails(process.env.VAPID_SUBJECT, process.env.VAPID_PUBLIC, process.env.VAPID_PRIVATE);
  }

  for (const a of alerts) {
    const key = `${a.kind}-${a.baby}`;
    const prev = state[key];
    if (prev && prev.lastNotified && minsSince(prev.lastNotified) < THROTTLE_MIN) { console.log(`[push] throttled: ${key} (sent ${minsSince(prev.lastNotified)}m ago)`); continue; }
    if (dryRun) { console.log(`[push] WOULD send "${a.title}: ${a.body}" to ${subs.length} device(s)`); continue; }
    let sent = 0;
    for (const sub of subs) {
      try {
        await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          JSON.stringify({ title: a.title, body: a.body, tag: a.kind + "-" + a.baby }));
        sent++;
      } catch (e) {
        const code = e.statusCode || 0;
        if (code === 404 || code === 410) { await deleteDocRest("pushSubs", sub._id); console.log(`[push] removed expired sub ${sub._id}`); }
        else console.log(`[push] send error (${code}): ${e.message}`);
      }
    }
    await patchDoc("alertState", key, { kind: a.kind, baby: a.baby, lastNotified: new Date().toISOString(), body: a.body });
    console.log(`[push] sent ${key} to ${sent}/${subs.length} device(s)`);
  }
}

async function main() {
  console.log(`[twin-tracker] start  DRY_RUN=${DRY_RUN}  MODE=${process.env.MODE || "default"}  ${new Date().toISOString()}`);

  if (process.env.MODE === "snoo-discover") {
    const { snooDiscover } = require("./snoo");
    if (!process.env.SNOO_EMAIL || !process.env.SNOO_PASSWORD) { console.error("SNOO creds not set."); process.exit(1); }
    await snooDiscover(process.env.SNOO_EMAIL, process.env.SNOO_PASSWORD);
    return;
  }

  // Loop internally (default 2-min interval) for real runs — GitHub's cron is too
  // unreliable for frequent scheduling, so one job covers a long stretch. Dry-run /
  // discover do a single pass.
  const lsEnv = process.env.LOOP_SECONDS;
  const loopSec = (lsEnv != null && lsEnv !== "") ? Number(lsEnv)
    : (!DRY_RUN && (process.env.MODE || "default") === "default" ? 19800 : 0);
  const intervalMs = Number(process.env.INTERVAL_SECONDS || 180) * 1000;

  if (loopSec > 0) {
    const end = Date.now() + loopSec * 1000;
    let i = 0;
    while (Date.now() < end) {
      i++;
      console.log(`[twin-tracker] === pass ${i} === ${new Date().toISOString()}`);
      try { await runOnce(DRY_RUN); } catch (e) { console.error("[twin-tracker] pass error:", e.message); }
      if (Date.now() + intervalMs < end) await sleep(intervalMs); else break;
    }
    console.log(`[twin-tracker] loop finished after ${i} passes.`);
  } else {
    await runOnce(DRY_RUN);
  }
  console.log("[twin-tracker] done.");
}

async function runOnce(dryRun) {
  await importSnoo(dryRun);
  const { feeds, naps } = await loadRecent();
  console.log(`[twin-tracker] recent: ${feeds.length} feeds, ${naps.length} naps`);
  await sendPushAlerts(dryRun, feeds, naps);
}

main().catch(err => { console.error("[twin-tracker] ERROR:", err); process.exit(1); });
