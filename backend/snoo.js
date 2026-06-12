// Happiest Baby / SNOO unofficial API client (read-only).
// Auth = AWS Cognito InitiateAuth -> IdToken, then Bearer on the data API.
// Mirrors the maintained python-snoo (Home Assistant) library.

const COGNITO = "https://cognito-idp.us-east-1.amazonaws.com/";
const API = "https://api-us-east-1-prod.happiestbaby.com";
const COGNITO_CLIENT_ID = "6kqofhc8hm394ielqdkvli0oea";
const UA = "okhttp/4.12.0";

async function snooLogin(email, password) {
  const res = await fetch(COGNITO, {
    method: "POST",
    headers: {
      "X-Amz-Target": "AWSCognitoIdentityProviderService.InitiateAuth",
      "Content-Type": "application/x-amz-json-1.1",
      "Accept": "application/json",
      "User-Agent": UA
    },
    body: JSON.stringify({
      AuthParameters: { USERNAME: email, PASSWORD: password },
      AuthFlow: "USER_PASSWORD_AUTH",
      ClientId: COGNITO_CLIENT_ID
    })
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch (e) { throw new Error("Cognito non-JSON " + res.status + ": " + text.slice(0, 200)); }
  if (data.__type) throw new Error("SNOO auth failed: " + data.__type + " " + (data.message || ""));
  const r = data.AuthenticationResult;
  if (!r || !r.IdToken) throw new Error("Cognito: no IdToken: " + text.slice(0, 200));
  return { idToken: r.IdToken, accessToken: r.AccessToken, refresh: r.RefreshToken, expiresIn: r.ExpiresIn };
}

async function snooGet(idToken, path, params) {
  const url = new URL(API + path);
  if (params) Object.keys(params).forEach(k => url.searchParams.set(k, params[k]));
  const res = await fetch(url, { headers: { "Accept": "application/json", "Authorization": "Bearer " + idToken, "User-Agent": UA } });
  const text = await res.text();
  if (!res.ok) throw new Error("SNOO GET " + path + " " + res.status + ": " + text.slice(0, 200));
  return text ? JSON.parse(text) : null;
}

const EP = {
  devices: "/hds/me/v11/devices",
  babies: "/us/me/v10/babies",
  lastSession: id => `/ss/me/v10/babies/${id}/sessions/last`,
  daily: id => `/ss/v2/babies/${id}/sessions/aggregated/daily`
};
function dailyStartTime(d) { return d.toISOString().slice(0, 19) + ".000Z"; }

async function snooDiscover(email, password) {
  const { idToken } = await snooLogin(email, password);
  console.log("[snoo] Cognito login OK");
  const out = {};
  async function tryGet(label, path, params) {
    try { out[label] = await snooGet(idToken, path, params); console.log(`[snoo] ${label}: OK`); }
    catch (e) { out[label] = { error: String(e.message) }; console.log(`[snoo] ${label}: ${e.message}`); }
  }
  await tryGet("devices", EP.devices);
  await tryGet("babies", EP.babies);

  const devices = (out.devices && out.devices.snoo) || (Array.isArray(out.devices) ? out.devices : []);
  const babies = Array.isArray(out.babies) ? out.babies : [];

  console.log(`[snoo] babies: ${babies.length}`);
  babies.forEach((b, i) => console.log(`   baby[${i}] id=${b._id || b.babyId} name=${b.babyName || b.name}`));
  console.log(`[snoo] devices: ${devices.length}`);
  devices.forEach((d, i) => console.log(`   device[${i}] serial=${d.serialNumber} baby=${d.baby} thing=${d.awsIoT && d.awsIoT.thingName}`));

  const ids = new Set();
  babies.forEach(b => ids.add(b._id || b.babyId));
  devices.forEach(d => { if (d.baby) ids.add(d.baby); });

  out.sessions = {};
  for (const id of ids) {
    if (!id) continue;
    try { out.sessions[id] = await snooGet(idToken, EP.lastSession(id)); console.log(`[snoo] lastSession(${id}): OK`); }
    catch (e) { console.log(`[snoo] lastSession(${id}): ${e.message}`); }
  }
  const firstId = [...ids][0];
  if (firstId) {
    const start = new Date(); start.setUTCHours(0, 0, 0, 0);
    await tryGet("dailyProbe", EP.daily(firstId), { detailedLevels: "true", levels: "true", startTime: dailyStartTime(start) });
  }
  console.log("[snoo] lastSession sample:", JSON.stringify(out.sessions).slice(0, 1000));
  console.log("[snoo] dailyProbe sample:", JSON.stringify(out.dailyProbe).slice(0, 1500));
  return { idToken, data: out };
}

module.exports = { snooLogin, snooGet, snooDiscover, dailyStartTime, EP };
