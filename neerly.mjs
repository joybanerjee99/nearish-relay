// ─────────────────────────────────────────────────────────────────────────────
// Neerly — "I'm on my way."
// Time-boxed, sender-initiated live location sharing.
// v0.6: two share modes — 'way' (On my way: live trail) and 'now' (Right now: a status,
// optionally with a pin, never a trail) — plus a weather look for the buddy.
// v0.7a: the Watching map (every live share sent to you, in one place) and email confirmation,
// which the Watching map needs: shares are matched to accounts by email address.
// v0.7b: push notifications (Web Push), reactions from watchers, quick starts (presets),
// and adding friends by @username (their email address stays private).
//
// Mounted on the existing nearish-relay HTTP server. Every route lives under
// /neerly/... and every table is prefixed neerly_ so nothing collides with
// Orbyt. See server.mjs for the two-line hook.
//
// Privacy rule (Strategy §1.3 #5): location exists only inside an active share.
// When a share stops or expires, its coordinates are wiped from the database.
// ─────────────────────────────────────────────────────────────────────────────
import crypto from 'crypto';
import fs from 'fs';
import webpush from 'web-push';

const SESSION_MS       = 30 * 24 * 60 * 60 * 1000; // 30 days
const RESET_MS          = 15 * 60 * 1000;            // 15 minutes
const WATCHING_MS       = 40 * 1000;                 // "watching" = pinged recently (recipients poll every 17s)
const DURATIONS         = [15, 30, 60];              // minutes, for new shares and extensions
const MAX_SHARE_MS      = 4 * 60 * 60 * 1000;        // free cap: 4h total incl. extensions
const MAX_RECIPIENTS    = 20;
const REQUEST_COOLDOWN  = 10 * 60 * 1000;            // one "request an update" per person per share per 10 min
const MAX_BODY          = 32 * 1024;
const REQUEST_ANSWER_MS = 24 * 60 * 60 * 1000;       // a share within 24h of a request counts as answering it
const WEEK_MS           = 7 * 24 * 60 * 60 * 1000;
// Buddy avatars (the drawings live in neerly.html; the server only checks the id).
const AVATARS = ['cat','pup','bunny','fox','bear','panda','owl','frog','dragon','unicorn','ghost','robot','suitm','suitf','wolf','lion'];
const RESERVED_USERNAMES = new Set(['neerly','admin','administrator','support','help','root','me','api','system','official','staff','team','moderator','null','undefined']);
// Trail: skip fuzzy fixes and GPS jumps so the line and the mileage stay honest.
const TRAIL_MAX_ACCURACY = 60;    // m — fixes fuzzier than this still move the dot, but don't draw trail or add distance
const TRAIL_MIN_STEP     = 12;    // m — ignore jitter smaller than this (or the fix's accuracy, up to 40 m)
const TRAIL_MAX_SPEED    = 90;    // m/s (~320 km/h) — anything faster is a GPS glitch
const TRAIL_MAX_POINTS   = 3000;
// v0.5 — badges and the rewards they unlock. Rewards only dress up your own buddy; they never change what's shared.
// kind: 'head' | 'face' | 'neck' (buddy outfit slots), 'trail' (trail style), 'icon' (alternate app icon)
const BADGES = [
  { id: 'first_steps',    test: s => s.shares >= 1,              reward: { kind: 'trail', id: 'footprints' } },
  { id: 'out_and_about',  test: s => s.shares >= 10,             reward: { kind: 'head',  id: 'beanie' } },
  { id: 'trailblazer',    test: s => s.distanceM >= 10000,       reward: { kind: 'trail', id: 'paws' } },
  { id: 'marathon',       test: s => s.distanceM >= 42195,       reward: { kind: 'face',  id: 'sunglasses' } },
  { id: 'coast_to_coast', test: s => s.distanceM >= 4500000,     reward: { kind: 'head',  id: 'wizard' } },
  { id: 'on_call',        test: s => s.requestsAnswered >= 5,    reward: { kind: 'neck',  id: 'bowtie' } },
  { id: 'popular',        test: s => s.timesWatched >= 25,       reward: { kind: 'head',  id: 'crown' } },
  { id: 'my_people',      test: s => s.people >= 5,              reward: { kind: 'neck',  id: 'scarf' } },
  { id: 'regular',        test: s => s.bestStreak >= 4,          reward: { kind: 'trail', id: 'sparkles' } },
  { id: 'night_owl',      test: s => s.nightShares >= 1,         reward: { kind: 'icon',  id: 'night' } },
  { id: 'early_bird',     test: s => s.earlyShares >= 1,         reward: { kind: 'head',  id: 'flowers' } },
  { id: 'mutual',         test: s => s.shareBacks >= 5,          reward: { kind: 'head',  id: 'partyhat' } },
  { id: 'connector',      test: s => s.friendsJoined >= 3,       reward: { kind: 'trail', id: 'rainbow' } },
];
const OUTFIT_SLOTS = ['head', 'face', 'neck'];
const DEFAULT_TRAIL = 'dots';
const SHARE_BACK_WINDOW = 24 * 60 * 60 * 1000;   // you can share back up to a day after their share
const SHARE_BACK_COOLDOWN = 10 * 60 * 1000;      // and not more than once per 10 minutes per share
// v0.7a — email confirmation (the Watching map lists shares sent to your address, so it has to be yours)
const VERIFY_MS          = 24 * 60 * 60 * 1000;  // a confirmation link works for a day
const VERIFY_COOLDOWN    = 2 * 60 * 1000;        // one confirmation email per 2 minutes
// v0.6 — share modes. 'way' = On my way (live trail). 'now' = Right now (status text, location optional, no trail).
const MODES = ['way', 'now'];
const NOW_DURATIONS = [30, 60, 120, 240];        // Right now statuses tend to last longer
const NOTE_MAX = 60;                             // "Heading to…" / status text
// v0.6 — weather for the buddy's look. Coordinates are rounded (~1 km) before asking; the result lives
// on the share row and is wiped with the location when the share ends.
const WEATHER_TTL = 15 * 60 * 1000;
const WEATHER_API = process.env.WEATHER_API || 'https://api.open-meteo.com/v1/forecast';
// v0.7b — reactions from watchers, push notifications, quick starts
const REACTIONS          = ['❤️', '👋', '👍', '😂'];
const REACT_GAP_MS       = 1500;                 // one reaction per viewer every 1.5 s
const REACT_MAX          = 60;                   // and at most 60 per viewer per share
const PUSH_REACT_GAP_MS  = 20 * 1000;            // reactions buzz the sender at most every 20 s per share
const MAX_PUSH_SUBS      = 10;                   // devices per account
const MAX_PRESETS        = 8;
const PRESET_NAME_MAX    = 30;

