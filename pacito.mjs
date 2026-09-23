// ─────────────────────────────────────────────────────────────────────────────
// Pacito — "I'm on my way."
// Time-boxed, sender-initiated live location sharing. v0 = Quick Share only.
//
// Mounted on the existing nearish-relay HTTP server. Every route lives under
// /pacito/... and every table is prefixed pacito_ so nothing collides with
// Orbyt. See server.mjs for the two-line hook.
//
// Privacy rule (Strategy §1.3 #5): location exists only inside an active share.
// When a share stops or expires, its coordinates are wiped from the database.
// ─────────────────────────────────────────────────────────────────────────────
import crypto from 'crypto';

const SESSION_MS        = 30 * 24 * 60 * 60 * 1000; // 30 days
const RESET_MS          = 15 * 60 * 1000;            // 15 minutes
const WATCHING_MS       = 40 * 1000;                 // "watching" = pinged recently (recipients poll every 17s)
const DURATIONS         = [15, 30, 60];              // minutes, for new shares and extensions
const MAX_SHARE_MS      = 4 * 60 * 60 * 1000;        // free cap: 4h total incl. extensions
const MAX_RECIPIENTS    = 20;
const REQUEST_COOLDOWN  = 10 * 60 * 1000;            // one "request an update" per person per share per 10 min
const MAX_BODY          = 32 * 1024;

