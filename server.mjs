import { WebSocketServer } from 'ws';
import http from 'http';

const PORT = process.env.PORT || 3000;
const STALE_MS = 3 * 60 * 1000;
const PURGE_INTERVAL = 60 * 1000;

// { email -> { lat, lng, ts, contacts, name, phone, homeLat, homeLng, ws } }
const presence = new Map();

function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
    Math.cos((lat2 * Math.PI) / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Is this user currently at their home location (within 20km)?
function isAtHome(user) {
  if (user.homeLat == null || user.homeLng == null) return false;
  return haversine(user.lat, user.lng, user.homeLat, user.homeLng) < 20000;
}

function findNearby(email, radiusM) {
  const me = presence.get(email);
  if (!me) return [];
  const nearby = [];

  for (const [otherEmail, other] of presence) {
    if (otherEmail === email) continue;
    if (Date.now() - other.ts > STALE_MS) continue;

    // Mutual contact check
    const mutual =
      me.contacts.includes(otherEmail) &&
      other.contacts.includes(email);
    if (!mutual) continue;

    // Distance check — are they in the same city or airport?
    const dist = haversine(me.lat, me.lng, other.lat, other.lng);
    if (dist > radiusM) continue;

    // Production rule: notify only when both people are in the same city
    // AND at least one of them is away from home.
    //
    // Case matrix:
    // - Both at home in same city        → suppressed (everyday situation)
    // - One away, one at home, same city → notify ✓
    // - Both away, same city             → notify ✓
    // - Different cities (any combo)     → already filtered by distance check above
    //
    // The distance check above handles the "different cities" case entirely.
    // This single line handles the only remaining suppression case.
    if (isAtHome(me) && isAtHome(other)) continue;

    nearby.push({
      email: otherEmail,
      name: other.name || otherEmail,
      distM: Math.round(dist),
    });
  }
  return nearby;
}

function send(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function purgeStale() {
  const cutoff = Date.now() - STALE_MS;
  for (const [email, p] of presence) {
    if (p.ts < cutoff) {
      console.log(`[purge] ${email}`);
      presence.delete(email);
    }
  }
}

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', users: presence.size }));
  } else {
    res.writeHead(404);
    res.end();
  }
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  let clientEmail = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // ── ping ───────────────────────────────────────────────────────────────
    if (msg.type === 'ping') {
      const { email: rawEmail, name, phone, lat, lng, contacts, radiusM, homeLat, homeLng } = msg;
      if (!rawEmail || lat == null || lng == null) return;
      const email = rawEmail.toLowerCase().trim();
      clientEmail = email;
      presence.set(email, {
        lat, lng,
        name: name || email,
        phone: phone || null,
        homeLat: homeLat ?? null,
        homeLng: homeLng ?? null,
        ts: Date.now(),
        contacts: Array.isArray(contacts) ? contacts.map(e => e.toLowerCase().trim()) : [],
        ws,
      });
      const nearby = findNearby(email, radiusM || 20000);
      send(ws, { type: 'nearby', nearby });
      console.log(`[ping] ${email} → ${nearby.length} nearby`);
    }

    // ── message ────────────────────────────────────────────────────────────
    if (msg.type === 'nudge') {
      const { from: rawFrom, fromName, to: rawTo, message } = msg;
      if (!rawFrom || !rawTo) return;
      const from = rawFrom.toLowerCase().trim();
      const to   = rawTo.toLowerCase().trim();
      const sender   = presence.get(from);
      const receiver = presence.get(to);
      if (!sender || !receiver) {
        send(ws, { type: 'nudge_result', success: false, reason: 'Contact is not currently online' });
        return;
      }
      const mutual =
        sender.contacts.includes(to) &&
        receiver.contacts.includes(from);
      if (!mutual) {
        send(ws, { type: 'nudge_result', success: false, reason: 'Not a mutual contact' });
        return;
      }
      send(receiver.ws, {
        type: 'incoming_nudge',
        from,
        fromName: fromName || sender.name || from,
        message: message || '👋',
        ts: Date.now(),
      });
      send(ws, { type: 'nudge_result', success: true, to, toName: receiver.name || to, msgId: msg.msgId || null });
      console.log(`[message] ${from} → ${to}`);
    }

    // ── bye ────────────────────────────────────────────────────────────────
    if (msg.type === 'bye') {
      if (clientEmail) presence.delete(clientEmail.toLowerCase().trim());
    }
  });

  ws.on('close', () => {
    if (clientEmail) {
      console.log(`[disconnect] ${clientEmail}`);
      presence.delete(clientEmail);
    }
  });

  ws.on('error', () => {
    if (clientEmail) presence.delete(clientEmail);
  });
});

setInterval(purgeStale, PURGE_INTERVAL);

server.listen(PORT, () => {
  console.log(`Orbyt relay running on port ${PORT}`);
});
