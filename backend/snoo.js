// Happiest Baby / SNOO unofficial API client (read-only).
// Endpoints + auth flow mirror the maintained pysnoo library.

const SNOO = "https://snoo-api.happiestbaby.com";
const UA = "okhttp/4.7.2";

async function snooLogin(email, password) {
  const res = await fetch(SNOO + "/us/login/", {
    method: "POST",
    headers: { "Accept": "application/json", "Content-Type": "application/json;charset=UTF-8", "User-Agent": UA },
    body: JSON.stringify({ grant_type: "password", username: email, password: password, client_id: "snoo_client" })
  });
  const text = await res.text();
  if (!res.ok) throw new Error("SNOO login " + res.status + ": " + text.slice(0, 400));
  const tok = JSON.parse(text);
  if (!tok.access_token) throw new Error("SNOO login: no access_token in response: " + text.slice(0, 200));
  return tok;
}

async function snooGet(token, path, params) {
  const url = new URL(SNOO + path);
  if (params) Object.keys(params).forEach(k => url.searchParams.set(k, params[k]));
  const res = await fetch(url, {
    headers: { "Accept": "application/json", "Authorization": "Bearer " + token, "User-Agent": UA }
  });
  const text = await res.text();
  if (!res.ok) throw new Error("SNOO GET " + path + " " + res.status + ": " + text.slice(0, 300));
  return text ? JSON.parse(text) : null;
}

// aggregated session startTime format: "YYYY-MM-DD HH:MM:SS.mmm" (server-local tz)
function aggStartTime(d) {
  const p = n => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} 00:00:00.000`;
}

async function snooDiscover(email, password) {
  const tok = await snooLogin(email, password);
  console.log("[snoo] login OK; token keys:", Object.keys(tok).join(","));
  const out = {};
  async function tryGet(label, path, params) {
    try { out[label] = await snooGet(tok.access_token, path, params); console.log(`[snoo] ${label}: OK`); }
    catch (e) { out[label] = { error: String(e.message) }; console.log(`[snoo] ${label}: ${e.message}`); }
  }
  await tryGet("me", "/us/me/");
  await tryGet("devices", "/ds/me/devices/");
  await tryGet("baby", "/us/v3/me/baby/");
  await tryGet("lastSession", "/ss/v2/sessions/last/");
  await tryGet("aggregatedToday", "/ss/v2/sessions/aggregated/", { startTime: aggStartTime(new Date()) });
  console.log("[snoo] ===== RAW DISCOVERY (trimmed) =====");
  console.log(JSON.stringify(out, null, 2).slice(0, 6000));
  return { token: tok, data: out };
}

module.exports = { snooLogin, snooGet, snooDiscover, aggStartTime };
