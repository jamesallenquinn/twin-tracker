// Happiest Baby / SNOO unofficial API client (read-only).
// Current API host + endpoints mirror the maintained pysnoo2 library.

const BASE = "https://api-us-east-1-prod.happiestbaby.com";
const UA = "okhttp/4.7.2";

async function snooLogin(email, password) {
  const res = await fetch(BASE + "/us/v3/login", {
    method: "POST",
    headers: { "Accept": "application/json", "Content-Type": "application/json;charset=UTF-8", "User-Agent": UA },
    body: JSON.stringify({ grant_type: "password", username: email, password: password, client_id: "snoo_client" })
  });
  const text = await res.text();
  if (!res.ok) throw new Error("SNOO login " + res.status + ": " + text.slice(0, 300));
  const data = JSON.parse(text);
  if (!data.access_token) throw new Error("SNOO login: no access_token: " + text.slice(0, 200));
  return { auth: "Bearer " + data.access_token, raw: data };
}

async function snooGet(auth, path, params) {
  const url = new URL(BASE + path);
  if (params) Object.keys(params).forEach(k => url.searchParams.set(k, params[k]));
  const res = await fetch(url, { headers: { "Accept": "application/json", "Authorization": auth, "User-Agent": UA } });
  const text = await res.text();
  if (!res.ok) throw new Error("SNOO GET " + path + " " + res.status + ": " + text.slice(0, 300));
  return text ? JSON.parse(text) : null;
}

const EP = {
  me: "/us/me/v10/me",
  devices: "/hds/me/v11/devices",
  baby: "/us/me/v10/baby",
  lastSession: id => `/ss/me/v10/babies/${id}/sessions/last`,
  daily: id => `/ss/v2/babies/${id}/sessions/aggregated/daily`
};

function dailyStartTime(d) { return d.toISOString().slice(0, 19) + ".000Z"; }

async function snooDiscover(email, password) {
  const { auth } = await snooLogin(email, password);
  console.log("[snoo] login OK");
  const out = {};
  async function tryGet(label, path, params) {
    try { out[label] = await snooGet(auth, path, params); console.log(`[snoo] ${label}: OK`); }
    catch (e) { out[label] = { error: String(e.message) }; console.log(`[snoo] ${label}: ${e.message}`); }
  }
  await tryGet("me", EP.me);
  await tryGet("devices", EP.devices);
  await tryGet("baby", EP.baby);

  // collect candidate baby ids from devices + baby
  const babyIds = new Set();
  if (Array.isArray(out.devices)) out.devices.forEach(d => { if (d.baby) babyIds.add(d.baby); });
  if (out.baby && (out.baby._id || out.baby.babyId)) babyIds.add(out.baby._id || out.baby.babyId);

  out.sessions = {};
  for (const id of babyIds) {
    try { out.sessions[id] = await snooGet(auth, EP.lastSession(id)); console.log(`[snoo] lastSession(${id}): OK`); }
    catch (e) { out.sessions[id] = { error: String(e.message) }; console.log(`[snoo] lastSession(${id}): ${e.message}`); }
  }
  // probe daily detail on first baby id
  const firstId = [...babyIds][0];
  if (firstId) {
    const start = new Date(); start.setUTCHours(0, 0, 0, 0);
    await tryGet("dailyProbe", EP.daily(firstId), { detailedLevels: "true", levels: "true", startTime: dailyStartTime(start) });
  }

  console.log("[snoo] me keys:", out.me && !out.me.error ? Object.keys(out.me).join(",") : JSON.stringify(out.me));
  if (Array.isArray(out.devices)) {
    console.log(`[snoo] devices: ${out.devices.length}`);
    out.devices.forEach((d, i) => console.log(`   device[${i}] serial=${d.serialNumber} baby=${d.baby} keys=${Object.keys(d).join(",")}`));
  } else console.log("[snoo] devices:", JSON.stringify(out.devices).slice(0, 300));
  console.log("[snoo] baby:", JSON.stringify(out.baby).slice(0, 400));
  console.log("[snoo] sessions:", JSON.stringify(out.sessions).slice(0, 900));
  console.log("[snoo] dailyProbe:", JSON.stringify(out.dailyProbe).slice(0, 1200));
  return { auth, data: out };
}

module.exports = { snooLogin, snooGet, snooDiscover, dailyStartTime, EP };
