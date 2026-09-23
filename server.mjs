import { WebSocketServer } from 'ws';
import http from 'http';
import crypto from 'crypto';
import Database from 'better-sqlite3';
import { Resend } from 'resend';
import { createPacito } from './pacito.mjs';

const PORT = process.env.PORT || 3000;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = 'Orbyt <onboarding@resend.dev>';
const APP_URL = process.env.APP_URL || 'https://joybanerjee99.github.io/Orbyt';
const STALE_MS = 3 * 60 * 1000;
const PURGE_INTERVAL = 60 * 1000;
const TOKEN_EXPIRY_MS = 15 * 60 * 1000; // 15 minutes

// ── Database setup ─────────────────────────────────────────────────────────
const db = new Database('orbyt.db');
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    personal_email TEXT,
    name TEXT,
    phone TEXT,
    home_city TEXT,
    home_lat REAL,
    home_lng REAL,
    created_at TEXT DEFAULT (datetime('now')),
    last_seen TEXT
  );

  CREATE TABLE IF NOT EXISTS contacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_email TEXT NOT NULL,
    contact_email TEXT NOT NULL,
    contact_name TEXT,
    group_name TEXT DEFAULT 'Contacts',
    UNIQUE(user_email, contact_email)
  );

  CREATE TABLE IF NOT EXISTS groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_email TEXT NOT NULL,
    name TEXT NOT NULL,
    active INTEGER DEFAULT 1,
    UNIQUE(user_email, name)
  );

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    from_email TEXT NOT NULL,
    from_name TEXT,
    to_email TEXT NOT NULL,
    message TEXT NOT NULL,
    delivered INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    delivered_at TEXT
  );

  CREATE TABLE IF NOT EXISTS magic_tokens (
    token TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used INTEGER DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_messages_to ON messages(to_email, delivered);
  CREATE INDEX IF NOT EXISTS idx_contacts_user ON contacts(user_email);
  CREATE INDEX IF NOT EXISTS idx_magic_tokens_email ON magic_tokens(email);
`);

console.log('[db] SQLite database ready');

// ── Resend email client ────────────────────────────────────────────────────
const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;
if (!resend) console.warn('[email] RESEND_API_KEY not set — magic links will be logged only');

// ── Pacito (/pacito/... routes, pacito_* tables) ──────────────────────────
const pacito = createPacito({ db, resend, appUrl: APP_URL, fromEmail: 'Pacito <onboarding@resend.dev>' });

// ── Presence map (in-memory, session only) ────────────────────────────────
// email -> { lat, lng, homeLat, homeLng, name, phone, ws, ts }
const presence = new Map();

// ── Helpers ────────────────────────────────────────────────────────────────
function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function isAtHome(user) {
  if (user.homeLat == null || user.homeLng == null) return false;
  return haversine(user.lat, user.lng, user.homeLat, user.homeLng) < 20000;
}

function send(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function normalise(email) {
  return (email || '').toLowerCase().trim();
}

// ── DB helpers ─────────────────────────────────────────────────────────────
function getUser(email) {
  return db.prepare('SELECT * FROM users WHERE email = ?').get(email);
}

function upsertUser(data) {
  db.prepare(`
    INSERT INTO users (email, personal_email, name, phone, home_city, home_lat, home_lng, last_seen)
    VALUES (@email, @personal_email, @name, @phone, @home_city, @home_lat, @home_lng, datetime('now'))
    ON CONFLICT(email) DO UPDATE SET
      name = COALESCE(@name, name),
      phone = COALESCE(@phone, phone),
      personal_email = COALESCE(@personal_email, personal_email),
      last_seen = datetime('now')
  `).run(data);
}

function getUserContacts(email) {
  return db.prepare('SELECT contact_email FROM contacts WHERE user_email = ?')
    .all(email).map(r => r.contact_email);
}

function saveContacts(userEmail, contacts) {
  const insert = db.prepare(`
    INSERT INTO contacts (user_email, contact_email, contact_name, group_name)
    VALUES (@user_email, @contact_email, @contact_name, @group_name)
    ON CONFLICT(user_email, contact_email) DO UPDATE SET
      contact_name = COALESCE(@contact_name, contact_name),
      group_name = COALESCE(@group_name, group_name)
  `);
  const tx = db.transaction((rows) => rows.forEach(r => insert.run(r)));
  tx(contacts.map(c => ({
    user_email: userEmail,
    contact_email: normalise(c.email),
    contact_name: c.name || null,
    group_name: c.group || 'Contacts',
  })));
}

function saveGroups(userEmail, groups) {
  const insert = db.prepare(`
    INSERT INTO groups (user_email, name, active)
    VALUES (@user_email, @name, @active)
    ON CONFLICT(user_email, name) DO UPDATE SET active = @active
  `);
  const tx = db.transaction((rows) => rows.forEach(r => insert.run(r)));
  tx(groups.map(g => ({ user_email: userEmail, name: g.name, active: g.active ? 1 : 0 })));
}

function getUserData(email) {
  const user = getUser(email);
  if (!user) return null;
  const contacts = db.prepare('SELECT * FROM contacts WHERE user_email = ?').all(email);
  const groups = db.prepare('SELECT * FROM groups WHERE user_email = ?').all(email);
  return { user, contacts, groups };
}

// ── Queued messages ────────────────────────────────────────────────────────
function storeMessage(id, from, fromName, to, message) {
  db.prepare(`
    INSERT OR IGNORE INTO messages (id, from_email, from_name, to_email, message)
    VALUES (?, ?, ?, ?, ?)
  `).run(id || crypto.randomUUID(), from, fromName, to, message);
}

function getUndeliveredMessages(email) {
  return db.prepare(`
    SELECT * FROM messages WHERE to_email = ? AND delivered = 0 ORDER BY created_at ASC
  `).all(email);
}

function markDelivered(id) {
  db.prepare(`
    UPDATE messages SET delivered = 1, delivered_at = datetime('now') WHERE id = ?
  `).run(id);
}

// ── Proximity ──────────────────────────────────────────────────────────────
function findNearby(email, radiusM) {
  const me = presence.get(email);
  if (!me) return [];
  const dbContacts = getUserContacts(email);
  const nearby = [];

  for (const [otherEmail, other] of presence) {
    if (otherEmail === email) continue;
    if (Date.now() - other.ts > STALE_MS) continue;
    const mutual = dbContacts.includes(otherEmail) && getUserContacts(otherEmail).includes(email);
    if (!mutual) continue;
    const dist = haversine(me.lat, me.lng, other.lat, other.lng);
    if (dist > radiusM) continue;
    if (isAtHome(me) && isAtHome(other)) continue;
    nearby.push({ email: otherEmail, name: other.name || otherEmail, distM: Math.round(dist) });
  }
  return nearby;
}

// ── Magic link auth ────────────────────────────────────────────────────────
async function sendMagicLink(email) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + TOKEN_EXPIRY_MS).toISOString();
  db.prepare('INSERT OR REPLACE INTO magic_tokens (token, email, expires_at, used) VALUES (?, ?, ?, 0)')
    .run(token, email, expiresAt);

  const link = `${APP_URL}?token=${token}&email=${encodeURIComponent(email)}`;
  console.log(`[auth] Magic link for ${email}: ${link}`);

  if (resend) {
    try {
      const { data, error } = await resend.emails.send({
        from: FROM_EMAIL,
        to: email,
        subject: 'Your Orbyt login link',
        html: `
          <div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;padding:32px">
            <h1 style="font-size:24px;font-weight:600;color:#1a1830;margin-bottom:8px">
              Orb<span style="color:#2563eb">yt</span>
            </h1>
            <p style="color:#5a5680;margin-bottom:24px">Know who's in your orbit.</p>
            <p style="color:#1a1830;margin-bottom:24px">
              Tap the button below to sign in to Orbyt. This link expires in 15 minutes.
            </p>
            <a href="${link}" style="display:inline-block;background:#2563eb;color:#fff;
              font-weight:600;font-size:15px;padding:13px 28px;border-radius:8px;
              text-decoration:none">Sign in to Orbyt →</a>
            <p style="color:#8884aa;font-size:12px;margin-top:24px">
              If you didn't request this, you can safely ignore this email.
            </p>
          </div>
        `,
      });
      // The Resend SDK resolves even on API-level rejections (bad key, unverified
      // domain, sandbox restrictions) — it does not throw for those. Both branches
      // must be checked, or a rejected send silently logs as a success.
      if (error) {
        console.error(`[email] Resend rejected the send to ${email}:`, error.name, '-', error.message);
      } else {
        console.log(`[email] Magic link sent to ${email} (id: ${data?.id})`);
      }
    } catch (e) {
      console.error('[email] Send threw:', e.message);
    }
  }
  return token;
}

function verifyMagicToken(token, email) {
  const row = db.prepare('SELECT * FROM magic_tokens WHERE token = ? AND email = ? AND used = 0').get(token, email);
  if (!row) return false;
  if (new Date(row.expires_at) < new Date()) return false;
  db.prepare('UPDATE magic_tokens SET used = 1 WHERE token = ?').run(token);
  return true;
}

// ── Geocoding ──────────────────────────────────────────────────────────────
async function geocodeCityForUser(email, city, ws) {
  try {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(city)}&format=json&limit=1`;
    const r = await fetch(url, { headers: { 'Accept-Language': 'en', 'User-Agent': 'Orbyt/1.0' } });
    const data = await r.json();
    if (data && data[0]) {
      const lat = parseFloat(data[0].lat);
      const lng = parseFloat(data[0].lon);
      const p = presence.get(email);
      if (p) { p.homeLat = lat; p.homeLng = lng; }
      db.prepare('UPDATE users SET home_lat = ?, home_lng = ? WHERE email = ?').run(lat, lng, email);
      send(ws, { type: 'geocode_result', lat, lng, city });
      console.log(`[geocode] ${email}: ${city} → ${lat}, ${lng}`);
    }
  } catch (e) {
    console.warn(`[geocode] Failed for ${city}:`, e.message);
  }
}

