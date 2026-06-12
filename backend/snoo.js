// Happiest Baby / SNOO unofficial API client (read-only).
// Endpoints + auth mirror the maintained pysnooapi library (current /us/v2 API).

const BASE = "https://snoo-api.happiestbaby.com";
const APP_HEADERS = {
  "Accept": "*/*",
  "Content-Type": "application/json",
  "User-Agent": "SNOO/2.4.0 (com.happiestbaby.snooapp;) Alamofire/5.3.0"
};

async function snooLogin(email, password) {
  const res = await fetch(BASE + "/us/v2/login", {
    method: "POST",
    headers: APP_HEADERS,
    body: JSON.stringify({ username: email, password: password })
  });
  const text = await res.text();
  if (!res.ok) throw new Error("SNOO login " + res.status + ": " + text.slice(0, 300));
  const data = JSON.parse(text);
  if (!data.access_token) throw new Error("SNOO login: no access_token: " + text.slice(0, 200));
  // Authorization header value is "{token_type} {access_token}", e.g. "bearer eyJ..."
  return { auth: (data.token_type || "bearer") + " " + data.access_token, raw: data };
}

async function snooGet(auth, path, params) {
  const url = new URL(BASE + path);
  if (params) Object.keys(params).forEach(k => url.searchParams.set(k, params[k]));
  const res = await fetch(url, { headers: { "Accept": "*/*", "Authorization": auth, "User-Agent": APP_HEADERS["User-Agent"] } });
  const text = await res.text();
  if (!res.ok) throw new Error("SNOO GET " + path + " " + res.status + ": " + text.slice(0, 300));
  return text ? JSON.parse(text) : null;
}

// daily-aggregated startTime format: "YYYY-MM-DDTHH:MM:SS.000Z"
function dailyStartTime(d) {
  return d.toISOString().slice(0, 19) + ".000Z";
}

async function snooDiscover(email, password) {
  const { auth } = await snooLogin(email, password);
  console.log("[snoo] login OK");
  const out = {};
  async function tryGet(label, path, params) {
    try { out[label] = await snooGet(auth, path, params); console.log(`[snoo] ${label}: OK`); }
    catch (e) { out[label] = { error: String(e.message) }; console.log(`[snoo] ${label}: ${e.message}`); }
  }
  await tryGet("me", "/us/me");
  await tryGet("devices", "/me/devices");
  await tryGet("baby", "/us/v3/me/baby");
  await tryGet("lastSession", "/analytics/sessions/last");

  // try per-baby daily detail using whatever baby id we can find
  const babyId = (out.baby && (out.baby._id || out.baby.babyId)) ||
    (Array.isArray(out.devices) && out.devices[0] && out.devices[0].baby);
  if (babyId) {
    const start = new Date(); start.setUTCHours(0, 0, 0, 0);
    await tryGet("dailyToday", `/ss/v2/babies/${babyId}/sessions/aggregated/daily`,
      { detailedLevels: "true", levels: "true", startTime: dailyStartTime(start) });
  } else {
    console.log("[snoo] no baby id found to query daily detail");
  }

  // Summary that won't leak full payloads but shows shape
  console.log("[snoo] me keys:", out.me && !out.me.error ? Object.keys(out.me).join(",") : out.me);
  if (Array.isArray(out.devices)) {
    console.log(`[snoo] devices: ${out.devices.length}`);
    out.devices.forEach((d, i) => console.log(`   device[${i}] serial=${d.serialNumber} baby=${d.baby} name=${d.name || d.deviceName || "?"}`));
  } else { console.log("[snoo] devices:", out.devices); }
  console.log("[snoo] baby keys:", out.baby && !out.baby.error ? Object.keys(out.baby).join(",") : out.baby);
  console.log("[snoo] lastSession:", JSON.stringify(out.lastSession).slice(0, 500));
  console.log("[snoo] dailyToday:", JSON.stringify(out.dailyToday).slice(0, 1500));
  return { auth, data: out };
}

module.exports = { snooLogin, snooGet, snooDiscover, dailyStartTime };