export function createNeerly({ db, resend, appUrl, fromEmail }) {
  // NEERLY_URL is where emailed links point: the page itself (…/neerly.html) or, from v0.7a, the
  // site root (https://neerly.net/). Without it, links fall back to APP_URL + /neerly.html.
  const PAGE_URL = process.env.NEERLY_URL || `${appUrl.replace(/\/$/, '')}/neerly.html`;
  // v0.6: Right now shares link to neerly-now.html, a tiny page with its own link preview
  // ("What I'm up to") that forwards straight to the app with the same query string.
  const NOW_PAGE_URL = /\/$/.test(PAGE_URL) ? PAGE_URL + 'neerly-now.html' : PAGE_URL.replace(/neerly\.html$/, 'neerly-now.html');
  const shareBase = (share) => (share.mode === 'now' && NOW_PAGE_URL !== PAGE_URL ? NOW_PAGE_URL : PAGE_URL);
  const FROM = process.env.NEERLY_FROM_EMAIL || fromEmail || 'Neerly <onboarding@resend.dev>';
  const PEPPER = process.env.PASSWORD_SALT || '';
  if (!PEPPER) console.warn('[neerly] PASSWORD_SALT not set — add it in Render before real users sign up');

  // ── Schema ────────────────────────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS neerly_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      pw_hash TEXT NOT NULL,
      pw_salt TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_seen INTEGER
    );
    CREATE TABLE IF NOT EXISTS neerly_sessions (
      token TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS neerly_reset_tokens (
      token TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      used INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS neerly_contacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_email TEXT NOT NULL,
      email TEXT NOT NULL,
      nickname TEXT,
      created_at INTEGER NOT NULL,
      UNIQUE(owner_email, email)
    );
    CREATE TABLE IF NOT EXISTS neerly_shares (
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
    CREATE TABLE IF NOT EXISTS neerly_share_recipients (
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
    CREATE TABLE IF NOT EXISTS neerly_update_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      share_id INTEGER NOT NULL,
      requester_email TEXT NOT NULL,
      requester_name TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_neerly_sessions_email ON neerly_sessions(email);
    CREATE INDEX IF NOT EXISTS idx_neerly_contacts_owner ON neerly_contacts(owner_email);
    CREATE INDEX IF NOT EXISTS idx_neerly_shares_sender ON neerly_shares(sender_email, ended_at);
    CREATE INDEX IF NOT EXISTS idx_neerly_recipients_share ON neerly_share_recipients(share_id);
    -- v0.4: trail points exist only while a share is live (deleted when it ends)
    CREATE TABLE IF NOT EXISTS neerly_share_points (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      share_id INTEGER NOT NULL,
      lat REAL NOT NULL, lng REAL NOT NULL,
      at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_neerly_points_share ON neerly_share_points(share_id, id);
    -- v0.4: lifetime totals per user. Numbers only, never coordinates.
    CREATE TABLE IF NOT EXISTS neerly_stats (
      email TEXT PRIMARY KEY,
      shares_sent INTEGER NOT NULL DEFAULT 0,
      minutes_shared REAL NOT NULL DEFAULT 0,
      distance_m REAL NOT NULL DEFAULT 0,
      times_watched INTEGER NOT NULL DEFAULT 0,
      requests_answered INTEGER NOT NULL DEFAULT 0,
      streak_weeks INTEGER NOT NULL DEFAULT 0,
      best_streak INTEGER NOT NULL DEFAULT 0,
      last_week INTEGER
    );
    -- v0.5
    CREATE TABLE IF NOT EXISTS neerly_badges (
      email TEXT NOT NULL,
      badge TEXT NOT NULL,
      earned_at INTEGER NOT NULL,
      seen_at INTEGER,
      PRIMARY KEY (email, badge)
    );
    CREATE TABLE IF NOT EXISTS neerly_share_backs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      original_share_id INTEGER NOT NULL,
      from_email TEXT NOT NULL,
      new_share_id INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_neerly_sharebacks ON neerly_share_backs(original_share_id, from_email);
    -- v0.7a: email confirmation links
    CREATE TABLE IF NOT EXISTS neerly_verify_tokens (
      token TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_neerly_recipients_email ON neerly_share_recipients(email);
    -- v0.7b: one row per device that turned on notifications
    CREATE TABLE IF NOT EXISTS neerly_push_subs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL,
      endpoint TEXT UNIQUE NOT NULL,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_ok_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_neerly_push_email ON neerly_push_subs(email);
    -- v0.7b: reactions live only while a share runs (the counts stay on the share for the summary)
    CREATE TABLE IF NOT EXISTS neerly_reactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      share_id INTEGER NOT NULL,
      emoji TEXT NOT NULL,
      from_name TEXT,
      at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_neerly_reactions_share ON neerly_reactions(share_id, id);
    -- v0.7b: quick starts, built by the user. people = the recipients list as the page sends it.
    CREATE TABLE IF NOT EXISTS neerly_presets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pid TEXT UNIQUE NOT NULL,
      email TEXT NOT NULL,
      name TEXT NOT NULL,
      mode TEXT NOT NULL,
      minutes INTEGER NOT NULL,
      note TEXT,
      show_loc INTEGER NOT NULL DEFAULT 1,
      people TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_neerly_presets_email ON neerly_presets(email);
    -- v0.7b: small server settings (the push keys)
    CREATE TABLE IF NOT EXISTS neerly_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  // v0.4 columns on existing tables (added in place; existing data is kept)
  const addCol = (table, col, def) => {
    if (!db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
  };
  addCol('neerly_users', 'username', 'TEXT');
  addCol('neerly_users', 'avatar', 'TEXT');
  addCol('neerly_shares', 'distance_m', 'REAL NOT NULL DEFAULT 0');
  addCol('neerly_shares', 'link_views', 'INTEGER NOT NULL DEFAULT 0');
  addCol('neerly_update_requests', 'answered_at', 'INTEGER');
  addCol('neerly_users', 'outfit', 'TEXT');          // v0.5: JSON {head, face, neck}
  addCol('neerly_users', 'trail_style', 'TEXT');     // v0.5
  addCol('neerly_users', 'app_icon', 'TEXT');        // v0.5: 'classic' | 'night'
  addCol('neerly_users', 'referred_by', 'TEXT');     // v0.5: sender whose link brought them in
  addCol('neerly_stats', 'share_backs', 'INTEGER NOT NULL DEFAULT 0');
  addCol('neerly_stats', 'night_shares', 'INTEGER NOT NULL DEFAULT 0');
  addCol('neerly_stats', 'early_shares', 'INTEGER NOT NULL DEFAULT 0');
  addCol('neerly_share_recipients', 'hidden', 'INTEGER NOT NULL DEFAULT 0'); // share-back: the address stays private
  addCol('neerly_shares', 'mode', "TEXT NOT NULL DEFAULT 'way'");   // v0.6: 'way' | 'now'
  addCol('neerly_shares', 'note', 'TEXT');                           // v0.6: "Heading to…" or the status
  addCol('neerly_shares', 'show_loc', 'INTEGER NOT NULL DEFAULT 1');  // v0.6: Right now can hide the location
  addCol('neerly_shares', 'weather', 'TEXT');                        // v0.6: JSON, wiped with the location
  addCol('neerly_shares', 'weather_at', 'INTEGER');
  addCol('neerly_users', 'email_verified_at', 'INTEGER');            // v0.7a: set by a confirmation link or a password reset
  addCol('neerly_contacts', 'email_known', 'INTEGER NOT NULL DEFAULT 1'); // v0.7b: 0 = added by @username, address stays private
  addCol('neerly_share_recipients', 'handle', 'TEXT');               // v0.7b: picked by @username: show that, not the address
  addCol('neerly_shares', 'reactions', 'TEXT');                      // v0.7b: JSON counts, e.g. {"❤️":3}
  addCol('neerly_reactions', 'recipient_id', 'INTEGER');            // v0.7b.1: which invited watcher reacted (null: a link viewer)
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_neerly_users_username ON neerly_users(username)');
  console.log('[neerly] tables ready');

  // ── v0.7b Push keys ─────────────────────────────────────────────────────────
  // VAPID keys identify this server to the push services. They're made once and kept in the database,
  // so there's nothing to set up on Render. VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY env vars override them.
  const metaGet = (k) => db.prepare('SELECT value FROM neerly_meta WHERE key = ?').get(k)?.value;
  const metaSet = (k, v) => db.prepare('INSERT INTO neerly_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, v);
  let VAPID = process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY
    ? { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY } : null;
  if (!VAPID) {
    const saved = metaGet('vapid');
    if (saved) { try { VAPID = JSON.parse(saved); } catch {} }
    if (!VAPID) { VAPID = webpush.generateVAPIDKeys(); metaSet('vapid', JSON.stringify(VAPID)); console.log('[neerly:push] made new push keys'); }
  }
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:hello@neerly.net', VAPID.publicKey, VAPID.privateKey);
  const PUSH_LOG = process.env.NEERLY_PUSH_LOG || ''; // tests: every push is also written here, one JSON line each

  // Anonymous viewers (opened the generic link from WhatsApp etc.). In-memory:
  // shareId -> Map(viewerId -> lastPingMs). Losing this on restart is harmless.
  const anonViewers = new Map();
  // shareId -> Set(viewerId) of every link viewer seen during the share (for "times watched").
  const anonSeen = new Map();
  // v0.7b: shareId -> Map(viewerKey -> { last, n }) so one watcher can't flood the sender with reactions.
  const reactLimits = new Map();
  // v0.7b: shareId -> when the sender was last buzzed about a reaction.
  const reactPushedAt = new Map();

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
    userByEmail:   db.prepare('SELECT * FROM neerly_users WHERE email = ?'),
    insertUser:    db.prepare('INSERT INTO neerly_users (email, name, pw_hash, pw_salt, created_at, last_seen, username, avatar, referred_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'),
    setLook:       db.prepare('UPDATE neerly_users SET outfit = ?, trail_style = ?, app_icon = ? WHERE email = ?'),
    friendsJoined: db.prepare('SELECT COUNT(*) n FROM neerly_users WHERE referred_by = ?'),
    badges:        db.prepare('SELECT badge, earned_at, seen_at FROM neerly_badges WHERE email = ? ORDER BY earned_at, rowid'),
    insertBadge:   db.prepare('INSERT OR IGNORE INTO neerly_badges (email, badge, earned_at) VALUES (?, ?, ?)'),
    seeBadges:     db.prepare('UPDATE neerly_badges SET seen_at = ? WHERE email = ? AND seen_at IS NULL'),
    statsNight:    db.prepare('UPDATE neerly_stats SET night_shares = night_shares + 1 WHERE email = ?'),
    statsEarly:    db.prepare('UPDATE neerly_stats SET early_shares = early_shares + 1 WHERE email = ?'),
    statsShareBack:db.prepare('UPDATE neerly_stats SET share_backs = share_backs + 1 WHERE email = ?'),
    lastShareBack: db.prepare('SELECT created_at FROM neerly_share_backs WHERE original_share_id = ? AND from_email = ? ORDER BY created_at DESC LIMIT 1'),
    insertShareBack: db.prepare('INSERT INTO neerly_share_backs (original_share_id, from_email, new_share_id, created_at) VALUES (?, ?, ?, ?)'),
    userByUsername:db.prepare('SELECT email FROM neerly_users WHERE username = ?'),
    usersNoUsername: db.prepare('SELECT email FROM neerly_users WHERE username IS NULL'),
    setUsername:   db.prepare('UPDATE neerly_users SET username = ? WHERE email = ?'),
    setProfile:    db.prepare('UPDATE neerly_users SET name = ?, username = ?, avatar = ? WHERE email = ?'),
    delOtherSessions: db.prepare('DELETE FROM neerly_sessions WHERE email = ? AND token != ?'),
    setPassword:   db.prepare('UPDATE neerly_users SET pw_hash = ?, pw_salt = ? WHERE email = ?'),
    touchUser:     db.prepare('UPDATE neerly_users SET last_seen = ? WHERE email = ?'),
    insertSession: db.prepare('INSERT INTO neerly_sessions (token, email, expires_at) VALUES (?, ?, ?)'),
    session:       db.prepare('SELECT * FROM neerly_sessions WHERE token = ? AND expires_at > ?'),
    delSession:    db.prepare('DELETE FROM neerly_sessions WHERE token = ?'),
    delSessionsFor:db.prepare('DELETE FROM neerly_sessions WHERE email = ?'),
    insertReset:   db.prepare('INSERT INTO neerly_reset_tokens (token, email, expires_at) VALUES (?, ?, ?)'),
    reset:         db.prepare('SELECT * FROM neerly_reset_tokens WHERE token = ? AND used = 0 AND expires_at > ?'),
    useReset:      db.prepare('UPDATE neerly_reset_tokens SET used = 1 WHERE token = ?'),

    // v0.7b: a contact added by @username keeps their address private (email_known = 0); its handle is read live,
    // so a renamed friend shows their new @username.
    contacts:      db.prepare(`SELECT c.id, c.email, c.nickname, c.email_known, u.username AS uname
                               FROM neerly_contacts c LEFT JOIN neerly_users u ON u.email = c.email
                               WHERE c.owner_email = ? ORDER BY COALESCE(c.nickname, CASE WHEN c.email_known THEN c.email ELSE u.username END) COLLATE NOCASE`),
    upsertContact: db.prepare(`INSERT INTO neerly_contacts (owner_email, email, nickname, created_at, email_known) VALUES (?, ?, ?, ?, ?)
                               ON CONFLICT(owner_email, email) DO UPDATE SET nickname = COALESCE(excluded.nickname, nickname), email_known = MAX(email_known, excluded.email_known)`),
    contactByEmail:db.prepare(`SELECT c.id, c.email, c.nickname, c.email_known, u.username AS uname
                               FROM neerly_contacts c LEFT JOIN neerly_users u ON u.email = c.email WHERE c.owner_email = ? AND c.email = ?`),
    contactById:   db.prepare(`SELECT c.id, c.email, c.nickname, c.email_known, u.username AS uname
                               FROM neerly_contacts c LEFT JOIN neerly_users u ON u.email = c.email WHERE c.owner_email = ? AND c.id = ?`),
    delContact:    db.prepare('DELETE FROM neerly_contacts WHERE owner_email = ? AND id = ?'),

    insertShare:   db.prepare('INSERT INTO neerly_shares (token, sender_email, sender_name, started_at, expires_at, lat, lng, accuracy, loc_at, mode, note, show_loc) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
    setNote:       db.prepare('UPDATE neerly_shares SET note = ? WHERE id = ?'),
    setWeather:    db.prepare('UPDATE neerly_shares SET weather = ?, weather_at = ? WHERE id = ? AND ended_at IS NULL'),
    shareByToken:  db.prepare('SELECT * FROM neerly_shares WHERE token = ?'),
    activeShareFor:db.prepare('SELECT * FROM neerly_shares WHERE sender_email = ? AND ended_at IS NULL AND expires_at > ? ORDER BY started_at DESC LIMIT 1'),
    endShare:      db.prepare('UPDATE neerly_shares SET ended_at = ?, lat = NULL, lng = NULL, accuracy = NULL, weather = NULL, weather_at = NULL WHERE id = ? AND ended_at IS NULL'),
    wipeShareLoc:  db.prepare('UPDATE neerly_shares SET lat = NULL, lng = NULL, accuracy = NULL, weather = NULL, weather_at = NULL WHERE id = ?'),
    openSharesFor: db.prepare('SELECT * FROM neerly_shares WHERE sender_email = ? AND ended_at IS NULL'),
    expiredOpen:   db.prepare('SELECT * FROM neerly_shares WHERE ended_at IS NULL AND expires_at <= ?'),
    shareById:     db.prepare('SELECT * FROM neerly_shares WHERE id = ?'),
    addShareDist:  db.prepare('UPDATE neerly_shares SET distance_m = distance_m + ? WHERE id = ?'),
    incLinkViews:  db.prepare('UPDATE neerly_shares SET link_views = link_views + 1 WHERE id = ?'),

    insertPoint:   db.prepare('INSERT INTO neerly_share_points (share_id, lat, lng, at) VALUES (?, ?, ?, ?)'),
    lastPoint:     db.prepare('SELECT lat, lng, at FROM neerly_share_points WHERE share_id = ? ORDER BY id DESC LIMIT 1'),
    countPoints:   db.prepare('SELECT COUNT(*) n FROM neerly_share_points WHERE share_id = ?'),
    pointsFrom:    db.prepare('SELECT lat, lng FROM neerly_share_points WHERE share_id = ? ORDER BY id LIMIT -1 OFFSET ?'),
    delPoints:     db.prepare('DELETE FROM neerly_share_points WHERE share_id = ?'),

    ensureStats:   db.prepare('INSERT OR IGNORE INTO neerly_stats (email) VALUES (?)'),
    stats:         db.prepare('SELECT * FROM neerly_stats WHERE email = ?'),
    statsEnd:      db.prepare('UPDATE neerly_stats SET minutes_shared = minutes_shared + ?, distance_m = distance_m + ? WHERE email = ?'),
    statsShare:    db.prepare('UPDATE neerly_stats SET shares_sent = shares_sent + 1, streak_weeks = ?, best_streak = MAX(best_streak, ?), last_week = ? WHERE email = ?'),
    statsWatched:  db.prepare('UPDATE neerly_stats SET times_watched = times_watched + 1 WHERE email = ?'),
    statsAnswered: db.prepare('UPDATE neerly_stats SET requests_answered = requests_answered + ? WHERE email = ?'),
    peopleCount:   db.prepare('SELECT COUNT(DISTINCT r.email) n FROM neerly_share_recipients r JOIN neerly_shares s ON s.id = r.share_id WHERE s.sender_email = ?'),
    answerRequests:db.prepare(`UPDATE neerly_update_requests SET answered_at = ? WHERE answered_at IS NULL AND created_at > ?
                               AND share_id IN (SELECT id FROM neerly_shares WHERE sender_email = ?)`),
    setLocation:   db.prepare('UPDATE neerly_shares SET lat = ?, lng = ?, accuracy = ?, loc_at = ? WHERE id = ?'),
    extendShare:   db.prepare('UPDATE neerly_shares SET expires_at = ? WHERE id = ?'),

    insertRecipient: db.prepare('INSERT OR IGNORE INTO neerly_share_recipients (share_id, email, nickname, view_token, hidden, handle) VALUES (?, ?, ?, ?, ?, ?)'),
    recipients:    db.prepare('SELECT * FROM neerly_share_recipients WHERE share_id = ? ORDER BY id'),
    recipientByView: db.prepare('SELECT * FROM neerly_share_recipients WHERE share_id = ? AND view_token = ?'),
    markEmailed:   db.prepare('UPDATE neerly_share_recipients SET emailed = 1 WHERE id = ?'),
    pingRecipient: db.prepare('UPDATE neerly_share_recipients SET opened_at = COALESCE(opened_at, ?), last_ping_at = ? WHERE id = ?'),

    lastRequest:   db.prepare('SELECT created_at FROM neerly_update_requests WHERE share_id = ? AND requester_email = ? ORDER BY created_at DESC LIMIT 1'),
    insertRequest: db.prepare('INSERT INTO neerly_update_requests (share_id, requester_email, requester_name, created_at) VALUES (?, ?, ?, ?)'),

    // v0.7a — Watching: live shares sent to this address (one per sender: a sender has one live share at a time)
    watchingFor:   db.prepare(`SELECT s.*, r.id AS rid, r.view_token AS r_view, r.opened_at AS r_opened, r.email AS r_email, r.nickname AS r_nick, r.handle AS r_handle, r.hidden AS r_hidden
                               FROM neerly_share_recipients r JOIN neerly_shares s ON s.id = r.share_id
                               WHERE r.email = ? AND s.ended_at IS NULL AND s.expires_at > ? AND s.sender_email != ?
                               ORDER BY s.started_at DESC`),
    setVerified:   db.prepare('UPDATE neerly_users SET email_verified_at = COALESCE(email_verified_at, ?) WHERE email = ?'),
    insertVerify:  db.prepare('INSERT INTO neerly_verify_tokens (token, email, created_at, expires_at) VALUES (?, ?, ?, ?)'),
    lastVerify:    db.prepare('SELECT created_at FROM neerly_verify_tokens WHERE email = ? ORDER BY created_at DESC LIMIT 1'),
    verifyToken:   db.prepare('SELECT * FROM neerly_verify_tokens WHERE token = ? AND expires_at > ?'),
    delVerifyFor:  db.prepare('DELETE FROM neerly_verify_tokens WHERE email = ?'),
    purgeVerify:   db.prepare('DELETE FROM neerly_verify_tokens WHERE expires_at < ?'),

    // v0.7b — push, reactions, quick starts
    pushSubsFor:   db.prepare('SELECT * FROM neerly_push_subs WHERE email = ? ORDER BY id'),
    upsertPushSub: db.prepare(`INSERT INTO neerly_push_subs (email, endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?)
                               ON CONFLICT(endpoint) DO UPDATE SET email = excluded.email, p256dh = excluded.p256dh, auth = excluded.auth, created_at = excluded.created_at`),
    delPushSub:    db.prepare('DELETE FROM neerly_push_subs WHERE endpoint = ?'),
    delPushSubMine:db.prepare('DELETE FROM neerly_push_subs WHERE endpoint = ? AND email = ?'),
    pushOk:        db.prepare('UPDATE neerly_push_subs SET last_ok_at = ? WHERE endpoint = ?'),
    insertReaction:db.prepare('INSERT INTO neerly_reactions (share_id, emoji, from_name, at, recipient_id) VALUES (?, ?, ?, ?, ?)'),
    reactionsByWho:db.prepare('SELECT recipient_id, from_name, emoji, COUNT(*) n FROM neerly_reactions WHERE share_id = ? GROUP BY recipient_id, from_name, emoji'),
    reactionsSince:db.prepare('SELECT id, emoji, from_name, at FROM neerly_reactions WHERE share_id = ? AND id > ? ORDER BY id DESC LIMIT 20'),
    lastReactionId:db.prepare('SELECT MAX(id) n FROM neerly_reactions WHERE share_id = ?'),
    delReactions:  db.prepare('DELETE FROM neerly_reactions WHERE share_id = ?'),
    setReactions:  db.prepare('UPDATE neerly_shares SET reactions = ? WHERE id = ?'),
    presets:       db.prepare('SELECT * FROM neerly_presets WHERE email = ? ORDER BY id'),
    presetByPid:   db.prepare('SELECT * FROM neerly_presets WHERE pid = ? AND email = ?'),
    insertPreset:  db.prepare('INSERT INTO neerly_presets (pid, email, name, mode, minutes, note, show_loc, people, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'),
    updatePreset:  db.prepare('UPDATE neerly_presets SET name = ?, mode = ?, minutes = ?, note = ?, show_loc = ?, people = ? WHERE pid = ? AND email = ?'),
    delPreset:     db.prepare('DELETE FROM neerly_presets WHERE pid = ? AND email = ?'),

    purgeSessions: db.prepare('DELETE FROM neerly_sessions WHERE expires_at < ?'),
    purgeResets:   db.prepare('DELETE FROM neerly_reset_tokens WHERE expires_at < ? OR used = 1'),
  };

  // Account deletion: everything tied to the user goes.
  const deleteAccount = db.transaction((email) => {
    const ids = db.prepare('SELECT id FROM neerly_shares WHERE sender_email = ?').all(email).map(r => r.id);
    for (const id of ids) {
      db.prepare('DELETE FROM neerly_share_points WHERE share_id = ?').run(id);
      db.prepare('DELETE FROM neerly_share_recipients WHERE share_id = ?').run(id);
      db.prepare('DELETE FROM neerly_update_requests WHERE share_id = ?').run(id);
      q.delReactions.run(id);
      anonViewers.delete(id); anonSeen.delete(id); reactLimits.delete(id);
    }
    db.prepare('DELETE FROM neerly_push_subs WHERE email = ?').run(email);
    db.prepare('DELETE FROM neerly_presets WHERE email = ?').run(email);
    db.prepare('DELETE FROM neerly_shares WHERE sender_email = ?').run(email);
    db.prepare('DELETE FROM neerly_update_requests WHERE requester_email = ?').run(email);
    db.prepare('DELETE FROM neerly_contacts WHERE owner_email = ?').run(email);
    db.prepare('DELETE FROM neerly_sessions WHERE email = ?').run(email);
    db.prepare('DELETE FROM neerly_reset_tokens WHERE email = ?').run(email);
    db.prepare('DELETE FROM neerly_verify_tokens WHERE email = ?').run(email);
    db.prepare('DELETE FROM neerly_stats WHERE email = ?').run(email);
    db.prepare('DELETE FROM neerly_badges WHERE email = ?').run(email);
    db.prepare('DELETE FROM neerly_share_backs WHERE from_email = ?').run(email);
    db.prepare('UPDATE neerly_users SET referred_by = NULL WHERE referred_by = ?').run(email);
    db.prepare('DELETE FROM neerly_users WHERE email = ?').run(email);
  });

  // ── Usernames ───────────────────────────────────────────────────────────────
  // 3–20 chars: a–z, 0–9, dot, underscore. Stored lowercase; unique regardless of case.
  const normUsername = (u) => String(u ?? '').trim().replace(/^@/, '').toLowerCase();
  function usernameProblem(u) {
    if (!u) return 'Pick a username';
    if (u.length < 3) return 'Usernames need at least 3 characters';
    if (u.length > 20) return 'Usernames can be up to 20 characters';
    if (!/^[a-z0-9._]+$/.test(u)) return 'Use letters, numbers, dots or underscores';
    if (/^[._]|[._]$/.test(u)) return 'Can’t start or end with a dot or underscore';
    if (/[._]{2}/.test(u)) return 'No two dots or underscores in a row';
    if (RESERVED_USERNAMES.has(u)) return 'That one’s reserved';
    return null;
  }
  function usernameTaken(u, exceptEmail) {
    const row = q.userByUsername.get(u);
    return !!row && row.email !== exceptEmail;
  }
  function usernameBase(s) {
    let b = String(s || '').toLowerCase().replace(/\+.*$/, '').replace(/[^a-z0-9._]/g, '')
      .replace(/[._]{2,}/g, '.').replace(/^[._]+|[._]+$/g, '').slice(0, 16).replace(/[._]+$/, '');
    if (b.length < 3) b = (b + 'buddy').slice(0, 16);
    if (RESERVED_USERNAMES.has(b)) b += '1';
    return b;
  }
  // First free name built from `seed` (an email or a wanted username): joy → joy, joy2, joy3…
  function suggestUsername(seed, exceptEmail) {
    const base = usernameBase(String(seed).includes('@') ? String(seed).split('@')[0] : seed);
    for (let i = 1; i < 60; i++) {
      const cand = i === 1 ? base : i < 20 ? `${base}${i}` : `${base.slice(0, 14)}${crypto.randomInt(100, 1000)}`;
      if (!usernameProblem(cand) && !usernameTaken(cand, exceptEmail)) return cand;
    }
    return `buddy${crypto.randomInt(100000, 1000000)}`;
  }
  // Accounts from before v0.4 get a username from their email.
  for (const { email } of q.usersNoUsername.all()) q.setUsername.run(suggestUsername(email, email), email);

  // ── Stats ───────────────────────────────────────────────────────────────────
  const weekIndex = (t) => Math.floor((t - 4 * 86400000) / WEEK_MS); // weeks start Monday 00:00 UTC
  function statsFor(email) {
    q.ensureStats.run(email);
    const s = q.stats.get(email);
    const w = weekIndex(now());
    const alive = s.last_week != null && s.last_week >= w - 1; // streak survives until a full week is missed
    return {
      shares: s.shares_sent,
      minutesShared: Math.round(s.minutes_shared),
      distanceM: Math.round(s.distance_m),
      people: q.peopleCount.get(email).n,
      timesWatched: s.times_watched,
      requestsAnswered: s.requests_answered,
      streakWeeks: alive ? s.streak_weeks : 0,
      bestStreak: s.best_streak,
      shareBacks: s.share_backs,
      friendsJoined: q.friendsJoined.get(email).n,
      nightShares: s.night_shares,
      earlyShares: s.early_shares,
    };
  }

  // ── Badges + rewards ────────────────────────────────────────────────────────
  // Awards any badge whose test now passes. Returns the ids newly earned.
  function checkBadges(email) {
    if (!q.userByEmail.get(email)) return [];
    const st = statsFor(email);
    const have = new Set(q.badges.all(email).map(b => b.badge));
    const fresh = [];
    const t = now();
    for (const b of BADGES) if (!have.has(b.id) && b.test(st)) { q.insertBadge.run(email, b.id, t); fresh.push(b.id); }
    if (fresh.length) console.log(`[neerly:badge] ${email} earned ${fresh.join(', ')}`);
    return fresh;
  }
  function unlockedFor(email) {
    const out = { head: [], face: [], neck: [], trail: [DEFAULT_TRAIL], icon: ['classic'] };
    const earned = new Set(q.badges.all(email).map(b => b.badge));
    for (const b of BADGES) if (earned.has(b.id)) out[b.reward.kind].push(b.reward.id);
    return out;
  }
  function badgeView(email) {
    return {
      earned: q.badges.all(email).map(b => ({ id: b.badge, earnedAt: b.earned_at, seen: !!b.seen_at, reward: BADGES.find(x => x.id === b.badge)?.reward || null })),
      total: BADGES.length, // the rest stay a surprise: the client shows only how many are left
    };
  }
  function parseOutfit(json) { try { const o = JSON.parse(json || '{}'); return o && typeof o === 'object' ? o : {}; } catch { return {}; } }
  // The look other people see: only items the user has actually unlocked.
  function lookFor(u) {
    if (!u) return { outfit: {}, trail: DEFAULT_TRAIL };
    const un = unlockedFor(u.email);
    const o = parseOutfit(u.outfit), outfit = {};
    for (const slot of OUTFIT_SLOTS) if (o[slot] && un[slot].includes(o[slot])) outfit[slot] = o[slot];
    return { outfit, trail: un.trail.includes(u.trail_style) ? u.trail_style : DEFAULT_TRAIL };
  }
  function countShareStart(email, t, tzOffsetMin) {
    q.ensureStats.run(email);
    // Night Owl / Early Bird use the sender's own clock (the browser sends its UTC offset in minutes).
    if (Number.isFinite(tzOffsetMin) && Math.abs(tzOffsetMin) <= 14 * 60) {
      const hour = new Date(t - tzOffsetMin * 60000).getUTCHours();
      if (hour >= 22 || hour < 4) q.statsNight.run(email);
      else if (hour >= 5 && hour < 7) q.statsEarly.run(email);
    }
    const s = q.stats.get(email);
    const w = weekIndex(t);
    let streak = s.streak_weeks;
    if (s.last_week === w) { /* already counted this week */ }
    else if (s.last_week === w - 1) streak += 1;
    else streak = 1;
    q.statsShare.run(streak, streak, w, email);
    const answered = q.answerRequests.run(t, t - REQUEST_ANSWER_MS, email).changes;
    if (answered) q.statsAnswered.run(answered, email);
  }

  // Ends a share once: wipes its location and trail, adds its minutes and distance to the lifetime totals.
  function finalizeShare(share, endedAt) {
    db.transaction(() => {
      const changed = q.endShare.run(endedAt, share.id).changes;
      q.wipeShareLoc.run(share.id);
      q.delPoints.run(share.id);
      q.delReactions.run(share.id); // v0.7b: who reacted goes; the counts stay for the summary card
      if (changed) {
        const fresh = q.shareById.get(share.id);
        q.ensureStats.run(fresh.sender_email);
        q.statsEnd.run(Math.max(0, endedAt - fresh.started_at) / 60000, fresh.distance_m || 0, fresh.sender_email);
      }
    })();
    checkBadges(share.sender_email);
    anonViewers.delete(share.id);
    anonSeen.delete(share.id);
    reactLimits.delete(share.id);
    reactPushedAt.delete(share.id);
  }

  // ── Trail ───────────────────────────────────────────────────────────────────
  function meters(a, b) {
    const R = 6371000, rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  function addTrailPoint(shareId, lat, lng, accuracy, t) {
    if (accuracy != null && accuracy > TRAIL_MAX_ACCURACY) return;
    const last = q.lastPoint.get(shareId);
    if (!last) { q.insertPoint.run(shareId, lat, lng, t); return; }
    const d = meters(last, { lat, lng });
    if (d < Math.max(TRAIL_MIN_STEP, Math.min(accuracy ?? 20, 40))) return;
    const secs = (t - last.at) / 1000;
    if (secs > 0 && d / secs > TRAIL_MAX_SPEED) return;
    if (q.countPoints.get(shareId).n >= TRAIL_MAX_POINTS) return;
    q.insertPoint.run(shareId, lat, lng, t);
    q.addShareDist.run(d, shareId);
  }
  const r6 = (n) => Math.round(n * 1e6) / 1e6;
  function trailSlice(shareId, from) {
    const off = Math.max(0, Math.floor(Number(from) || 0));
    const pts = q.pointsFrom.all(shareId, off).map(p => [r6(p.lat), r6(p.lng)]);
    return { trail: pts, trailFrom: off, trailCount: off + pts.length };
  }
  function shareSummary(share) {
    const rs = q.recipients.all(share.id);
    return {
      minutes: Math.max(0, Math.round(((share.ended_at || now()) - share.started_at) / 60000)),
      distanceM: Math.round(share.distance_m || 0),
      watchedBy: rs.filter(r => r.opened_at).map(recipLabel),
      linkViewers: share.link_views || 0,
      reactions: reactionCounts(share),
    };
  }
  function reactionCounts(share) { try { const o = JSON.parse(share.reactions || '{}'); return o && typeof o === 'object' ? o : {}; } catch { return {}; } }

  // ── v0.6 Weather ────────────────────────────────────────────────────────────
  // WMO weather codes → a few conditions the buddy can dress for.
  function weatherKind(code) {
    if ([95, 96, 99].includes(code)) return 'storm';
    if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'snow';
    if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return 'rain';
    if (code === 45 || code === 48) return 'fog';
    if (code === 2 || code === 3) return 'cloud';
    return 'clear';
  }
  const weatherInFlight = new Set();
  // Fire-and-forget: refreshes the share's weather if it's stale. Never blocks a response.
  function refreshWeather(share) {
    if (!share || share.lat == null || !isActive(share) || weatherInFlight.has(share.id)) return;
    const lat = Math.round(share.lat * 100) / 100, lng = Math.round(share.lng * 100) / 100;
    if (share.weather_at && now() - share.weather_at < WEATHER_TTL) {
      // Fresh enough, unless they've moved a few km since (a train or a drive).
      let at = null; try { at = JSON.parse(share.weather || 'null'); } catch {}
      if (!at || at.lat == null || Math.abs(at.lat - lat) + Math.abs(at.lng - lng) < 0.05) return;
    }
    weatherInFlight.add(share.id);
    const url = `${WEATHER_API}?latitude=${lat}&longitude=${lng}&current=temperature_2m,weather_code,is_day&timezone=auto`;
    const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), 6000);
    fetch(url, { signal: ctl.signal })
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        const c = d?.current; if (!c || !Number.isFinite(c.temperature_2m)) return;
        const w = { kind: weatherKind(Number(c.weather_code)), tempC: Math.round(c.temperature_2m), isDay: c.is_day !== 0, lat, lng };
        q.setWeather.run(JSON.stringify(w), now(), share.id);
      })
      .catch(() => {})
      .finally(() => { clearTimeout(to); weatherInFlight.delete(share.id); });
  }
  function weatherOf(share) {
    if (!isActive(share) || share.lat == null || !share.weather) return null;
    try { const w = JSON.parse(share.weather); return { kind: w.kind, tempC: w.tempC, isDay: w.isDay }; } catch { return null; }
  }

  function newSession(email) {
    const token = randToken(32);
    q.insertSession.run(token, email, now() + SESSION_MS);
    return token;
  }

  function publicUser(u) {
    const look = lookFor(u);
    return { email: u.email, name: u.name, username: u.username, avatar: u.avatar || null, outfit: look.outfit, trailStyle: look.trail, appIcon: u.app_icon === 'night' && unlockedFor(u.email).icon.includes('night') ? 'night' : 'classic',
      emailVerified: !!u.email_verified_at };
  }

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
    console.log(`[neerly:email] → ${to} | ${subject}${logLine ? ' | ' + logLine : ''}`);
    if (!resend) return false;
    try {
      const { data, error } = await resend.emails.send({ from: FROM, to, subject, html });
      if (error) { console.error(`[neerly:email] Resend rejected send to ${to}:`, error.name, '-', error.message); return false; }
      console.log(`[neerly:email] sent to ${to} (id: ${data?.id})`);
      return true;
    } catch (e) {
      console.error('[neerly:email] send threw:', e.message);
      return false;
    }
  }

  function emailShell(inner) {
    return `<div style="font-family:system-ui,-apple-system,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;color:#2a1a12">
      <div style="font-size:22px;font-weight:700;color:#e85d26;margin-bottom:24px">Neerly</div>
      ${inner}
      <p style="color:#9a8a80;font-size:12px;margin-top:32px">Neerly only shares a location while a share is running. When it ends, it's gone.</p>
    </div>`;
  }
  function button(href, label) {
    return `<a href="${href}" style="display:inline-block;background:#e85d26;color:#fff;font-weight:600;font-size:16px;padding:14px 28px;border-radius:999px;text-decoration:none">${label}</a>`;
  }
  const durationLabel = (ms) => {
    const m = Math.round(ms / 60000);
    return m >= 60 && m % 60 === 0 ? `${m / 60} hour${m === 60 ? '' : 's'}` : m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
  };

  function shareEmail(share, recipient, isShareBack) {
    const link = `${shareBase(share)}?share=${share.token}&r=${recipient.view_token}`;
    const t = shareTitle(share, isShareBack);
    const html = emailShell(`
      <p style="font-size:20px;font-weight:600;margin:0 0 8px">${esc(t)} 🧡</p>
      <p style="color:#6b5a50;margin:0 0 24px">${share.mode === 'now'
        ? `Live for the next ${durationLabel(share.expires_at - share.started_at)} — tap to see${share.show_loc ? ' where they are' : ''}. No app or account needed.`
        : `Sharing live for the next ${durationLabel(share.expires_at - share.started_at)} — tap to watch. No app or account needed.`}</p>
      ${button(link, share.mode === 'now' ? 'See it live →' : 'Watch live →')}`);
    const subject = t;
    return sendEmail(recipient.email, subject, html, link);
  }

  // One line that says what this share is: used for email subjects and headlines.
  function shareTitle(share, isShareBack) {
    const n = share.sender_name;
    if (share.mode === 'now') {
      if (isShareBack) return share.note ? `${n} shared back: ${share.note}` : `${n} shared back where they are`;
      return share.note ? `${n}: ${share.note}` : share.show_loc ? `${n} shared where they are` : `${n} shared what they're up to`;
    }
    if (isShareBack) return `${n} shared their location back`;
    return share.note ? `${n} is on the way to ${share.note}` : `${n} is on the way`;
  }

  function requestEmail(share, requesterName) {
    const html = emailShell(`
      <p style="font-size:20px;font-weight:600;margin:0 0 8px">${esc(requesterName)} wants to know where you are</p>
      <p style="color:#6b5a50;margin:0 0 24px">Your last share has ended. Open Neerly if you'd like to share again — it's entirely up to you.</p>
      ${button(PAGE_URL, 'Open Neerly →')}`);
    return sendEmail(share.sender_email, `${requesterName} wants to know where you are`, html, PAGE_URL);
  }

  function resetEmail(email, token) {
    const link = `${PAGE_URL}?reset=${token}`;
    const html = emailShell(`
      <p style="font-size:20px;font-weight:600;margin:0 0 8px">Reset your password</p>
      <p style="color:#6b5a50;margin:0 0 24px">Tap below to choose a new password. This link works once and expires in 15 minutes.</p>
      ${button(link, 'Set a new password →')}
      <p style="color:#9a8a80;font-size:13px;margin-top:24px">Didn't ask for this? You can ignore it.</p>`);
    return sendEmail(email, 'Reset your Neerly password', html, link);
  }

  // v0.7a — "confirm your email": the Watching map only lists shares for a confirmed address.
  function verifyEmail(email, token) {
    const link = `${PAGE_URL}?verify=${token}`;
    const html = emailShell(`
      <p style="font-size:20px;font-weight:600;margin:0 0 8px">Confirm your email</p>
      <p style="color:#6b5a50;margin:0 0 24px">Tap below so Neerly can show you the friends who share their location with this address. The link works for 24 hours.</p>
      ${button(link, 'Confirm my email →')}
      <p style="color:#9a8a80;font-size:13px;margin-top:24px">Didn't ask for this? You can ignore it.</p>`);
    return sendEmail(email, 'Confirm your email for Neerly', html, link);
  }

  // ── v0.7b Push notifications ────────────────────────────────────────────────
  // Sends to every device this account turned notifications on for. Devices the push service says are
  // gone (404/410) are forgotten. Never throws, never blocks a response. Returns how many devices it reached.
  async function pushTo(email, msg) {
    const subs = q.pushSubsFor.all(email);
    if (PUSH_LOG) { try { fs.appendFileSync(PUSH_LOG, JSON.stringify({ to: email, devices: subs.length, ...msg }) + '\n'); } catch {} }
    if (!subs.length) return 0;
    const payload = JSON.stringify({ title: msg.title, body: msg.body || '', url: msg.url || PAGE_URL, tag: msg.tag || undefined });
    let ok = 0;
    await Promise.all(subs.map(async (s) => {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: msg.ttl ?? 3600, urgency: 'high' });
        q.pushOk.run(now(), s.endpoint); ok++;
      } catch (e) {
        if (e.statusCode === 404 || e.statusCode === 410) { q.delPushSub.run(s.endpoint); console.log(`[neerly:push] forgot a device of ${email} (${e.statusCode})`); }
        else console.warn(`[neerly:push] send to ${email} failed:`, e.statusCode || '', e.body || e.message);
      }
    }));
    if (ok) console.log(`[neerly:push] → ${email} | ${msg.title} (${ok} device${ok === 1 ? '' : 's'})`);
    return ok;
  }
  const hasPush = (email) => q.pushSubsFor.all(email).length > 0;
  // The live link a recipient gets, for notifications that open a share.
  const viewLink = (share, r) => `${shareBase(share)}?share=${share.token}${r ? `&r=${r.view_token}` : ''}`;
  // What the sender sees as a watcher's name: their own nickname for them, or the @username they picked.
  const recipLabel = (r) => r.nickname || (r.handle ? '@' + r.handle : r.hidden ? 'Someone' : r.email.split('@')[0]);
  // One line about the sender's own share, for the notifications they get about it.
  const yourShare = (share) => share.mode === 'now'
    ? (share.note ? `Your status: ${share.note}` : 'Your spot right now')
    : (share.note ? `Your share: on the way to ${share.note}` : 'Your share: on the way');
  function pushWatching(share, who) {
    pushTo(share.sender_email, { title: `👀 ${who} ${who === 'Someone' ? 'opened your link' : 'is watching'}`, body: yourShare(share), tag: `watch-${share.token}` });
  }
  // Tells a recipient with a Neerly account that someone is sharing with them. Their address must be
  // confirmed (as for the Watching map) unless the sender picked them by @username, which names the account,
  // or it's a share back, which goes to the account that made the original share.
  function pushShareTo(share, r, isShareBack) {
    const u = q.userByEmail.get(r.email);
    if (!u || (!u.email_verified_at && !r.handle && !r.hidden)) return Promise.resolve(0);
    const icon = isShareBack ? '🔁' : share.mode === 'now' ? '📍' : '👣';
    return pushTo(r.email, { title: `${icon} ${shareTitle(share, isShareBack)}`, body: share.mode === 'now' ? 'Tap to see it live' : 'Tap to watch live', url: viewLink(share, r), tag: `share-${share.token}` });
  }
  // v0.7b: contacts as the page sees them. Someone added by @username has no address here, only the handle.
  function contactOut(c) {
    if (!c) return null;
    return { id: c.id, email: c.email_known ? c.email : null, username: c.email_known ? null : (c.uname || null), nickname: c.nickname || null };
  }
  const contactsFor = (email) => q.contacts.all(email).map(contactOut);
  // The people a share goes to, as the page sends them: { email, nickname } or (v0.7b) { contact: id }, a saved
  // friend added by @username, so the page never had their address. Skips yourself, duplicates and bad entries.
  function collectRecipients(u, list, seen = new Set()) {
    const rs = [];
    for (const r of Array.isArray(list) ? list : []) {
      if (r?.contact != null) {
        const c = q.contactById.get(u.email, Number(r.contact));
        if (!c || c.email === u.email || seen.has(c.email)) continue;
        seen.add(c.email);
        rs.push({ email: c.email, nickname: c.nickname || null, hidden: 0, handle: c.email_known ? null : (c.uname || null), known: !!c.email_known });
        continue;
      }
      const e = norm(r?.email);
      if (!isEmail(e) || e === u.email || seen.has(e)) continue;
      seen.add(e);
      rs.push({ email: e, nickname: clean(r?.nickname, 40) || null, hidden: 0, handle: null, known: true });
    }
    return rs;
  }
  // Emails (or, for someone picked by @username with notifications on, notifies) one recipient of a live share.
  function deliverShare(share, r, isShareBack) {
    const pushed = pushShareTo(share, r, isShareBack);
    if (r.handle) pushed.then(n => n ? q.markEmailed.run(r.id) : shareEmail(share, r, isShareBack).then(ok => { if (ok) q.markEmailed.run(r.id); }));
    else shareEmail(share, r, isShareBack).then(ok => { if (ok) q.markEmailed.run(r.id); });
  }
  function presetOut(r) {
    let people = []; try { people = JSON.parse(r.people || '[]'); } catch {}
    return { pid: r.pid, name: r.name, mode: r.mode, minutes: r.minutes, note: r.note || '', showLocation: !!r.show_loc, people, link: `${PAGE_URL}?preset=${r.pid}` };
  }

  // ── Share views ───────────────────────────────────────────────────────────
  function isActive(share) { return !share.ended_at && share.expires_at > now(); }

  function endIfExpired(share) {
    if (!share.ended_at && share.expires_at <= now()) {
      finalizeShare(share, share.expires_at);
      return q.shareByToken.get(share.token);
    }
    return share;
  }

  function maskEmail(e) { const [a, d] = String(e).split('@'); return `${a.slice(0, 1)}•••@${d || ''}`; }

  function recipientStatus(r) {
    if (r.last_ping_at && now() - r.last_ping_at < WATCHING_MS) return 'watching';
    if (r.opened_at) return 'viewed';
    return 'sent';
  }

  // rxFrom (v0.7b): send reactions newer than this id, so the sender's screen can pop them above the buddy.
  function senderView(share, trailFrom = 0, rxFrom = null) {
    const t = now();
    const rxAfter = rxFrom == null || rxFrom === '' ? null : Number(rxFrom);
    const live = isActive(share);
    // v0.7b.1: reactions per person while the share runs, so the sender can see who sent what.
    // Invited watchers are matched by their row; link viewers and others are listed by name ("Someone").
    const byRecipient = new Map(), byOther = new Map();
    if (live) for (const x of q.reactionsByWho.all(share.id)) {
      const m = x.recipient_id != null ? byRecipient : byOther, k = x.recipient_id ?? (x.from_name || 'Someone');
      if (!m.has(k)) m.set(k, {});
      m.get(k)[x.emoji] = (m.get(k)[x.emoji] || 0) + x.n;
    }
    const anon = anonViewers.get(share.id);
    let anonWatching = 0;
    if (anon) for (const [, ts] of anon) if (t - ts < WATCHING_MS) anonWatching++;
    return {
      token: share.token,
      link: `${shareBase(share)}?share=${share.token}`,
      active: isActive(share),
      startedAt: share.started_at,
      expiresAt: share.expires_at,
      endedAt: share.ended_at,
      maxExpiresAt: share.started_at + MAX_SHARE_MS,
      mode: share.mode || 'way',
      note: share.note || '',
      showLocation: !!share.show_loc,
      weather: weatherOf(share),
      location: share.lat != null ? { lat: share.lat, lng: share.lng, accuracy: share.accuracy, at: share.loc_at } : null,
      recipients: q.recipients.all(share.id).map(r => ({
        // v0.7b: someone picked by @username shows as that; their address stays private.
        email: r.hidden || r.handle ? (r.handle ? '@' + r.handle : maskEmail(r.email)) : r.email,
        nickname: r.nickname || (r.handle ? '@' + r.handle : null), hidden: !!r.hidden || !!r.handle, status: recipientStatus(r), emailed: !!r.emailed,
        openedAt: r.opened_at, lastPingAt: r.last_ping_at,
        reactions: byRecipient.get(r.id) || {},
      })),
      otherReactions: [...byOther].map(([name, counts]) => ({ name, counts })),
      linkViewersWatching: anonWatching,
      distanceM: Math.round(share.distance_m || 0),
      reactionCounts: reactionCounts(share),
      reactionsLastId: live ? (q.lastReactionId.get(share.id).n || 0) : 0,
      reactions: live && Number.isFinite(rxAfter) ? q.reactionsSince.all(share.id, rxAfter).reverse().map(x => ({ id: x.id, emoji: x.emoji, name: x.from_name || 'Someone', at: x.at })) : [],
      ...(live ? trailSlice(share.id, trailFrom) : { trail: [], trailFrom: 0, trailCount: 0 }),
      summary: live ? null : shareSummary(share),
    };
  }
  function durationsFor(mode) { return mode === 'now' ? NOW_DURATIONS : DURATIONS; }
  function durationError(mode) { return mode === 'now' ? 'Pick 30 min, 1 hour, 2 hours or 4 hours' : 'Pick 15 min, 30 min or 1 hour'; }
  function cleanNote(v) { return String(v ?? '').replace(/[\u0000-\u001f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, NOTE_MAX);
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
    if (p === '/neerly/auth/signup' && M === 'POST') {
      const { name, email, password, username, avatar, ref } = await readBody(req);
      const e = norm(email), n = clean(name, 40);
      if (!n) throw new HttpError(400, 'Please add your name');
      if (!isEmail(e)) throw new HttpError(400, 'That email doesn’t look right');
      if (typeof password !== 'string' || password.length < 8) throw new HttpError(400, 'Password needs at least 8 characters');
      if (password.length > 200) throw new HttpError(400, 'Password is too long');
      if (q.userByEmail.get(e)) throw new HttpError(409, 'There’s already an account for that email — try signing in');
      let un;
      if (username != null && String(username).trim() !== '') {
        un = normUsername(username);
        const problem = usernameProblem(un);
        if (problem) return json(res, 400, { error: problem, field: 'username' });
        if (usernameTaken(un)) return json(res, 409, { error: `@${un} is taken — how about @${suggestUsername(un)}?`, field: 'username', suggestion: suggestUsername(un) });
      } else un = suggestUsername(e); // recipient sign-up path has no username field
      const av = AVATARS.includes(avatar) ? avatar : null;
      // v0.5: a sign-up that came through someone's share link counts toward their Connector badge.
      const refShare = ref ? q.shareByToken.get(String(ref)) : null;
      const referrer = refShare && refShare.sender_email !== e && q.userByEmail.get(refShare.sender_email) ? refShare.sender_email : null;
      const salt = randToken(16);
      q.insertUser.run(e, n, hashPassword(password, salt), salt, now(), now(), un, av, referrer);
      q.ensureStats.run(e);
      if (referrer) checkBadges(referrer);
      console.log(`[neerly:auth] signup ${e} @${un}`);
      return json(res, 200, { token: newSession(e), user: publicUser(q.userByEmail.get(e)) });
    }

    if (p === '/neerly/auth/signin' && M === 'POST') {
      const { email, password } = await readBody(req);
      const u = q.userByEmail.get(norm(email));
      if (!u || typeof password !== 'string' || !checkPassword(password, u)) {
        throw new HttpError(401, 'Email or password isn’t right');
      }
      q.touchUser.run(now(), u.email);
      return json(res, 200, { token: newSession(u.email), user: publicUser(u) });
    }

    if (p === '/neerly/auth/signout' && M === 'POST') {
      const m = (req.headers['authorization'] || '').match(/^Bearer\s+(.+)$/i);
      if (m) q.delSession.run(m[1].trim());
      return json(res, 200, { ok: true });
    }

    if (p === '/neerly/auth/forgot' && M === 'POST') {
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

    if (p === '/neerly/auth/reset' && M === 'POST') {
      const { token, password } = await readBody(req);
      const row = q.reset.get(String(token || ''), now());
      if (!row) throw new HttpError(400, 'That reset link has expired or was already used');
      if (typeof password !== 'string' || password.length < 8) throw new HttpError(400, 'Password needs at least 8 characters');
      const salt = randToken(16);
      q.setPassword.run(hashPassword(password, salt), salt, row.email);
      q.useReset.run(row.token);
      q.setVerified.run(now(), row.email); // v0.7a: the reset link reached their inbox, so the address is theirs
      q.delSessionsFor.run(row.email); // sign out everywhere else
      const u = q.userByEmail.get(row.email);
      return json(res, 200, { token: newSession(u.email), user: publicUser(u) });
    }

    if (p === '/neerly/me' && M === 'GET') {
      const u = requireUser(req);
      const active = q.activeShareFor.get(u.email, now());
      checkBadges(u.email); // catches badges earned while offline (e.g. watched counts, friends joining)
      return json(res, 200, { user: publicUser(u), stats: statsFor(u.email), badges: badgeView(u.email), unlocked: unlockedFor(u.email), activeShare: active ? senderView(active) : null });
    }

    // ---- v0.7a: email confirmation ----
    if (p === '/neerly/me/verify-email' && M === 'POST') {
      const u = requireUser(req);
      if (u.email_verified_at) return json(res, 200, { ok: true, alreadyVerified: true });
      const last = q.lastVerify.get(u.email);
      if (last && now() - last.created_at < VERIFY_COOLDOWN) return json(res, 200, { ok: true, recentlySent: true });
      const token = randToken(32);
      q.insertVerify.run(token, u.email, now(), now() + VERIFY_MS);
      await verifyEmail(u.email, token);
      return json(res, 200, { ok: true });
    }
    if (p === '/neerly/auth/verify' && M === 'POST') {
      // No sign-in needed: the link may be opened on another device. It only confirms the address.
      const { token } = await readBody(req);
      const row = q.verifyToken.get(String(token || ''), now());
      if (!row) throw new HttpError(400, 'That confirmation link has expired. Send a new one from the Watching tab.');
      q.setVerified.run(now(), row.email);
      q.delVerifyFor.run(row.email);
      console.log(`[neerly:auth] email confirmed ${row.email}`);
      const me = authUser(req);
      return json(res, 200, { ok: true, email: row.email, user: me && me.email === row.email ? publicUser(q.userByEmail.get(me.email)) : null });
    }

    // ---- v0.7a: Watching — every live share sent to me, for one map ----
    // ?look=1 means the Watching tab is open, so the senders see this person as watching.
    // Without it (the tab badge checking in the background) nothing is marked.
    if (p === '/neerly/watching' && M === 'GET') {
      const u = requireUser(req);
      if (!u.email_verified_at) return json(res, 403, { error: 'Confirm your email to see who’s sharing with you', needsVerify: true });
      const look = url.searchParams.get('look') === '1';
      const t = now();
      const bySender = new Map();
      for (const row of q.watchingFor.all(u.email, t, u.email)) if (!bySender.has(row.sender_email)) bySender.set(row.sender_email, row);
      const friends = [];
      for (const share of bySender.values()) {
        if (look) {
          if (!share.r_opened) {
            q.ensureStats.run(share.sender_email); q.statsWatched.run(share.sender_email); checkBadges(share.sender_email);
            pushWatching(share, recipLabel({ email: share.r_email, nickname: share.r_nick, handle: share.r_handle, hidden: share.r_hidden }));
          }
          q.pingRecipient.run(t, t, share.rid);
          refreshWeather(share);
        }
        const sender = q.userByEmail.get(share.sender_email);
        const look2 = lookFor(sender);
        friends.push({
          token: share.token, r: share.r_view,
          name: share.sender_name, username: sender?.username || null,
          avatar: sender?.avatar || null, outfit: look2.outfit,
          mode: share.mode || 'way', note: share.note || '', showLocation: !!share.show_loc,
          weather: weatherOf(share),
          location: share.show_loc && share.lat != null ? { lat: share.lat, lng: share.lng, accuracy: share.accuracy, at: share.loc_at } : null,
          startedAt: share.started_at, expiresAt: share.expires_at,
        });
      }
      return json(res, 200, { friends });
    }

    if (p === '/neerly/me/badges/seen' && M === 'POST') {
      const u = requireUser(req);
      q.seeBadges.run(now(), u.email);
      return json(res, 200, { badges: badgeView(u.email) });
    }

    // v0.5: outfit, trail style and app icon — only unlocked items are accepted.
    if (p === '/neerly/me/look' && M === 'POST') {
      const u = requireUser(req);
      const body = await readBody(req);
      const un = unlockedFor(u.email);
      const cur = parseOutfit(u.outfit);
      const outfit = {};
      for (const slot of OUTFIT_SLOTS) {
        const v = body.outfit && slot in body.outfit ? body.outfit[slot] : cur[slot];
        if (v == null || v === '') continue;
        if (!un[slot].includes(v)) throw new HttpError(400, 'That item isn’t unlocked yet');
        outfit[slot] = v;
      }
      const trail = body.trailStyle !== undefined ? body.trailStyle : (u.trail_style || DEFAULT_TRAIL);
      if (!un.trail.includes(trail)) throw new HttpError(400, 'That trail isn’t unlocked yet');
      const icon = body.appIcon !== undefined ? body.appIcon : (u.app_icon || 'classic');
      if (!un.icon.includes(icon)) throw new HttpError(400, 'That icon isn’t unlocked yet');
      q.setLook.run(JSON.stringify(outfit), trail, icon, u.email);
      return json(res, 200, { user: publicUser(q.userByEmail.get(u.email)) });
    }

    // Username check / suggestion. ?u= checks a wanted name; ?email= suggests one from an email.
    if (p === '/neerly/username' && M === 'GET') {
      const me = authUser(req);
      const except = me?.email;
      const wanted = url.searchParams.get('u');
      if (wanted != null && wanted !== '') {
        const un = normUsername(wanted);
        const problem = usernameProblem(un);
        const taken = !problem && usernameTaken(un, except);
        return json(res, 200, {
          username: un, available: !problem && !taken,
          problem: problem || (taken ? `@${un} is taken` : null),
          suggestion: problem || taken ? suggestUsername(problem ? usernameBase(un) : un, except) : un,
        });
      }
      const em = norm(url.searchParams.get('email'));
      return json(res, 200, { suggestion: suggestUsername(em || 'buddy', except) });
    }

    if (p === '/neerly/me/profile' && M === 'POST') {
      const u = requireUser(req);
      const body = await readBody(req);
      const n = body.name !== undefined ? clean(body.name, 40) : u.name;
      if (!n) throw new HttpError(400, 'Please add your name');
      let un = u.username;
      if (body.username !== undefined) {
        un = normUsername(body.username);
        const problem = usernameProblem(un);
        if (problem) return json(res, 400, { error: problem, field: 'username' });
        if (usernameTaken(un, u.email)) return json(res, 409, { error: `@${un} is taken — how about @${suggestUsername(un, u.email)}?`, field: 'username', suggestion: suggestUsername(un, u.email) });
      }
      let av = u.avatar;
      if (body.avatar !== undefined) {
        if (!AVATARS.includes(body.avatar)) throw new HttpError(400, 'Pick one of the buddies');
        av = body.avatar;
      }
      q.setProfile.run(n, un, av, u.email);
      return json(res, 200, { user: publicUser(q.userByEmail.get(u.email)) });
    }

    if (p === '/neerly/me/password' && M === 'POST') {
      const u = requireUser(req);
      const { current, password } = await readBody(req);
      if (typeof current !== 'string' || !checkPassword(current, u)) throw new HttpError(400, 'Your current password isn’t right');
      if (typeof password !== 'string' || password.length < 8) throw new HttpError(400, 'New password needs at least 8 characters');
      if (password.length > 200) throw new HttpError(400, 'Password is too long');
      const salt = randToken(16);
      q.setPassword.run(hashPassword(password, salt), salt, u.email);
      const tok = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '').trim();
      q.delOtherSessions.run(u.email, tok); // other devices sign out; this one stays in
      return json(res, 200, { ok: true });
    }

    if (p === '/neerly/me/delete' && M === 'POST') {
      const u = requireUser(req);
      const { password } = await readBody(req);
      if (typeof password !== 'string' || !checkPassword(password, u)) throw new HttpError(400, 'Password isn’t right');
      deleteAccount(u.email);
      console.log(`[neerly:auth] deleted account ${u.email}`);
      return json(res, 200, { ok: true });
    }

    // ---- v0.7b: push notifications ----
    // The public key the browser needs to subscribe. No sign-in needed (it's public).
    if (p === '/neerly/push/key' && M === 'GET') {
      return json(res, 200, { key: VAPID.publicKey });
    }
    // Turn notifications on for this device. A device belongs to one account at a time.
    if (p === '/neerly/me/push' && M === 'POST') {
      const u = requireUser(req);
      const { subscription } = await readBody(req);
      const ep = String(subscription?.endpoint || ''), k = subscription?.keys || {};
      let host = '';
      try { const pu = new URL(ep); host = pu.protocol === 'https:' ? pu.hostname : ''; } catch {}
      if (!host || ep.length > 1000 || typeof k.p256dh !== 'string' || typeof k.auth !== 'string' || k.p256dh.length > 200 || k.auth.length > 100) {
        throw new HttpError(400, 'That notification setup didn’t work. Try again.');
      }
      q.upsertPushSub.run(u.email, ep, k.p256dh, k.auth, now());
      const subs = q.pushSubsFor.all(u.email);
      for (const s of subs.slice(0, Math.max(0, subs.length - MAX_PUSH_SUBS))) q.delPushSub.run(s.endpoint); // oldest devices go first
      console.log(`[neerly:push] ${u.email} turned notifications on (${Math.min(subs.length, MAX_PUSH_SUBS)} device(s))`);
      return json(res, 200, { ok: true, devices: Math.min(subs.length, MAX_PUSH_SUBS) });
    }
    if (p === '/neerly/me/push/delete' && M === 'POST') {
      const u = requireUser(req);
      const { endpoint } = await readBody(req);
      q.delPushSubMine.run(String(endpoint || ''), u.email);
      return json(res, 200, { ok: true });
    }
    // A test notification, so people can see it works (from the Profile screen).
    if (p === '/neerly/me/push/test' && M === 'POST') {
      const u = requireUser(req);
      const n = await pushTo(u.email, { title: '🦊 Notifications are on', body: 'You’ll hear from Neerly when someone watches, reacts or shares with you.', tag: 'test', ttl: 300 });
      return json(res, 200, { ok: true, devices: n });
    }

    // ---- v0.7b: quick starts (presets) ----
    // Each one is a share the user set up: name, mode, duration, optional destination or status, people.
    // Its link (?preset=…) opens Neerly ready to go, for an iPhone Shortcut or a home-screen bookmark.
    if (p === '/neerly/presets' && M === 'GET') {
      const u = requireUser(req);
      return json(res, 200, { presets: q.presets.all(u.email).map(presetOut) });
    }
    if (p === '/neerly/presets' && M === 'POST') {
      const u = requireUser(req);
      const body = await readBody(req);
      const name = clean(body.name, PRESET_NAME_MAX);
      if (!name) throw new HttpError(400, 'Give it a name, like “Gym” or “Home from work”');
      const mode = String(body.mode || 'way');
      if (!MODES.includes(mode)) throw new HttpError(400, 'Unknown share mode');
      const minutes = Number(body.minutes);
      if (!durationsFor(mode).includes(minutes)) throw new HttpError(400, durationError(mode));
      const note = cleanNote(body.note) || null;
      const showLoc = mode === 'way' ? 1 : body.showLocation === false ? 0 : 1;
      if (mode === 'now' && !showLoc && !note) throw new HttpError(400, 'Add what you’re up to, or show where you are');
      // People are kept as the page sends them: { email } or { contact: id } (friends added by @username).
      const people = [];
      for (const r of Array.isArray(body.people) ? body.people.slice(0, MAX_RECIPIENTS) : []) {
        if (r?.contact != null && q.contactById.get(u.email, Number(r.contact))) people.push({ contact: Number(r.contact) });
        else if (isEmail(norm(r?.email)) && norm(r.email) !== u.email) people.push({ email: norm(r.email) });
      }
      if (body.pid) {
        const cur = q.presetByPid.get(String(body.pid), u.email);
        if (!cur) throw new HttpError(404, 'That quick start is gone');
        q.updatePreset.run(name, mode, minutes, note, showLoc, JSON.stringify(people), cur.pid, u.email);
        return json(res, 200, { preset: presetOut(q.presetByPid.get(cur.pid, u.email)), presets: q.presets.all(u.email).map(presetOut) });
      }
      if (q.presets.all(u.email).length >= MAX_PRESETS) throw new HttpError(400, `You can keep up to ${MAX_PRESETS} quick starts. Remove one first.`);
      const pid = randToken(9);
      q.insertPreset.run(pid, u.email, name, mode, minutes, note, showLoc, JSON.stringify(people), now());
      return json(res, 200, { preset: presetOut(q.presetByPid.get(pid, u.email)), presets: q.presets.all(u.email).map(presetOut) });
    }
    if (p === '/neerly/presets/delete' && M === 'POST') {
      const u = requireUser(req);
      const { pid } = await readBody(req);
      q.delPreset.run(String(pid || ''), u.email);
      return json(res, 200, { presets: q.presets.all(u.email).map(presetOut) });
    }

    // ---- Contacts ----
    if (p === '/neerly/contacts' && M === 'GET') {
      const u = requireUser(req);
      return json(res, 200, { contacts: contactsFor(u.email) });
    }

    // Add someone by email, or (v0.7b) by @username. A friend added by username keeps their address private.
    if (p === '/neerly/contacts' && M === 'POST') {
      const u = requireUser(req);
      const { email, username, nickname } = await readBody(req);
      const nick = clean(nickname, 40) || null;
      if (username != null && String(username).trim() !== '') {
        const un = normUsername(username);
        const friend = un ? q.userByEmail.get(q.userByUsername.get(un)?.email || '') : null;
        if (!friend) throw new HttpError(404, `No one on Neerly is @${un || '…'}. Check the spelling, or add their email instead.`);
        if (friend.email === u.email) throw new HttpError(400, 'That’s you');
        q.upsertContact.run(u.email, friend.email, nick, now(), 0);
        return json(res, 200, { contact: contactOut(q.contactByEmail.get(u.email, friend.email)), contacts: contactsFor(u.email) });
      }
      const e = norm(email);
      if (!isEmail(e)) throw new HttpError(400, 'That email doesn’t look right');
      if (e === u.email) throw new HttpError(400, 'That’s your own email');
      q.upsertContact.run(u.email, e, nick, now(), 1);
      return json(res, 200, { contact: contactOut(q.contactByEmail.get(u.email, e)), contacts: contactsFor(u.email) });
    }

    if (p === '/neerly/contacts/delete' && M === 'POST') {
      const u = requireUser(req);
      const { id } = await readBody(req);
      q.delContact.run(u.email, Number(id));
      return json(res, 200, { contacts: contactsFor(u.email) });
    }

    // ---- Create share ----
    if (p === '/neerly/shares' && M === 'POST') {
      const u = requireUser(req);
      const { minutes, recipients, lat, lng, accuracy, shareBack, tzOffset, mode: rawMode, note: rawNote, showLocation } = await readBody(req);
      // v0.6: mode defaults to 'way' so older pages keep working.
      const mode = rawMode == null ? 'way' : String(rawMode);
      if (!MODES.includes(mode)) throw new HttpError(400, 'Unknown share mode');
      const note = cleanNote(rawNote) || null;
      const showLoc = mode === 'way' ? true : showLocation !== false; // On my way always shows the map
      if (!durationsFor(mode).includes(Number(minutes))) throw new HttpError(400, durationError(mode));
      if (showLoc && !validCoord(lat, lng)) throw new HttpError(400, 'We couldn’t get your location');
      if (mode === 'now' && !showLoc && !note) throw new HttpError(400, 'Add what you’re up to, or show where you are');
      const rs = collectRecipients(u, recipients);
      // v0.5 one-tap share back: the server looks up the original sender, so their
      // address is never shown to whoever holds the link. It isn't saved as a contact either.
      let original = null, countBack = false;
      if (shareBack) {
        original = q.shareByToken.get(String(shareBack));
        if (!original) throw new HttpError(404, 'That share link doesn’t exist anymore');
        if (original.sender_email === u.email) throw new HttpError(400, 'That’s your own share');
        const refTime = original.ended_at || original.expires_at;
        if (now() - Math.min(refTime, now()) > SHARE_BACK_WINDOW) throw new HttpError(410, 'That share is too old to share back to. Start a new share instead.');
        const last = q.lastShareBack.get(original.id, u.email);
        if (last && now() - last.created_at < SHARE_BACK_COOLDOWN) throw new HttpError(429, `You just shared back with ${original.sender_name}. Give it a few minutes.`);
        countBack = !last; // share-backs count once per original share
        const e = original.sender_email;
        const i = rs.findIndex(r => r.email === e);
        if (i >= 0) rs.splice(i, 1);
        rs.unshift({ email: e, nickname: original.sender_name, hidden: 1, handle: null, known: false });
      }
      if (rs.length > MAX_RECIPIENTS) throw new HttpError(400, `Up to ${MAX_RECIPIENTS} people per share`);
      // Recipients are optional: a link-only share (pasted into WhatsApp) is fine.

      const t = now();
      const token = randToken(18);
      for (const old of q.openSharesFor.all(u.email)) finalizeShare(old, t); // one live share at a time
      const created = db.transaction(() => {
        // A hidden location is never stored, not even for a moment.
        const info = q.insertShare.run(token, u.email, u.name, t, t + Number(minutes) * 60000,
          showLoc ? Number(lat) : null, showLoc ? Number(lng) : null, showLoc ? numOrNull(accuracy) : null, showLoc ? t : null,
          mode, note, showLoc ? 1 : 0);
        if (mode === 'way') addTrailPoint(info.lastInsertRowid, Number(lat), Number(lng), numOrNull(accuracy), t);
        countShareStart(u.email, t, Number(tzOffset));
        for (const r of rs) {
          q.insertRecipient.run(info.lastInsertRowid, r.email, r.nickname, randToken(12), r.hidden, r.handle);
          if (!r.hidden) q.upsertContact.run(u.email, r.email, r.nickname, t, r.known ? 1 : 0); // remember for next time
        }
        if (original) {
          q.insertShareBack.run(original.id, u.email, info.lastInsertRowid, t);
          if (countBack) q.statsShareBack.run(u.email);
        }
        return q.shareByToken.get(token);
      })();
      const newBadges = checkBadges(u.email);
      refreshWeather(created);

      // Email in the background so the sender's screen isn't waiting on Resend.
      // v0.7b: people with Neerly also get a notification. Someone picked by @username gets the
      // notification instead of an email when they have notifications on (otherwise the email).
      for (const r of q.recipients.all(created.id)) deliverShare(created, r, !!r.hidden && !!original);
      console.log(`[neerly:share] ${u.email} started ${minutes}m ${mode}${showLoc ? '' : ' (no location)'} share ${token} → ${rs.length} recipient(s)${original ? ' (share back)' : ''}`);
      return json(res, 200, { share: senderView(created), newBadges, shareBackTo: original ? original.sender_name : null });
    }

    // ---- Share sub-routes ----
    const m = p.match(/^\/neerly\/shares\/([A-Za-z0-9_-]{8,64})(?:\/([a-z-]+))?$/);
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
          if (recipient && active) {
            if (!recipient.opened_at) {
              q.ensureStats.run(share.sender_email); q.statsWatched.run(share.sender_email); checkBadges(share.sender_email);
              pushWatching(share, recipLabel(recipient)); // v0.7b: "👀 Mom is watching", even with the phone locked
            }
            q.pingRecipient.run(now(), now(), recipient.id);
          }
        } else if (viewer && active && /^[A-Za-z0-9_-]{6,40}$/.test(viewer)) {
          if (!anonViewers.has(share.id)) anonViewers.set(share.id, new Map());
          anonViewers.get(share.id).set(viewer, now());
          if (!anonSeen.has(share.id)) anonSeen.set(share.id, new Set());
          const seen = anonSeen.get(share.id);
          if (!seen.has(viewer) && seen.size < 500) {
            if (!seen.size) pushWatching(share, 'Someone'); // the first link viewer only, so a group chat doesn't buzz 20 times
            seen.add(viewer);
            q.incLinkViews.run(share.id);
            q.ensureStats.run(share.sender_email); q.statsWatched.run(share.sender_email); checkBadges(share.sender_email);
          }
        }
        const sender = q.userByEmail.get(share.sender_email);
        refreshWeather(share);
        return json(res, 200, {
          share: {
            senderName: share.sender_name,
            mode: share.mode || 'way',
            note: share.note || '',
            showLocation: !!share.show_loc,
            weather: weatherOf(share),
            senderAvatar: sender?.avatar || null,
            senderOutfit: lookFor(sender).outfit,
            senderTrail: lookFor(sender).trail,
            canShareBack: now() - Math.min(share.ended_at || share.expires_at, now()) <= SHARE_BACK_WINDOW,
            reactions: REACTIONS, // v0.7b
            active,
            startedAt: share.started_at,
            expiresAt: share.expires_at,
            endedAt: share.ended_at,
            location: active && share.lat != null ? { lat: share.lat, lng: share.lng, accuracy: share.accuracy, at: share.loc_at } : null,
            distanceM: Math.round(share.distance_m || 0),
            ...(active ? trailSlice(share.id, url.searchParams.get('t')) : { trail: [], trailFrom: 0, trailCount: 0 }),
            summary: active ? null : { minutes: shareSummary(share).minutes, distanceM: Math.round(share.distance_m || 0) },
          },
          // Lets the expired screen pre-fill the email of a recipient we already know.
          recipient: recipient ? { email: recipient.email, nickname: recipient.nickname } : null,
        });
      }

      if (action === 'status' && M === 'GET') {
        const u = requireUser(req);
        const share = loadOwnedShare(token, u);
        refreshWeather(share);
        return json(res, 200, { share: senderView(share, url.searchParams.get('t'), url.searchParams.get('rx')) });
      }

      if (action === 'location' && M === 'POST') {
        const u = requireUser(req);
        const share = loadOwnedShare(token, u);
        if (!isActive(share)) return json(res, 410, { error: 'This share has ended', share: senderView(share) });
        const { lat, lng, accuracy, trailFrom, rxFrom } = await readBody(req);
        // Right now with the location hidden: nothing is stored, whatever the page sends.
        if (!share.show_loc) return json(res, 200, { share: senderView(share, trailFrom, rxFrom) });
        if (!validCoord(lat, lng)) throw new HttpError(400, 'Invalid location');
        const t = now();
        db.transaction(() => {
          q.setLocation.run(Number(lat), Number(lng), numOrNull(accuracy), t, share.id);
          if ((share.mode || 'way') === 'way') addTrailPoint(share.id, Number(lat), Number(lng), numOrNull(accuracy), t);
        })();
        const fresh = q.shareByToken.get(token);
        refreshWeather(fresh);
        return json(res, 200, { share: senderView(fresh, trailFrom, rxFrom) });
      }

      // v0.6: change the "Heading to…" / status text while the share runs.
      if (action === 'note' && M === 'POST') {
        const u = requireUser(req);
        const share = loadOwnedShare(token, u);
        if (!isActive(share)) return json(res, 410, { error: 'This share has ended', share: senderView(share) });
        const note = cleanNote((await readBody(req)).note) || null;
        if (!note && share.mode === 'now' && !share.show_loc) throw new HttpError(400, 'Add what you’re up to');
        q.setNote.run(note, share.id);
        return json(res, 200, { share: senderView(q.shareByToken.get(token), 0) });
      }

      // v0.7b.1: add people to a share that's already running (they get the same email or notification).
      if (action === 'recipients' && M === 'POST') {
        const u = requireUser(req);
        const share = loadOwnedShare(token, u);
        if (!isActive(share)) return json(res, 410, { error: 'This share has ended', share: senderView(share) });
        const existing = q.recipients.all(share.id);
        const rs = collectRecipients(u, (await readBody(req)).recipients, new Set(existing.map(r => r.email)));
        if (!rs.length) throw new HttpError(400, 'Pick someone who isn’t on this share yet');
        if (existing.length + rs.length > MAX_RECIPIENTS) throw new HttpError(400, `Up to ${MAX_RECIPIENTS} people per share`);
        const t = now();
        db.transaction(() => {
          for (const r of rs) {
            q.insertRecipient.run(share.id, r.email, r.nickname, randToken(12), 0, r.handle);
            q.upsertContact.run(u.email, r.email, r.nickname, t, r.known ? 1 : 0);
          }
        })();
        const added = new Set(rs.map(r => r.email));
        for (const r of q.recipients.all(share.id)) if (added.has(r.email)) deliverShare(share, r, false);
        checkBadges(u.email); // "My People" counts everyone you've shared with
        console.log(`[neerly:share] ${u.email} added ${rs.length} to ${token}`);
        return json(res, 200, { share: senderView(q.shareByToken.get(token), 0), added: rs.length });
      }

      if (action === 'extend' && M === 'POST') {
        const u = requireUser(req);
        const share = loadOwnedShare(token, u);
        if (!isActive(share)) return json(res, 410, { error: 'This share has ended', share: senderView(share) });
        const { minutes } = await readBody(req);
        if (![...DURATIONS, ...NOW_DURATIONS].includes(Number(minutes))) throw new HttpError(400, 'Extend by 15 min, 30 min or 1 hour');
        const cap = share.started_at + MAX_SHARE_MS;
        const next = Math.min(share.expires_at + Number(minutes) * 60000, cap);
        if (next <= share.expires_at) throw new HttpError(400, 'Shares can run up to 4 hours in total');
        q.extendShare.run(next, share.id);
        return json(res, 200, { share: senderView(q.shareByToken.get(token), 0), capped: next === cap });
      }

      if (action === 'stop' && M === 'POST') {
        const u = requireUser(req);
        const share = loadOwnedShare(token, u);
        finalizeShare(share, now());
        console.log(`[neerly:share] ${u.email} stopped ${token}`);
        return json(res, 200, { share: senderView(q.shareByToken.get(token)) });
      }

      // v0.7b: a reaction from someone watching (❤️ 👋 👍 😂). It pops above the buddy on the sender's
      // screen and buzzes their phone (at most every 20 s). Only the counts outlive the share.
      if (action === 'react' && M === 'POST') {
        let share = q.shareByToken.get(token);
        if (!share) throw new HttpError(404, 'This link doesn’t match a share');
        share = endIfExpired(share);
        if (!isActive(share)) return json(res, 410, { error: 'This share has ended' });
        const { emoji, r, v } = await readBody(req);
        if (!REACTIONS.includes(emoji)) throw new HttpError(400, 'Pick one of the reactions');
        const me = authUser(req);
        if (me && me.email === share.sender_email) throw new HttpError(400, 'That’s your own share');
        const recipient = r ? q.recipientByView.get(share.id, String(r)) : null;
        const viewer = !recipient && v && /^[A-Za-z0-9_-]{6,40}$/.test(String(v)) ? String(v) : null;
        if (!recipient && !me && !viewer) throw new HttpError(400, 'Open the share link first');
        const key = recipient ? 'r:' + recipient.id : me ? 'u:' + me.email : 'v:' + viewer;
        if (!reactLimits.has(share.id)) reactLimits.set(share.id, new Map());
        const lim = reactLimits.get(share.id).get(key) || { last: 0, n: 0 };
        const t = now();
        if (t - lim.last < REACT_GAP_MS || lim.n >= REACT_MAX) return json(res, 429, { error: 'Easy there! Give it a second.' });
        reactLimits.get(share.id).set(key, { last: t, n: lim.n + 1 });
        const name = recipient ? recipLabel(recipient) : me ? me.name : 'Someone';
        const counts = reactionCounts(share);
        counts[emoji] = (counts[emoji] || 0) + 1;
        db.transaction(() => { q.insertReaction.run(share.id, emoji, name, t, recipient ? recipient.id : null); q.setReactions.run(JSON.stringify(counts), share.id); })();
        if (t - (reactPushedAt.get(share.id) || 0) >= PUSH_REACT_GAP_MS) {
          reactPushedAt.set(share.id, t);
          pushTo(share.sender_email, { title: `${emoji} ${name === 'Someone' ? 'Someone reacted' : name}`, body: `${name === 'Someone' ? 'Someone' : 'They'} reacted to your share`, tag: `react-${share.token}`, ttl: 600 });
        }
        return json(res, 200, { ok: true });
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
        pushTo(share.sender_email, { title: `🙋 ${name} wants to know where you are`, body: 'Open Neerly if you’d like to share again. It’s up to you.', tag: `request-${share.token}` });
        await requestEmail(share, name);
        console.log(`[neerly:request] ${email} asked ${share.sender_email} for an update`);
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
  // Returns true if the request was a /neerly route (handled), false otherwise.
  async function handle(req, res, url) {
    if (!url.pathname.startsWith('/neerly/')) return false;
    try {
      await route(req, res, url);
    } catch (e) {
      if (res.headersSent) return true;
      if (e instanceof HttpError) json(res, e.status, { error: e.message });
      else { console.error('[neerly] error:', e); json(res, 500, { error: 'Something went wrong on our side' }); }
    }
    return true;
  }

  // ── Housekeeping: expire shares (and wipe their coordinates), purge tokens ──
  function sweep() {
    const t = now();
    const expired = q.expiredOpen.all(t);
    for (const sh of expired) finalizeShare(sh, sh.expires_at);
    const n = expired.length;
    if (n) console.log(`[neerly:sweep] expired ${n} share(s), location wiped`);
    q.purgeSessions.run(t);
    q.purgeResets.run(t);
    q.purgeVerify.run(t);
    for (const [shareId] of reactLimits) if (!q.shareById.get(shareId) || q.shareById.get(shareId).ended_at) reactLimits.delete(shareId);
    for (const [shareId, viewers] of anonViewers) {
      for (const [v, ts] of viewers) if (t - ts > WATCHING_MS * 3) viewers.delete(v);
      if (!viewers.size) anonViewers.delete(shareId);
    }
  }
  setInterval(sweep, 30 * 1000).unref();
  sweep();

  return { handle };
}
