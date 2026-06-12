// Twin Tracker scheduled backend.
// Phase: dry-run foundation — reads live Firestore data and reports which
// alerts WOULD fire. web-push sending and SNOO import are wired in next.
//
// Firestore rules are open, so we read over REST with the public web API key.

const PROJECT = "twin-feeding-log-tracker";
const API_KEY = "AIzaSyBfeIYcl4QDymvqfN8n7r8nhc72sbJP9y8"; // public web key (already in client)
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;

const DRY_RUN = String(process.env.DRY_RUN || "true") !== "false";

// Alert thresholds (mirror the app defaults).
const TIRED_AWAKE_MIN = 3 * 60;     // baby awake this long -> tired warning
const FEED_DUE_MIN = 3 * 60;        // this long since last bottle -> feed due
const BABIES = ["Rowan", "Julian"];

// ---- Firestore REST helpers ----
function decodeValue(v) {
  if (v == null) return null;
  if ("stringValue" in v) return v.stringValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("timestampValue" in v) return v.timestampValue;
  if ("nullValue" in v) return null;
  if ("mapValue" in v) {
    const o = {};
    const f = (v.mapValue.fields) || {};
    for (const k in f) o[k] = decodeValue(f[k]);
    return o;
  }
  if ("arrayValue" in v) return ((v.arrayValue.values) || []).map(decodeValue);
  return null;
}
function decodeDoc(doc) {
  const out = { _id: doc.name.split("/").pop() };
  const f = doc.fields || {};
  for (const k in f) out[k] = decodeValue(f[k]);
  return out;
}
async function listCollection(name) {
  let docs = [], pageToken = "";
  do {
    const url = `${BASE}/${name}?key=${API_KEY}&pageSize=300${pageToken ? "&pageToken=" + encodeURIComponent(pageToken) : ""}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Firestore ${name} ${res.status}: ${await res.text()}`);
    const data = await res.json();
    (data.documents || []).forEach(d => docs.push(decodeDoc(d)));
    pageToken = data.nextPageToken || "";
  } while (pageToken);
  return docs;
}

// ---- domain helpers ----
const minsSince = iso => Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
const fmt = m => (m >= 60 ? Math.floor(m / 60) + "h " + (m % 60) + "m" : m + "m");

function activeNap(naps, baby) {
  return naps.find(n => n.baby === baby && !n.endTime);
}
function lastCompletedNap(naps, baby) {
  return naps
    .filter(n => n.baby === baby && n.endTime)
    .sort((a, b) => new Date(b.endTime) - new Date(a.endTime))[0];
}
function lastBottle(feeds, baby) {
  return feeds
    .filter(f => f.baby === baby)
    .sort((a, b) => new Date(b.time) - new Date(a.time))[0];
}

function evaluateAlerts(feeds, naps) {
  const alerts = [];
  for (const baby of BABIES) {
    const nap = activeNap(naps, baby);
    if (!nap) {
      const last = lastCompletedNap(naps, baby);
      if (last) {
        const awake = minsSince(last.endTime);
        if (awake >= TIRED_AWAKE_MIN) {
          alerts.push({ baby, kind: "tired", body: `${baby} has been awake ${fmt(awake)} — may be getting tired.` });
        }
      }
    }
    const bottle = lastBottle(feeds, baby);
    if (bottle) {
      const since = minsSince(bottle.time);
      if (since >= FEED_DUE_MIN && !nap) {
        alerts.push({ baby, kind: "feed", body: `${baby}'s last bottle was ${fmt(since)} ago — feed may be due.` });
      }
    }
  }
  return alerts;
}

async function main() {
  console.log(`[twin-tracker] start  DRY_RUN=${DRY_RUN}  ${new Date().toISOString()}`);
  const [feeds, naps] = await Promise.all([listCollection("feedingLogs"), listCollection("napLogs")]);
  console.log(`[twin-tracker] loaded ${feeds.length} feeds, ${naps.length} naps`);

  for (const baby of BABIES) {
    const nap = activeNap(naps, baby);
    const last = lastCompletedNap(naps, baby);
    const bottle = lastBottle(feeds, baby);
    console.log(
      `  ${baby}: ${nap ? "ASLEEP " + fmt(minsSince(nap.startTime)) : "awake " + (last ? fmt(minsSince(last.endTime)) : "?")}` +
      `  | last bottle ${bottle ? fmt(minsSince(bottle.time)) + " ago (" + bottle.oz + "oz)" : "none"}`
    );
  }

  const alerts = evaluateAlerts(feeds, naps);
  if (!alerts.length) {
    console.log("[twin-tracker] no alerts would fire right now.");
  } else {
    console.log(`[twin-tracker] ${alerts.length} alert(s) would fire:`);
    alerts.forEach(a => console.log(`   -> [${a.kind}] ${a.body}`));
  }

  if (DRY_RUN) {
    console.log("[twin-tracker] dry run — no notifications sent, no SNOO import. Done.");
    return;
  }
  // TODO(next): load pushSubs, send web-push for new alerts (throttled), import SNOO sessions.
  console.log("[twin-tracker] live send/import not yet implemented in this build.");
}

main().catch(err => { console.error("[twin-tracker] ERROR:", err); process.exit(1); });