export function createPacito({ db, resend, appUrl, fromEmail }) {
  const PAGE_URL = process.env.PACITO_URL || `${appUrl.replace(/\/$/, '')}/pacito.html`;
  const FROM = process.env.PACITO_FROM_EMAIL || fromEmail || 'Pacito <onboarding@resend.dev>';
  const PEPPER = process.env.PASSWORD_SALT || '';
  if (!PEPPER) console.warn('[pacito] PASSWORD_SALT not set — add it in Render before real users sign up');

  // ── Schema ────────────────────────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS pacito_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      pw_hash TEXT NOT NULL,
      pw_salt TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_seen INTEGER
    );
    CREATE TABLE IF NOT EXISTS pacito_sessions (
      token TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pacito_reset_tokens (
      token TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      used INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS pacito_contacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_email TEXT NOT NULL,
      email TEXT NOT NULL,
      nickname TEXT,
      created_at INTEGER NOT NULL,
      UNIQUE(owner_email, email)
    );
    CREATE TABLE IF NOT EXISTS pacito_shares (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token TEXT UNIQUE NOT NULL,
      sender_email TEXT NOT NULL,
      sender_name TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      ended_at INTEGER,
      lat REAL, lng REAL, accuracy REAL,
      loc_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS pacito_share_recipients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      share_id INTEGER NOT NULL,
      email TEXT NOT NULL,
      nickname TEXT,
      view_token TEXT UNIQUE NOT NULL,
      emailed INTEGER DEFAULT 0,
      opened_at INTEGER,
      last_ping_at INTEGER,
      UNIQUE(share_id, email)
    );
    CREATE TABLE IF NOT EXISTS pacito_update_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      share_id INTEGER NOT NULL,
      requester_email TEXT NOT NULL,
      requester_name TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_pacito_sessions_email ON pacito_sessions(email);
    CREATE INDEX IF NOT EXISTS idx_pacito_contacts_owner ON pacito_contacts(owner_email);
    CREATE INDEX IF NOT EXISTS idx_pacito_shares_sender ON pacito_shares(sender_email, ended_at);
    CREATE INDEX IF NOT EXISTS idx_pacito_recipients_share ON pacito_share_recipients(share_id);
  `);
  console.log('[pacito] tables ready');

  // Anonymous viewers (opened the generic link from WhatsApp etc.). In-memory:
  // shareId -> Map(viewerId -> lastPingMs). Losing this on restart is harmless.
  const anonViewers = new Map();

  // ── Helpers ───────────────────────────────────────────────────────────────
  const now = () => Date.now();
  const norm = (e) => (e || '').toLowerCase().trim();
  const isEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e || '');
  const randToken = (bytes = 24) => crypto.randomBytes(bytes).toString('base64url');
  const clean = (s, max = 60) => String(s ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, max);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // scrypt with a per-user salt, plus the server-wide PASSWORD_SALT as a pepper.
  // (Stronger than the plain SHA-256 in spec v0.1; same env var, no new dependency.)
  function hashPassword(password, salt) {
    return crypto.scryptSync(password + PEPPER, salt, 64).toString('hex');
  }
  function checkPassword(password, user) {
    const a = Buffer.from(hashPassword(password, user.pw_salt), 'hex');
    const b = Buffer.from(user.pw_hash, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  function json(res, status, obj) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ...obj, serverNow: now() }));
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', d => {
        body += d;
        if (body.length > MAX_BODY) { reject(new HttpError(413, 'Request too large')); req.destroy(); }
      });
      req.on('end', () => {
        if (!body) return resolve({});
        try { resolve(JSON.parse(body)); } catch { reject(new HttpError(400, 'Invalid JSON')); }
      });
      req.on('error', reject);
    });
  }

  class HttpError extends Error {
    constructor(status, message) { super(message); this.status = status; }
  }

  // ── Auth ──────────────────────────────────────────────────────────────────
  const q = {
    userByEmail:   db.prepare('SELECT * FROM pacito_users WHERE email = ?'),
    insertUser:    db.prepare('INSERT INTO pacito_users (email, name, pw_hash, pw_salt, created_at, last_seen) VALUES (?, ?, ?, ?, ?, ?)'),
    setPassword:   db.prepare('UPDATE pacito_users SET pw_hash = ?, pw_salt = ? WHERE email = ?'),
    touchUser:     db.prepare('UPDATE pacito_users SET last_seen = ? WHERE email = ?'),
    insertSession: db.prepare('INSERT INTO pacito_sessions (token, email, expires_at) VALUES (?, ?, ?)'),
    session:       db.prepare('SELECT * FROM pacito_sessions WHERE token = ? AND expires_at > ?'),
    delSession:    db.prepare('DELETE FROM pacito_sessions WHERE token = ?'),
    delSessionsFor:db.prepare('DELETE FROM pacito_sessions WHERE email = ?'),
    insertReset:   db.prepare('INSERT INTO pacito_reset_tokens (token, email, expires_at) VALUES (?, ?, ?)'),
    reset:         db.prepare('SELECT * FROM pacito_reset_tokens WHERE token = ? AND used = 0 AND expires_at > ?'),
    useReset:      db.prepare('UPDATE pacito_reset_tokens SET used = 1 WHERE token = ?'),

    contacts:      db.prepare('SELECT id, email, nickname FROM pacito_contacts WHERE owner_email = ? ORDER BY COALESCE(nickname, email) COLLATE NOCASE'),
    upsertContact: db.prepare(`INSERT INTO pacito_contacts (owner_email, email, nickname, created_at) VALUES (?, ?, ?, ?)
                               ON CONFLICT(owner_email, email) DO UPDATE SET nickname = COALESCE(excluded.nickname, nickname)`),
    contactByEmail:db.prepare('SELECT id, email, nickname FROM pacito_contacts WHERE owner_email = ? AND email = ?'),
    delContact:    db.prepare('DELETE FROM pacito_contacts WHERE owner_email = ? AND id = ?'),

    insertShare:   db.prepare('INSERT INTO pacito_shares (token, sender_email, sender_name, started_at, expires_at, lat, lng, accuracy, loc_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'),
    shareByToken:  db.prepare('SELECT * FROM pacito_shares WHERE token = ?'),
    activeShareFor:db.prepare('SELECT * FROM pacito_shares WHERE sender_email = ? AND ended_at IS NULL AND expires_at > ? ORDER BY started_at DESC LIMIT 1'),
    endShare:      db.prepare('UPDATE pacito_shares SET ended_at = ?, lat = NULL, lng = NULL, accuracy = NULL WHERE id = ? AND ended_at IS NULL'),
    endOpenSharesFor: db.prepare('UPDATE pacito_shares SET ended_at = ?, lat = NULL, lng = NULL, accuracy = NULL WHERE sender_email = ? AND ended_at IS NULL'),
    expireShares:  db.prepare('UPDATE pacito_shares SET ended_at = expires_at, lat = NULL, lng = NULL, accuracy = NULL WHERE ended_at IS NULL AND expires_at <= ?'),
    setLocation:   db.prepare('UPDATE pacito_shares SET lat = ?, lng = ?, accuracy = ?, loc_at = ? WHERE id = ?'),
    extendShare:   db.prepare('UPDATE pacito_shares SET expires_at = ? WHERE id = ?'),

    insertRecipient: db.prepare('INSERT OR IGNORE INTO pacito_share_recipients (share_id, email, nickname, view_token) VALUES (?, ?, ?, ?)'),
    recipients:    db.prepare('SELECT * FROM pacito_share_recipients WHERE share_id = ? ORDER BY id'),
    recipientByView: db.prepare('SELECT * FROM pacito_share_recipients WHERE share_id = ? AND view_token = ?'),
    markEmailed:   db.prepare('UPDATE pacito_share_recipients SET emailed = 1 WHERE id = ?'),
    pingRecipient: db.prepare('UPDATE pacito_share_recipients SET opened_at = COALESCE(opened_at, ?), last_ping_at = ? WHERE id = ?'),

    lastRequest:   db.prepare('SELECT created_at FROM pacito_update_requests WHERE share_id = ? AND requester_email = ? ORDER BY created_at DESC LIMIT 1'),
    insertRequest: db.prepare('INSERT INTO pacito_update_requests (share_id, requester_email, requester_name, created_at) VALUES (?, ?, ?, ?)'),

    purgeSessions: db.prepare('DELETE FROM pacito_sessions WHERE expires_at < ?'),
    purgeResets:   db.prepare('DELETE FROM pacito_reset_tokens WHERE expires_at < ? OR used = 1'),
  };

  function newSession(email) {
    const token = randToken(32);
    q.insertSession.run(token, email, now() + SESSION_MS);
    return token;
  }

  function publicUser(u) { return { email: u.email, name: u.name }; }

  // Returns the signed-in user or null. Bearer token in Authorization header.
  function authUser(req) {
    const h = req.headers['authorization'] || '';
    const m = h.match(/^Bearer\s+(.+)$/i);
    if (!m) return null;
    const s = q.session.get(m[1].trim(), now());
    if (!s) return null;
    const u = q.userByEmail.get(s.email);
    if (u) q.touchUser.run(now(), u.email);
    return u || null;
  }
  function requireUser(req) {
    const u = authUser(req);
    if (!u) throw new HttpError(401, 'Please sign in again');
    return u;
  }

  // ── Email ─────────────────────────────────────────────────────────────────
  async function sendEmail(to, subject, html, logLine) {
    console.log(`[pacito:email] → ${to} | ${subject}${logLine ? ' | ' + logLine : ''}`);
    if (!resend) return false;
    try {
      const { data, error } = await resend.emails.send({ from: FROM, to, subject, html });
      if (error) { console.error(`[pacito:email] Resend rejected send to ${to}:`, error.name, '-', error.message); return false; }
      console.log(`[pacito:email] sent to ${to} (id: ${data?.id})`);
      return true;
    } catch (e) {
      console.error('[pacito:email] send threw:', e.message);
      return false;
    }
  }

  function emailShell(inner) {
    return `<div style="font-family:system-ui,-apple-system,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;color:#2a1a12">
      <div style="font-size:22px;font-weight:700;color:#e85d26;margin-bottom:24px">Pacito</div>
      ${inner}
      <p style="color:#9a8a80;font-size:12px;margin-top:32px">Pacito only shares a location while a share is running. When it ends, it's gone.</p>
    </div>`;
  }
  function button(href, label) {
    return `<a href="${href}" style="display:inline-block;background:#e85d26;color:#fff;font-weight:600;font-size:16px;padding:14px 28px;border-radius:999px;text-decoration:none">${label}</a>`;
  }
  const durationLabel = (ms) => {
    const m = Math.round(ms / 60000);
    return m >= 60 && m % 60 === 0 ? `${m / 60} hour${m === 60 ? '' : 's'}` : m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
  };

  function shareEmail(share, recipient) {
    const link = `${PAGE_URL}?share=${share.token}&r=${recipient.view_token}`;
    const name = esc(share.sender_name);
    const html = emailShell(`
      <p style="font-size:20px;font-weight:600;margin:0 0 8px">${name} is on the way 🧡</p>
      <p style="color:#6b5a50;margin:0 0 24px">Sharing live for the next ${durationLabel(share.expires_at - share.started_at)} — tap to watch. No app or account needed.</p>
      ${button(link, 'Watch live →')}`);
    return sendEmail(recipient.email, `${share.sender_name} is on the way`, html, link);
  }

  function requestEmail(share, requesterName) {
    const html = emailShell(`
      <p style="font-size:20px;font-weight:600;margin:0 0 8px">${esc(requesterName)} wants to know where you are</p>
      <p style="color:#6b5a50;margin:0 0 24px">Your last share has ended. Open Pacito if you'd like to share again — it's entirely up to you.</p>
      ${button(PAGE_URL, 'Open Pacito →')}`);
    return sendEmail(share.sender_email, `${requesterName} wants to know where you are`, html, PAGE_URL);
  }

  function resetEmail(email, token) {
    const link = `${PAGE_URL}?reset=${token}`;
    const html = emailShell(`
      <p style="font-size:20px;font-weight:600;margin:0 0 8px">Reset your password</p>
      <p style="color:#6b5a50;margin:0 0 24px">Tap below to choose a new password. This link works once and expires in 15 minutes.</p>
      ${button(link, 'Set a new password →')}
      <p style="color:#9a8a80;font-size:13px;margin-top:24px">Didn't ask for this? You can ignore it.</p>`);
    return sendEmail(email, 'Reset your Pacito password', html, link);
  }

  // ── Share views ───────────────────────────────────────────────────────────
  function isActive(share) { return !share.ended_at && share.expires_at > now(); }

  function endIfExpired(share) {
    if (!share.ended_at && share.expires_at <= now()) {
      q.endShare.run(share.expires_at, share.id);
      anonViewers.delete(share.id);
      return q.shareByToken.get(share.token);
    }
    return share;
  }

  function recipientStatus(r) {
    if (r.last_ping_at && now() - r.last_ping_at < WATCHING_MS) return 'watching';
    if (r.opened_at) return 'viewed';
    return 'sent';
  }

  function senderView(share) {
    const t = now();
    const anon = anonViewers.get(share.id);
    let anonWatching = 0;
    if (anon) for (const [, ts] of anon) if (t - ts < WATCHING_MS) anonWatching++;
    return {
      token: share.token,
      link: `${PAGE_URL}?share=${share.token}`,
      active: isActive(share),
      startedAt: share.started_at,
      expiresAt: share.expires_at,
      endedAt: share.ended_at,
      maxExpiresAt: share.started_at + MAX_SHARE_MS,
      location: share.lat != null ? { lat: share.lat, lng: share.lng, accuracy: share.accuracy, at: share.loc_at } : null,
      recipients: q.recipients.all(share.id).map(r => ({
        email: r.email, nickname: r.nickname, status: recipientStatus(r), emailed: !!r.emailed,
        openedAt: r.opened_at, lastPingAt: r.last_ping_at,
      })),
      linkViewersWatching: anonWatching,
    };
  }

  function loadOwnedShare(token, user) {
    let share = q.shareByToken.get(token);
    if (!share || share.sender_email !== user.email) throw new HttpError(404, 'Share not found');
    return endIfExpired(share);
  }

  // ── Router ────────────────────────────────────────────────────────────────
  async function route(req, res, url) {
    const p = url.pathname;
    const M = req.method;

    // ---- Auth ----
    if (p === '/pacito/auth/signup' && M === 'POST') {
      const { name, email, password } = await readBody(req);
      const e = norm(email), n = clean(name, 40);
      if (!n) throw new HttpError(400, 'Please add your name');
      if (!isEmail(e)) throw new HttpError(400, 'That email doesn’t look right');
      if (typeof password !== 'string' || password.length < 8) throw new HttpError(400, 'Password needs at least 8 characters');
      if (password.length > 200) throw new HttpError(400, 'Password is too long');
      if (q.userByEmail.get(e)) throw new HttpError(409, 'There’s already an account for that email — try signing in');
      const salt = randToken(16);
      q.insertUser.run(e, n, hashPassword(password, salt), salt, now(), now());
      console.log(`[pacito:auth] signup ${e}`);
      return json(res, 200, { token: newSession(e), user: { email: e, name: n } });
    }

    if (p === '/pacito/auth/signin' && M === 'POST') {
      const { email, password } = await readBody(req);
      const u = q.userByEmail.get(norm(email));
      if (!u || typeof password !== 'string' || !checkPassword(password, u)) {
        throw new HttpError(401, 'Email or password isn’t right');
      }
      q.touchUser.run(now(), u.email);
      return json(res, 200, { token: newSession(u.email), user: publicUser(u) });
    }

    if (p === '/pacito/auth/signout' && M === 'POST') {
      const m = (req.headers['authorization'] || '').match(/^Bearer\s+(.+)$/i);
      if (m) q.delSession.run(m[1].trim());
      return json(res, 200, { ok: true });
    }

    if (p === '/pacito/auth/forgot' && M === 'POST') {
      const { email } = await readBody(req);
      const u = q.userByEmail.get(norm(email));
      if (u) {
        const token = randToken(32);
        q.insertReset.run(token, u.email, now() + RESET_MS);
        await resetEmail(u.email, token);
      }
      // Same answer either way so this can't be used to probe for accounts.
      return json(res, 200, { ok: true });
    }

    if (p === '/pacito/auth/reset' && M === 'POST') {
      const { token, password } = await readBody(req);
      const row = q.reset.get(String(token || ''), now());
      if (!row) throw new HttpError(400, 'That reset link has expired or was already used');
      if (typeof password !== 'string' || password.length < 8) throw new HttpError(400, 'Password needs at least 8 characters');
      const salt = randToken(16);
      q.setPassword.run(hashPassword(password, salt), salt, row.email);
      q.useReset.run(row.token);
      q.delSessionsFor.run(row.email); // sign out everywhere else
      const u = q.userByEmail.get(row.email);
      return json(res, 200, { token: newSession(u.email), user: publicUser(u) });
    }

    if (p === '/pacito/me' && M === 'GET') {
      const u = requireUser(req);
      const active = q.activeShareFor.get(u.email, now());
      return json(res, 200, { user: publicUser(u), activeShare: active ? senderView(active) : null });
    }

    // ---- Contacts ----
    if (p === '/pacito/contacts' && M === 'GET') {
      const u = requireUser(req);
      return json(res, 200, { contacts: q.contacts.all(u.email) });
    }

    if (p === '/pacito/contacts' && M === 'POST') {
      const u = requireUser(req);
      const { email, nickname } = await readBody(req);
      const e = norm(email);
      if (!isEmail(e)) throw new HttpError(400, 'That email doesn’t look right');
      if (e === u.email) throw new HttpError(400, 'That’s your own email');
      q.upsertContact.run(u.email, e, clean(nickname, 40) || null, now());
      return json(res, 200, { contact: q.contactByEmail.get(u.email, e), contacts: q.contacts.all(u.email) });
    }

    if (p === '/pacito/contacts/delete' && M === 'POST') {
      const u = requireUser(req);
      const { id } = await readBody(req);
      q.delContact.run(u.email, Number(id));
      return json(res, 200, { contacts: q.contacts.all(u.email) });
    }

    // ---- Create share ----
    if (p === '/pacito/shares' && M === 'POST') {
      const u = requireUser(req);
      const { minutes, recipients, lat, lng, accuracy } = await readBody(req);
      if (!DURATIONS.includes(Number(minutes))) throw new HttpError(400, 'Pick 15 min, 30 min or 1 hour');
      if (!validCoord(lat, lng)) throw new HttpError(400, 'We couldn’t get your location');
      const list = Array.isArray(recipients) ? recipients : [];
      const seen = new Set();
      const rs = [];
      for (const r of list) {
        const e = norm(r?.email);
        if (!isEmail(e) || e === u.email || seen.has(e)) continue;
        seen.add(e);
        rs.push({ email: e, nickname: clean(r?.nickname, 40) || null });
      }
      if (rs.length > MAX_RECIPIENTS) throw new HttpError(400, `Up to ${MAX_RECIPIENTS} people per share`);
      // Recipients are optional: a link-only share (pasted into WhatsApp) is fine.

      const t = now();
      const token = randToken(18);
      const created = db.transaction(() => {
        q.endOpenSharesFor.run(t, u.email); // one live share at a time
        const info = q.insertShare.run(token, u.email, u.name, t, t + Number(minutes) * 60000,
          Number(lat), Number(lng), numOrNull(accuracy), t);
        for (const r of rs) {
          q.insertRecipient.run(info.lastInsertRowid, r.email, r.nickname, randToken(12));
          q.upsertContact.run(u.email, r.email, r.nickname, t); // remember for next time
        }
        return q.shareByToken.get(token);
      })();

      // Email in the background so the sender's screen isn't waiting on Resend.
      for (const r of q.recipients.all(created.id)) {
        shareEmail(created, r).then(ok => { if (ok) q.markEmailed.run(r.id); });
      }
      console.log(`[pacito:share] ${u.email} started ${minutes}m share ${token} → ${rs.length} recipient(s)`);
      return json(res, 200, { share: senderView(created) });
    }

    // ---- Share sub-routes ----
    const m = p.match(/^\/pacito\/shares\/([A-Za-z0-9_-]{8,64})(?:\/([a-z-]+))?$/);
    if (m) {
      const [, token, action] = m;

      // Public recipient view — also acts as the recipient's "ping".
      if (!action && M === 'GET') {
        let share = q.shareByToken.get(token);
        if (!share) throw new HttpError(404, 'This link doesn’t match a share');
        share = endIfExpired(share);
        const active = isActive(share);
        const r = url.searchParams.get('r');
        const viewer = url.searchParams.get('v');
        let recipient = null;
        if (r) {
          recipient = q.recipientByView.get(share.id, r);
          if (recipient && active) q.pingRecipient.run(now(), now(), recipient.id);
        } else if (viewer && active && /^[A-Za-z0-9_-]{6,40}$/.test(viewer)) {
          if (!anonViewers.has(share.id)) anonViewers.set(share.id, new Map());
          anonViewers.get(share.id).set(viewer, now());
        }
        return json(res, 200, {
          share: {
            senderName: share.sender_name,
            active,
            startedAt: share.started_at,
            expiresAt: share.expires_at,
            endedAt: share.ended_at,
            location: active && share.lat != null ? { lat: share.lat, lng: share.lng, accuracy: share.accuracy, at: share.loc_at } : null,
          },
          // Lets the expired screen pre-fill the email of a recipient we already know.
          recipient: recipient ? { email: recipient.email, nickname: recipient.nickname } : null,
        });
      }

      if (action === 'status' && M === 'GET') {
        const u = requireUser(req);
        return json(res, 200, { share: senderView(loadOwnedShare(token, u)) });
      }

      if (action === 'location' && M === 'POST') {
        const u = requireUser(req);
        const share = loadOwnedShare(token, u);
        if (!isActive(share)) return json(res, 410, { error: 'This share has ended', share: senderView(share) });
        const { lat, lng, accuracy } = await readBody(req);
        if (!validCoord(lat, lng)) throw new HttpError(400, 'Invalid location');
        q.setLocation.run(Number(lat), Number(lng), numOrNull(accuracy), now(), share.id);
        return json(res, 200, { share: senderView(q.shareByToken.get(token)) });
      }

      if (action === 'extend' && M === 'POST') {
        const u = requireUser(req);
        const share = loadOwnedShare(token, u);
        if (!isActive(share)) return json(res, 410, { error: 'This share has ended', share: senderView(share) });
        const { minutes } = await readBody(req);
        if (!DURATIONS.includes(Number(minutes))) throw new HttpError(400, 'Extend by 15 min, 30 min or 1 hour');
        const cap = share.started_at + MAX_SHARE_MS;
        const next = Math.min(share.expires_at + Number(minutes) * 60000, cap);
        if (next <= share.expires_at) throw new HttpError(400, 'Shares can run up to 4 hours in total');
        q.extendShare.run(next, share.id);
        return json(res, 200, { share: senderView(q.shareByToken.get(token)), capped: next === cap });
      }

      if (action === 'stop' && M === 'POST') {
        const u = requireUser(req);
        const share = loadOwnedShare(token, u);
        q.endShare.run(now(), share.id);
        anonViewers.delete(share.id);
        console.log(`[pacito:share] ${u.email} stopped ${token}`);
        return json(res, 200, { share: senderView(q.shareByToken.get(token)) });
      }

      if (action === 'request-update' && M === 'POST') {
        let share = q.shareByToken.get(token);
        if (!share) throw new HttpError(404, 'This link doesn’t match a share');
        share = endIfExpired(share);
        const body = await readBody(req);
        const signedIn = authUser(req);
        let email, name;
        if (signedIn) {
          email = signedIn.email; name = signedIn.name;
        } else {
          email = norm(body.email);
          if (!isEmail(email)) throw new HttpError(400, 'Add your email so they know who’s asking');
          const known = body.r ? q.recipientByView.get(share.id, String(body.r)) : null;
          name = clean(body.name, 40) || known?.nickname || email;
        }
        if (email === share.sender_email) throw new HttpError(400, 'That’s your own share');
        const last = q.lastRequest.get(share.id, email);
        if (last && now() - last.created_at < REQUEST_COOLDOWN) {
          return json(res, 200, { ok: true, alreadyAsked: true, signedIn: !!signedIn });
        }
        q.insertRequest.run(share.id, email, name, now());
        await requestEmail(share, name);
        console.log(`[pacito:request] ${email} asked ${share.sender_email} for an update`);
        return json(res, 200, { ok: true, signedIn: !!signedIn });
      }
    }

    throw new HttpError(404, 'Not found');
  }

  function validCoord(lat, lng) {
    const a = Number(lat), b = Number(lng);
    return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a) <= 90 && Math.abs(b) <= 180 && lat !== null && lng !== null;
  }
  function numOrNull(v) { const n = Number(v); return v == null || !Number.isFinite(n) ? null : n; }

  // ── Public entry point ────────────────────────────────────────────────────
  // Returns true if the request was a /pacito route (handled), false otherwise.
  async function handle(req, res, url) {
    if (!url.pathname.startsWith('/pacito/')) return false;
    try {
      await route(req, res, url);
    } catch (e) {
      if (res.headersSent) return true;
      if (e instanceof HttpError) json(res, e.status, { error: e.message });
      else { console.error('[pacito] error:', e); json(res, 500, { error: 'Something went wrong on our side' }); }
    }
    return true;
  }

  // ── Housekeeping: expire shares (and wipe their coordinates), purge tokens ──
  function sweep() {
    const t = now();
    const n = q.expireShares.run(t).changes;
    if (n) console.log(`[pacito:sweep] expired ${n} share(s), location wiped`);
    q.purgeSessions.run(t);
    q.purgeResets.run(t);
    for (const [shareId, viewers] of anonViewers) {
      for (const [v, ts] of viewers) if (t - ts > WATCHING_MS * 3) viewers.delete(v);
      if (!viewers.size) anonViewers.delete(shareId);
    }
  }
  setInterval(sweep, 30 * 1000).unref();
  sweep();

  return { handle };
}
