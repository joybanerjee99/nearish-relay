// Neerly v1.0: notifications for the native apps.
//  - iPhone: Apple Push Notification service (APNs), token-based auth over HTTP/2.
//      Env: APNS_KEY (the .p8 file's text; "\n" may be written as \n), APNS_KEY_ID, APNS_TEAM_ID,
//           APNS_TOPIC (the app's bundle id, e.g. net.neerly.app), APNS_ENV ('production' or 'sandbox').
//  - Android: Firebase Cloud Messaging (FCM) HTTP v1.
//      Env: FCM_SERVICE_ACCOUNT (the service account JSON from Firebase, as one line).
// No extra packages: Node's http2 and crypto do the work. Without the env vars, native sends are skipped.
import http2 from 'http2';
import crypto from 'crypto';

const b64u = (b) => Buffer.from(b).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

// ── APNs ──────────────────────────────────────────────────────────────────────
let apnsJwt = null, apnsJwtAt = 0, apnsSession = null;
export const apnsConfigured = () => !!(process.env.APNS_KEY && process.env.APNS_KEY_ID && process.env.APNS_TEAM_ID && process.env.APNS_TOPIC);
function apnsToken() {
  // Apple accepts a token for up to an hour; make a new one every 50 minutes.
  if (apnsJwt && Date.now() - apnsJwtAt < 50 * 60 * 1000) return apnsJwt;
  const key = process.env.APNS_KEY.replace(/\\n/g, '\n');
  const head = b64u(JSON.stringify({ alg: 'ES256', kid: process.env.APNS_KEY_ID }));
  const body = b64u(JSON.stringify({ iss: process.env.APNS_TEAM_ID, iat: Math.floor(Date.now() / 1000) }));
  const sig = crypto.sign('sha256', Buffer.from(`${head}.${body}`), { key, dsaEncoding: 'ieee-p1363' });
  apnsJwt = `${head}.${body}.${b64u(sig)}`; apnsJwtAt = Date.now();
  return apnsJwt;
}
function apnsConnect() {
  if (apnsSession && !apnsSession.closed && !apnsSession.destroyed) return apnsSession;
  const host = process.env.APNS_ENV === 'sandbox' ? 'https://api.sandbox.push.apple.com' : 'https://api.push.apple.com';
  apnsSession = http2.connect(host);
  apnsSession.on('error', () => { apnsSession = null; });
  apnsSession.on('close', () => { apnsSession = null; });
  apnsSession.unref?.();
  return apnsSession;
}
// Resolves { ok, gone } — gone: Apple says this device token is no longer valid (forget it).
export function sendApns(token, msg) {
  return new Promise((resolve) => {
    let session;
    try { session = apnsConnect(); } catch { return resolve({ ok: false }); }
    const payload = JSON.stringify({
      aps: { alert: { title: msg.title, body: msg.body || '' }, sound: 'default', 'thread-id': msg.tag ? String(msg.tag).split('-')[0] : undefined },
      url: msg.url || '', tag: msg.tag || '',
    });
    const req = session.request({
      ':method': 'POST', ':path': `/3/device/${token}`,
      authorization: `bearer ${apnsToken()}`, 'apns-topic': process.env.APNS_TOPIC,
      'apns-push-type': 'alert', 'apns-priority': '10',
      'apns-expiration': String(Math.floor(Date.now() / 1000) + (msg.ttl ?? 3600)),
      ...(msg.tag ? { 'apns-collapse-id': String(msg.tag).slice(0, 64) } : {}),
    });
    let status = 0, data = '';
    req.setEncoding('utf8');
    req.on('response', (h) => { status = h[':status']; });
    req.on('data', (c) => { data += c; });
    req.on('end', () => {
      let reason = ''; try { reason = JSON.parse(data || '{}').reason || ''; } catch {}
      resolve({ ok: status === 200, gone: status === 410 || reason === 'BadDeviceToken' || reason === 'Unregistered', status, reason });
    });
    req.on('error', () => resolve({ ok: false }));
    req.setTimeout(10000, () => { req.close(); resolve({ ok: false }); });
    req.end(payload);
  });
}

// ── FCM ───────────────────────────────────────────────────────────────────────
let fcmAccess = null, fcmAccessUntil = 0, fcmAccount = undefined;
function fcmSa() {
  if (fcmAccount !== undefined) return fcmAccount;
  try { fcmAccount = process.env.FCM_SERVICE_ACCOUNT ? JSON.parse(process.env.FCM_SERVICE_ACCOUNT) : null; } catch { fcmAccount = null; }
  return fcmAccount;
}
export const fcmConfigured = () => !!fcmSa()?.private_key;
async function fcmToken() {
  if (fcmAccess && Date.now() < fcmAccessUntil) return fcmAccess;
  const sa = fcmSa(), t = Math.floor(Date.now() / 1000);
  const head = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = b64u(JSON.stringify({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: 'https://oauth2.googleapis.com/token', iat: t, exp: t + 3600 }));
  const sig = crypto.sign('sha256', Buffer.from(`${head}.${body}`), sa.private_key);
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${head}.${body}.${b64u(sig)}` });
  const d = await r.json();
  if (!d.access_token) throw new Error('FCM auth failed: ' + (d.error_description || d.error || r.status));
  fcmAccess = d.access_token; fcmAccessUntil = Date.now() + 50 * 60 * 1000;
  return fcmAccess;
}
export async function sendFcm(token, msg) {
  try {
    const sa = fcmSa();
    const r = await fetch(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
      method: 'POST', headers: { Authorization: `Bearer ${await fcmToken()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: { token,
        notification: { title: msg.title, body: msg.body || '' },
        data: { url: msg.url || '', tag: msg.tag || '' },
        android: { priority: 'HIGH', ttl: `${msg.ttl ?? 3600}s`, notification: { tag: msg.tag || undefined, channel_id: 'neerly', default_sound: true } } } }),
    });
    if (r.ok) return { ok: true };
    const d = await r.json().catch(() => ({}));
    const code = d?.error?.details?.find?.(x => x.errorCode)?.errorCode || d?.error?.status;
    return { ok: false, gone: r.status === 404 || code === 'UNREGISTERED', status: r.status, reason: code };
  } catch (e) { return { ok: false, reason: e.message }; }
}