// ── HTTP server ────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, `http://localhost`);

  // Pacito routes
  if (await pacito.handle(req, res, url)) return;

  // Health check
  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', users: presence.size }));
    return;
  }

  // ── POST /auth/request — send magic link ──────────────────────────────
  if (url.pathname === '/auth/request' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      try {
        const { email } = JSON.parse(body);
        if (!email || !email.includes('@')) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Valid email required' }));
          return;
        }
        const normEmail = normalise(email);
        await sendMagicLink(normEmail);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // ── GET /auth/verify?token=&email= — verify magic link ────────────────
  if (url.pathname === '/auth/verify') {
    const token = url.searchParams.get('token');
    const email = normalise(url.searchParams.get('email') || '');
    const valid = verifyMagicToken(token, email);
    if (!valid) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid or expired link' }));
      return;
    }
    // Ensure user record exists
    upsertUser({ email, personal_email: null, name: null, phone: null, home_city: null, home_lat: null, home_lng: null });
    // Return user data
    const data = getUserData(email);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, email, data }));
    return;
  }

  // ── POST /user/save — save user profile + contacts + groups ───────────
  if (url.pathname === '/user/save' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { email, name, phone, personalEmail, homeCity, contacts, groups } = JSON.parse(body);
        const normEmail = normalise(email);
        upsertUser({ email: normEmail, personal_email: normalise(personalEmail), name, phone, home_city: homeCity, home_lat: null, home_lng: null });
        if (contacts?.length) saveContacts(normEmail, contacts);
        if (groups?.length) saveGroups(normEmail, groups);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // ── GET /user/load?email= — load user data ────────────────────────────
  if (url.pathname === '/user/load') {
    const email = normalise(url.searchParams.get('email') || '');
    const data = getUserData(email);
    if (!data) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'User not found' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
    return;
  }

  // ── Geocode ───────────────────────────────────────────────────────────
  if (url.pathname === '/geocode') {
    const city = url.searchParams.get('city');
    if (!city) { res.writeHead(400); res.end(); return; }
    try {
      const r = await fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(city)}&format=json&limit=1`, { headers: { 'Accept-Language': 'en', 'User-Agent': 'Orbyt/1.0' } });
      const data = await r.json();
      if (data && data[0]) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) }));
      } else {
        res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' }));
      }
    } catch (e) {
      res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  res.writeHead(404); res.end();
});

// ── WebSocket ──────────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  let clientEmail = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // ── ping ─────────────────────────────────────────────────────────────
    if (msg.type === 'ping') {
      const { email: rawEmail, name, phone, lat, lng, contacts, radiusM, homeLat, homeLng, homeCity } = msg;
      if (!rawEmail || lat == null || lng == null) return;
      const email = normalise(rawEmail);
      clientEmail = email;

      const existing = presence.get(email);
      const resolvedHomeLat = homeLat ?? existing?.homeLat ?? null;
      const resolvedHomeLng = homeLng ?? existing?.homeLng ?? null;

      presence.set(email, { lat, lng, name: name || email, phone: phone || null, homeLat: resolvedHomeLat, homeLng: resolvedHomeLng, ts: Date.now(), ws });

      // Update last_seen in DB
      db.prepare("UPDATE users SET last_seen = datetime('now') WHERE email = ?").run(email);

      // Geocode home city if needed
      if (homeCity && resolvedHomeLat == null) geocodeCityForUser(email, homeCity, ws);

      // Deliver any queued messages
      const queued = getUndeliveredMessages(email);
      queued.forEach(m => {
        send(ws, { type: 'incoming_nudge', from: m.from_email, fromName: m.from_name, message: m.message, msgId: m.id, queued: true });
        markDelivered(m.id);
      });
      if (queued.length) console.log(`[queue] Delivered ${queued.length} queued message(s) to ${email}`);

      const nearby = findNearby(email, radiusM || 20000);
      send(ws, { type: 'nearby', nearby });
      console.log(`[ping] ${email} → ${nearby.length} nearby, ${queued.length} queued msgs delivered`);
    }

    // ── geocode_request ───────────────────────────────────────────────────
    if (msg.type === 'geocode_request') {
      const email = normalise(msg.email);
      if (msg.city && email) geocodeCityForUser(email, msg.city, ws);
    }

    // ── nudge (message) ───────────────────────────────────────────────────
    if (msg.type === 'nudge') {
      const from = normalise(msg.from);
      const to   = normalise(msg.to);
      if (!from || !to) return;

      const sender   = presence.get(from);
      const receiver = presence.get(to);
      const msgId    = msg.msgId || crypto.randomUUID();

      // Verify mutual contact via DB
      const fromContacts = getUserContacts(from);
      const toContacts   = getUserContacts(to);
      const mutual = fromContacts.includes(to) && toContacts.includes(from);

      if (!mutual) {
        send(ws, { type: 'nudge_result', success: false, reason: 'Not a mutual contact', msgId });
        return;
      }

      // Always store message in DB for reliability
      storeMessage(msgId, from, msg.fromName || sender?.name || from, to, msg.message || '');

      // Deliver immediately if recipient is online
      if (receiver) {
        send(receiver.ws, { type: 'incoming_nudge', from, fromName: msg.fromName || sender?.name || from, message: msg.message, msgId });
        markDelivered(msgId);
        send(ws, { type: 'nudge_result', success: true, to, msgId, delivered: true });
        console.log(`[message] ${from} → ${to} (delivered immediately)`);
      } else {
        // Recipient offline — message stored, will deliver on next connect
        send(ws, { type: 'nudge_result', success: true, to, msgId, delivered: false, queued: true });
        console.log(`[message] ${from} → ${to} (queued — recipient offline)`);
      }
    }

    // ── bye ───────────────────────────────────────────────────────────────
    if (msg.type === 'bye') {
      if (clientEmail) presence.delete(clientEmail);
    }
  });

  ws.on('close', () => {
    if (clientEmail) { console.log(`[disconnect] ${clientEmail}`); presence.delete(clientEmail); }
  });
  ws.on('error', () => { if (clientEmail) presence.delete(clientEmail); });
});

// ── Cleanup ────────────────────────────────────────────────────────────────
setInterval(() => {
  const cutoff = Date.now() - STALE_MS;
  for (const [email, p] of presence) {
    if (p.ts < cutoff) { console.log(`[purge] ${email}`); presence.delete(email); }
  }
  // Clean up expired tokens
  db.prepare("DELETE FROM magic_tokens WHERE expires_at < datetime('now') OR used = 1").run();
}, PURGE_INTERVAL);

server.listen(PORT, () => console.log(`Orbyt relay running on port ${PORT}`));
