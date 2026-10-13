// Neerly v1.0: Joy's private usage dashboard (/neerly/admin?key=NEERLY_ADMIN_KEY). Numbers only: the counters
// never hold who or where. One page, no libraries: stat tiles, single-series line charts with a hover tooltip,
// bar lists, a table view, and the editor for the server-driven promo line.
export const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>Neerly dashboard</title>
<style>
.viz-root{color-scheme:light;--surface-0:#f6f4f1;--surface-1:#fcfcfb;--text-primary:#0b0b0b;--text-secondary:#52514e;--text-muted:#7d7b76;
  --grid:#e6e3de;--border:#e1ddd6;--series-1:#2a78d6;--accent:#e85d26}
@media (prefers-color-scheme:dark){:root:where(:not([data-theme="light"])) .viz-root{color-scheme:dark;--surface-0:#121211;--surface-1:#1a1a19;--text-primary:#fff;--text-secondary:#c3c2b7;--text-muted:#9a998f;--grid:#2c2c2a;--border:#33332f;--series-1:#3987e5}}
:root[data-theme="dark"] .viz-root{color-scheme:dark;--surface-0:#121211;--surface-1:#1a1a19;--text-primary:#fff;--text-secondary:#c3c2b7;--text-muted:#9a998f;--grid:#2c2c2a;--border:#33332f;--series-1:#3987e5}
*{box-sizing:border-box}body{margin:0}
.viz-root{min-height:100vh;background:var(--surface-0);color:var(--text-primary);font:15px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;padding:20px 16px 48px}
.wrap{max-width:1080px;margin:0 auto}
h1{font-size:24px;margin:0}h2{font-size:15px;margin:28px 0 10px;color:var(--text-secondary);text-transform:uppercase;letter-spacing:.05em}
.top{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}
.muted{color:var(--text-muted)}
.filters{display:flex;gap:6px}
.filters button{border:1px solid var(--border);background:var(--surface-1);color:var(--text-secondary);border-radius:999px;padding:6px 12px;font:inherit;font-size:13px;cursor:pointer}
.filters button[aria-pressed="true"]{border-color:var(--text-primary);color:var(--text-primary);font-weight:600}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}
.tile{background:var(--surface-1);border:1px solid var(--border);border-radius:12px;padding:12px 14px}
.tile .v{font-size:28px;font-weight:700;font-variant-numeric:tabular-nums}
.tile .l{font-size:13px;color:var(--text-secondary)}
.grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:12px}
.card{background:var(--surface-1);border:1px solid var(--border);border-radius:12px;padding:12px 14px;position:relative}
.card h3{margin:0 0 2px;font-size:14px}.card .sub{font-size:12px;color:var(--text-muted);margin-bottom:6px}
svg text{fill:var(--text-muted);font-size:11px}
.tip{position:absolute;pointer-events:none;background:var(--text-primary);color:var(--surface-1);font-size:12px;padding:4px 8px;border-radius:6px;white-space:nowrap;opacity:0;transform:translate(-50%,-120%)}
.bars{display:grid;grid-template-columns:auto 1fr auto;gap:6px 10px;align-items:center;font-size:13px}
.bars .bar{height:12px;border-radius:0 4px 4px 0;background:var(--series-1)}
.bars .n{font-variant-numeric:tabular-nums;color:var(--text-secondary)}
table{border-collapse:collapse;width:100%;font-size:13px}td,th{padding:5px 8px;border-bottom:1px solid var(--grid);text-align:left}td.n{text-align:right;font-variant-numeric:tabular-nums}
details{margin-top:8px}summary{cursor:pointer;color:var(--text-secondary);font-size:13px}
form.promo{display:grid;gap:8px;max-width:620px}
form.promo input[type=text],form.promo input[type=url],form.promo input[type=date]{width:100%;padding:8px 10px;border-radius:8px;border:1px solid var(--border);background:var(--surface-0);color:var(--text-primary);font:inherit}
form.promo .row{display:flex;gap:14px;flex-wrap:wrap;font-size:13px;color:var(--text-secondary)}
form.promo button{justify-self:start;padding:8px 16px;border-radius:999px;border:0;background:var(--accent);color:#fff;font:inherit;font-weight:600;cursor:pointer}
.empty{color:var(--text-muted);font-size:13px;padding:10px 0}
</style></head>
<body><div class="viz-root"><div class="wrap">
<div class="top"><div><h1>Neerly dashboard</h1><div class="muted" id="asof">Loading…</div></div>
<div class="filters" role="group" aria-label="Time range"><button data-d="7">7 days</button><button data-d="30" aria-pressed="true">30 days</button><button data-d="90">90 days</button></div></div>

<h2>People</h2><div class="tiles" id="tiles"></div>
<h2>Every day</h2><div class="grid2" id="lines"></div>
<h2>Where they come from</h2><div class="grid2" id="sources"></div>
<h2>What they use</h2><div class="grid2" id="features"></div>
<h2>What they pick</h2><div class="grid2" id="picks"></div>
<h2>Promo line (no app update needed)</h2>
<div class="card"><form class="promo" id="promo">
<label>Text (max 120 characters)<input type="text" name="text" maxlength="120" placeholder="Driving home for Thanksgiving? Let them watch the fox. 🦃"></label>
<label>Link (optional, https://…)<input type="url" name="link" placeholder="https://neerly.net/how/"></label>
<label>Show until (optional)<input type="date" name="until"></label>
<div class="row">Show on: <label><input type="checkbox" name="where" value="share" checked> Share screen</label><label><input type="checkbox" name="where" value="watch"> Watch</label><label><input type="checkbox" name="where" value="meetups"> Meetups</label><label><input type="checkbox" name="where" value="watcher"> Watcher pages (people without Neerly)</label></div>
<button type="submit">Save</button><div class="muted" id="promo-msg">Leave the text empty and save to remove it.</div>
</form></div>
<details><summary>All counters (table)</summary><div id="table"></div></details>
</div></div>
<script>
const KEY = new URLSearchParams(location.search).get('key') || '';
let DAYS = 30, DATA = null;
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmt = (n) => Number(n || 0).toLocaleString();
function dayList(n) { const out = []; const d = new Date(); for (let i = n - 1; i >= 0; i--) { const x = new Date(d.getTime() - i * 86400000); out.push(x.toISOString().slice(0, 10)); } return out; }
function series(key) { const days = dayList(DAYS); const m = new Map(); for (const r of DATA.rows) if (r.key === key) m.set(r.day, r.n); return days.map(d => ({ d, n: m.get(d) || 0 })); }
function sumKeys(pred) { const t = {}; for (const [k, n] of Object.entries(DATA.totals)) if (pred(k)) t[k] = n; return t; }
function latestSnap(key) { let best = null; for (const r of DATA.rows) if (r.key === key && (!best || r.day > best.day)) best = r; return best ? best.n : 0; }

// A single-series line chart (no legend: the title names it), 2px line, recessive grid, crosshair + tooltip.
function lineCard(title, sub, pts) {
  const W = 320, H = 120, L = 30, R = 8, T = 8, B = 20;
  const max = Math.max(1, ...pts.map(p => p.n)), nice = max <= 4 ? 4 : Math.ceil(max / 4) * 4;
  const x = (i) => L + (pts.length < 2 ? 0 : i * (W - L - R) / (pts.length - 1)), y = (n) => T + (H - T - B) * (1 - n / nice);
  const path = pts.map((p, i) => (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(p.n).toFixed(1)).join(' ');
  let grid = ''; for (let g = 0; g <= 4; g++) { const v = nice * g / 4, yy = y(v); grid += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + yy + '" y2="' + yy + '" stroke="var(--grid)"/><text x="' + (L - 4) + '" y="' + (yy + 3) + '" text-anchor="end">' + fmt(v) + '</text>'; }
  const total = pts.reduce((a, p) => a + p.n, 0);
  const id = 'c' + Math.random().toString(36).slice(2, 8);
  const html = '<div class="card" id="' + id + '"><h3>' + esc(title) + '</h3><div class="sub">' + esc(sub) + ' · ' + fmt(total) + ' in ' + DAYS + ' days</div>' +
    '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" role="img" aria-label="' + esc(title) + ' per day">' + grid +
    '<text x="' + L + '" y="' + (H - 4) + '">' + pts[0].d.slice(5) + '</text><text x="' + (W - R) + '" y="' + (H - 4) + '" text-anchor="end">' + pts[pts.length - 1].d.slice(5) + '</text>' +
    '<path d="' + path + '" fill="none" stroke="var(--series-1)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>' +
    '<line class="xh" y1="' + T + '" y2="' + (H - B) + '" stroke="var(--text-muted)" stroke-dasharray="3 3" opacity="0"/><circle class="dot" r="4" fill="var(--series-1)" stroke="var(--surface-1)" stroke-width="2" opacity="0"/>' +
    '<rect x="' + L + '" y="0" width="' + (W - L - R) + '" height="' + H + '" fill="transparent" class="hit"/></svg><div class="tip"></div></div>';
  setTimeout(() => {
    const c = document.getElementById(id); if (!c) return;
    const svg = c.querySelector('svg'), hit = c.querySelector('.hit'), tip = c.querySelector('.tip'), xh = c.querySelector('.xh'), dot = c.querySelector('.dot');
    const move = (ev) => {
      const r = svg.getBoundingClientRect(), sx = (ev.clientX - r.left) * W / r.width;
      const i = Math.max(0, Math.min(pts.length - 1, Math.round((sx - L) / ((W - L - R) / Math.max(1, pts.length - 1)))));
      const px = x(i), py = y(pts[i].n);
      xh.setAttribute('x1', px); xh.setAttribute('x2', px); xh.setAttribute('opacity', 1);
      dot.setAttribute('cx', px); dot.setAttribute('cy', py); dot.setAttribute('opacity', 1);
      tip.textContent = pts[i].d + ': ' + fmt(pts[i].n); tip.style.opacity = 1;
      const cr = c.getBoundingClientRect(); tip.style.left = (r.left - cr.left + px * r.width / W) + 'px'; tip.style.top = (r.top - cr.top + py * r.height / H) + 'px';
    };
    hit.addEventListener('pointermove', move);
    hit.addEventListener('pointerleave', () => { tip.style.opacity = 0; xh.setAttribute('opacity', 0); dot.setAttribute('opacity', 0); });
  });
  return html;
}
// A bar list (magnitude, one hue), sorted, with the number next to each bar.
function barCard(title, sub, obj, label = (k) => k, limit = 10) {
  const rows = Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, limit);
  if (!rows.length) return '<div class="card"><h3>' + esc(title) + '</h3><div class="sub">' + esc(sub) + '</div><div class="empty">Nothing yet.</div></div>';
  const max = rows[0][1];
  return '<div class="card"><h3>' + esc(title) + '</h3><div class="sub">' + esc(sub) + '</div><div class="bars">' +
    rows.map(([k, n]) => '<span>' + esc(label(k)) + '</span><span><span class="bar" style="display:block;width:' + (n ? Math.max(1, n / max * 100) : 0) + '%" title="' + esc(label(k)) + ': ' + fmt(n) + '"></span></span><span class="n">' + fmt(n) + '</span>').join('') + '</div></div>';
}
const strip = (p) => (k) => k.slice(p.length);
function render() {
  const T = DATA.totals, t = (k) => T[k] || 0;
  $('#asof').textContent = 'Last ' + DAYS + ' days · numbers only, never who or where · updated ' + new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const tiles = [['Accounts', latestSnap('snap:users')], ['Active today', latestSnap('snap:active:1d')], ['Active this week', latestSnap('snap:active:7d')], ['Active this month', latestSnap('snap:active:30d')],
    ['Sign-ups', t('signup')], ['Shares', t('share:way') + t('share:now')], ['Meetups', t('meetup:created')], ['Notifications turned on', Object.keys(T).filter(k => k.startsWith('push:on@')).reduce((a, k) => a + T[k], 0)]];
  $('#tiles').innerHTML = tiles.map(([l, v]) => '<div class="tile"><div class="v">' + fmt(v) + '</div><div class="l">' + esc(l) + '</div></div>').join('');
  $('#lines').innerHTML = lineCard('Sign-ups', 'new accounts per day', series('signup')) + lineCard('Active accounts', 'used Neerly in the last 24 h', series('snap:active:1d')) +
    lineCard('On my way shares', 'per day', series('share:way')) + lineCard('Right now shares', 'per day', series('share:now')) +
    lineCard('Meetups created', 'per day', series('meetup:created')) + lineCard('Meetup joins', 'per day', series('meetup:joined'));
  const plat = { Website: t('open@web'), 'Home Screen app': t('open@pwa'), 'iPhone app': t('open@ios'), 'Android app': t('open@android') };
  const signPlat = { Website: t('signup@web'), 'Home Screen app': t('signup@pwa'), 'iPhone app': t('signup@ios'), 'Android app': t('signup@android') };
  const src = sumKeys(k => k.startsWith('source:')); src['source:direct'] = Math.max(0, t('signup') - Object.values(src).reduce((a, b) => a + b, 0));
  $('#sources').innerHTML = barCard('Sign-ups by source', 'invite, share link, campaign or direct', src, strip('source:')) + barCard('Sign-ups by platform', '', signPlat) +
    barCard('App opens by platform', 'each time Neerly starts', plat) + barCard('Campaign links', 'visits from ?c= links (one per reel or channel)', sumKeys(k => k.startsWith('landing:')), strip('landing:'));
  const feats = { 'On my way': t('share:way'), 'Right now': t('share:now'), 'With a destination': t('share:dest'), 'Late check on': t('share:late'), 'Share back': t('share:back'),
    'Meetup: on my way': t('meetup:go'), 'Meetup: arrived': t('meetup:arrived'), 'Quick messages': t('meetup:say'), 'Invites by @username': t('meetup:invite'),
    'Postcards made': t('postcard:made'), 'Postcards shared': t('postcard:shared'), 'Quick starts used': t('quickstart:used'), 'Send via… (shares)': t('share:sheet'), 'Send via… (invites)': t('invite:sheet') };
  $('#features').innerHTML = barCard('Features used', 'last ' + DAYS + ' days', feats, (k) => k, 20);
  $('#picks').innerHTML = barCard('Buddies picked', 'at sign-up and when changed', sumKeys(k => k.startsWith('buddy:')), strip('buddy:')) +
    barCard('Outfits put on', '', sumKeys(k => k.startsWith('outfit:')), strip('outfit:')) + barCard('Trail styles picked', '', sumKeys(k => k.startsWith('trail:')), strip('trail:'));
  const rows = Object.entries(T).filter(([k]) => !k.startsWith('snap:')).sort();
  $('#table').innerHTML = '<table><tr><th>Counter</th><th style="text-align:right">Last ' + DAYS + ' days</th></tr>' + rows.map(([k, n]) => '<tr><td>' + esc(k) + '</td><td class="n">' + fmt(n) + '</td></tr>').join('') + '</table>';
  const pr = DATA.content?.promo;
  const f = $('#promo');
  if (pr && !f.dataset.loaded) { f.text.value = pr.text || ''; f.link.value = pr.link || ''; if (pr.until) f.until.value = new Date(pr.until).toISOString().slice(0, 10); [...f.querySelectorAll('[name=where]')].forEach(c => c.checked = (pr.where || []).includes(c.value)); }
  f.dataset.loaded = 1;
}
async function load() {
  const r = await fetch('/neerly/admin/counts?key=' + encodeURIComponent(KEY) + '&days=' + DAYS);
  if (!r.ok) { $('#asof').textContent = 'Not allowed: open this page with your admin key (?key=…).'; return; }
  DATA = await r.json(); render();
}
document.querySelectorAll('.filters button').forEach(b => b.addEventListener('click', () => {
  DAYS = Number(b.dataset.d); document.querySelectorAll('.filters button').forEach(x => x.setAttribute('aria-pressed', x === b)); load();
}));
$('#promo').addEventListener('submit', async (e) => {
  e.preventDefault(); const f = e.target;
  const until = f.until.value ? new Date(f.until.value + 'T23:59:59').getTime() : null;
  const body = { promo: { text: f.text.value.trim(), link: f.link.value.trim(), until, where: [...f.querySelectorAll('[name=where]:checked')].map(c => c.value), id: String(Date.now()) } };
  const r = await fetch('/neerly/admin/content?key=' + encodeURIComponent(KEY), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  $('#promo-msg').textContent = r.ok ? (body.promo.text ? 'Saved. It shows within about 5 minutes.' : 'Removed.') : 'Couldn’t save.';
});
load(); setInterval(load, 5 * 60 * 1000);
</script></body></html>`;
