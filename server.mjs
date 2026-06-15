import { WebSocketServer } from 'ws';
import http from 'http';

// ── Config ─────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const STALE_MS = 3 * 60 * 1000;      // drop presence after 3 min silence
const PURGE_INTERVAL = 60 * 1000;    // clean stale entries every 60s

// ── Presence store ─────────────────────────────────────────────────────────
// { email -> { lat, lng, ts, contacts: [email], ws } }
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

function findNearby(email, radiusM) {
  const me = presence.get(email);
  if (!me) return [];

  const nearby = [];
  for (const [otherEmail, other] of presence) {
    if (otherEmail === email) continue;
    if (Date.now() - other.ts > STALE_MS) continue;

    // Mutual consent: each must have the other in their contact list
    const iMutual =
      me.contacts.includes(otherEmail) &&
      other.contacts.includes(email);
    if (!iMutual) continue;

    const dist = haversine(me.lat, me.lng, other.lat, other.lng);
    if (dist <= radiusM) {
      nearby.push({ email: otherEmail, distM: Math.round(dist) });
    }
  }
  return nearby;
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

// ── HTTP server (health check for Render/Railway) ──────────────────────────
const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', users: presence.size }));
  } else {
    res.writeHead(404);
    res.end();
  }
});

// ── WebSocket server ───────────────────────────────────────────────────────
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  let clientEmail = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // ── ping: update position ────────────────────────────────────────────
    if (msg.type === 'ping') {
      const { email, lat, lng, contacts, radiusM } = msg;
      if (!email || lat == null || lng == null) return;

      clientEmail = email;
      presence.set(email, {
        lat, lng,
        ts: Date.now(),
        contacts: Array.isArray(contacts) ? contacts : [],
        ws,
      });

      const nearby = findNearby(email, radiusM || 300);
      send(ws, { type: 'nearby', nearby });
      console.log(`[ping] ${email} → ${nearby.length} nearby`);
    }

    // ── bye: explicit disconnect ─────────────────────────────────────────
    if (msg.type === 'bye') {
      if (clientEmail) presence.delete(clientEmail);
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

function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}

setInterval(purgeStale, PURGE_INTERVAL);

server.listen(PORT, () => {
  console.log(`Nearish relay running on port ${PORT}`);
});
