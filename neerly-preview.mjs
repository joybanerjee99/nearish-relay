// Neerly link-preview cards (v0.8): "Joy is on the way to Grandma's" with Joy's buddy in its outfit.
// Messages / WhatsApp show this image when a share link is pasted. Drawn as SVG, turned into a PNG by resvg
// with the bundled Figtree font (fonts/, SIL Open Font License), so it looks the same on any server.
import { Resvg } from '@resvg/resvg-js';
import path from 'path';
import { fileURLToPath } from 'url';
import { buddyInner } from './neerly-buddies.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const FONTS = ['Figtree_600SemiBold.ttf', 'Figtree_800ExtraBold.ttf'].map(f => path.join(here, 'fonts', f));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Rough text width for Figtree (good enough to wrap a headline into at most `maxLines` lines).
function wrap(text, size, maxWidth, maxLines) {
  const w = (s) => [...s].reduce((n, ch) => n + (/[ilI.,'’:;|!]/.test(ch) ? 0.28 : /[mwMW@]/.test(ch) ? 0.86 : /[A-Z0-9]/.test(ch) ? 0.64 : /\p{Extended_Pictographic}/u.test(ch) ? 1.1 : 0.53), 0) * size;
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (const word of words) {
    const next = cur ? cur + ' ' + word : word;
    if (w(next) <= maxWidth || !cur) cur = next;
    else { lines.push(cur); cur = word; }
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    let last = kept[maxLines - 1];
    while (last.length > 1 && w(last + '…') > maxWidth) last = last.slice(0, -1);
    kept[maxLines - 1] = last.replace(/\s+$/, '') + '…';
    return kept;
  }
  return lines;
}

// What the card says, from the share. Used for the image and for the preview page's title.
export function previewText(s) {
  const name = s.senderName || 'A friend';
  if (!s.active) return { title: `${name}’s share has ended`, sub: 'Neerly shares end on their own. Ask them for a new link.' };
  if (s.mode === 'now') {
    return s.note
      ? { title: `${name}: ${s.note}`, sub: s.showLocation ? 'Tap to see where they are, live' : 'Tap to see what they’re up to' }
      : { title: `${name} shared where they are`, sub: 'Tap to see them on the map, live' };
  }
  return { title: s.note ? `${name} is on the way to ${s.note}` : `${name} is on the way`, sub: 'Tap to watch them on the map, live' };
}

// A green tick in a circle (the font has no ✓ character).
const tick = (x, y) => `<circle cx="${x + 15}" cy="${y}" r="15" fill="#2f9e6b"/><path d="M${x + 8} ${y} l5 5 l10 -10" stroke="#fff" stroke-width="4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`;

export function previewSvg(s) {
  const { title, sub } = previewText(s);
  // The font has no emoji, so they're left out of the image (the text preview keeps them).
  const lines = wrap(title.replace(/\p{Extended_Pictographic}\uFE0F?/gu, '').replace(/\s+/g, ' ').trim(), 64, 700, 3);
  const size = lines.length > 2 ? 56 : 64;
  const lh = size * 1.12;
  const top = 315 - (lines.length * lh) / 2 - 10;
  const titleSvg = lines.map((l, i) => `<text x="440" y="${(top + size + i * lh).toFixed(0)}" font-family="Figtree" font-weight="800" font-size="${size}" fill="#2a1a12">${esc(l)}</text>`).join('');
  const subY = top + size + (lines.length - 1) * lh + 58;
  const left = s.active && s.expiresAt ? Math.max(1, Math.round((s.expiresAt - Date.now()) / 60000)) : 0;
  const leftTxt = left ? (left >= 60 ? `${Math.floor(left / 60)} h ${left % 60 ? (left % 60) + ' min' : ''}`.trim() : `${left} min`) : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <rect width="1200" height="630" fill="#fff1e6"/>
  <circle cx="225" cy="315" r="168" fill="#ffffff" stroke="#e85d26" stroke-width="12"/>
  <svg x="85" y="175" width="280" height="280" viewBox="0 0 64 64" overflow="visible">${buddyInner(s.senderAvatar, s.senderOutfit)}</svg>
  <text x="440" y="96" font-family="Figtree" font-weight="800" font-size="40" fill="#e85d26">Neerly</text>
  ${titleSvg}
  <text x="440" y="${subY.toFixed(0)}" font-family="Figtree" font-weight="600" font-size="34" fill="#6b5a50">${esc(sub)}</text>
  ${tick(440, 549)}<text x="482" y="560" font-family="Figtree" font-weight="600" font-size="28" fill="#6b5a50">No app needed</text>
  ${tick(700, 549)}<text x="742" y="560" font-family="Figtree" font-weight="600" font-size="28" fill="#6b5a50">Ends on its own</text>
  ${leftTxt ? `<text x="1130" y="560" text-anchor="end" font-family="Figtree" font-weight="600" font-size="28" fill="#e85d26">${esc(leftTxt)} left</text>` : ''}
</svg>`;
}

export function renderPng(svg) {
  const r = new Resvg(svg, { font: { fontFiles: FONTS, loadSystemFonts: false, defaultFontFamily: 'Figtree' }, fitTo: { mode: 'original' } });
  return r.render().asPng();
}
