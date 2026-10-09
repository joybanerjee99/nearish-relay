// Neerly buddies for the server (v0.8): the same drawings as in index.html, so link-preview cards
// show each sender's own buddy in its outfit. Keep in step with index.html (a test checks they match).
const INK = '#2a1a12';
const eyes = (y = 35, dx = 7, r = 2.8) => `<circle cx="${32 - dx}" cy="${y}" r="${r}" fill="${INK}"/><circle cx="${32 + dx}" cy="${y}" r="${r}" fill="${INK}"/><circle cx="${33 - dx}" cy="${y - 1}" r="${r / 3}" fill="#fff"/><circle cx="${33 + dx}" cy="${y - 1}" r="${r / 3}" fill="#fff"/>`;
const blush = (y = 41, dx = 12) => `<ellipse cx="${32 - dx}" cy="${y}" rx="3.4" ry="2.1" fill="#ff7f98" opacity=".5"/><ellipse cx="${32 + dx}" cy="${y}" rx="3.4" ry="2.1" fill="#ff7f98" opacity=".5"/>`;
const smile = (y = 42) => `<path d="M29 ${y} q3 3 6 0" stroke="${INK}" stroke-width="1.7" fill="none" stroke-linecap="round"/>`;
const catMouth = (y = 42) => `<path d="M28.5 ${y} q1.75 2.6 3.5 0 q1.75 2.6 3.5 0" stroke="${INK}" stroke-width="1.6" fill="none" stroke-linecap="round"/>`;
const BUDDIES = {
  cat: { name: 'Cat', svg:
    `<path d="M13 28 L16 8 L30 18 Z" fill="#8e98a6"/><path d="M51 28 L48 8 L34 18 Z" fill="#8e98a6"/><path d="M17 23 L18.5 13 L25 18 Z" fill="#ffb3c1"/><path d="M47 23 L45.5 13 L39 18 Z" fill="#ffb3c1"/>
     <circle cx="32" cy="36" r="20" fill="#9aa4b2"/><path d="M26 18 q6 4 12 0" stroke="#7b8594" stroke-width="2" fill="none"/>
     ${eyes()}${blush()}<path d="M30.5 39 h3 l-1.5 1.8 z" fill="#ff8fa3"/>${catMouth(41)}
     <path d="M10 38 h9 M10 43 l9 -2 M54 38 h-9 M54 43 l-9 -2" stroke="#6f7886" stroke-width="1.2" stroke-linecap="round"/>` },
  pup: { name: 'Pup', svg:
    `<circle cx="32" cy="36" r="20" fill="#e2ad70"/>
     <ellipse cx="14" cy="33" rx="6.5" ry="13" fill="#8c5b38" transform="rotate(18 14 33)"/><ellipse cx="50" cy="33" rx="6.5" ry="13" fill="#8c5b38" transform="rotate(-18 50 33)"/>
     <circle cx="41" cy="30" r="5" fill="#c98d52" opacity=".7"/><ellipse cx="32" cy="44" rx="9.5" ry="7" fill="#f7dfbf"/>
     ${eyes(34)}<ellipse cx="32" cy="41" rx="3.4" ry="2.4" fill="${INK}"/>${smile(45)}<ellipse cx="32" cy="49" rx="2" ry="2.5" fill="#ff8fa3"/>` },
  bunny: { name: 'Bunny', svg:
    `<ellipse cx="24" cy="14" rx="5.5" ry="13" fill="#f6eee9" stroke="#e3cfc1" stroke-width="1.5"/><ellipse cx="24" cy="15" rx="2.4" ry="9" fill="#ffc2cf"/>
     <ellipse cx="40" cy="14" rx="5.5" ry="13" fill="#f6eee9" stroke="#e3cfc1" stroke-width="1.5"/><ellipse cx="40" cy="15" rx="2.4" ry="9" fill="#ffc2cf"/>
     <circle cx="32" cy="38" r="19" fill="#f6eee9" stroke="#e3cfc1" stroke-width="1.5"/>
     ${eyes(37)}${blush(43)}<ellipse cx="32" cy="42" rx="2" ry="1.4" fill="#ff8fa3"/>${catMouth(44)}` },
  fox: { name: 'Fox', svg:
    `<path d="M12 30 L14 8 L29 19 Z" fill="#ec7a35"/><path d="M52 30 L50 8 L35 19 Z" fill="#ec7a35"/><path d="M14 13 L14 8 L19 12 Z" fill="#3a2418"/><path d="M50 13 L50 8 L45 12 Z" fill="#3a2418"/>
     <circle cx="32" cy="36" r="20" fill="#ec7a35"/>
     <path d="M12 37 Q22 31 32 40 Q42 31 52 37 Q48 56 32 56 Q16 56 12 37 Z" fill="#fff4ea"/>
     ${eyes(34)}<ellipse cx="32" cy="42" rx="2.8" ry="2" fill="${INK}"/>${smile(45)}` },
  bear: { name: 'Bear', svg:
    `<circle cx="16" cy="20" r="7.5" fill="#a36f47"/><circle cx="48" cy="20" r="7.5" fill="#a36f47"/><circle cx="16" cy="20" r="3.8" fill="#dca77c"/><circle cx="48" cy="20" r="3.8" fill="#dca77c"/>
     <circle cx="32" cy="36" r="20" fill="#a36f47"/><ellipse cx="32" cy="43" rx="9.5" ry="7.5" fill="#e6c49f"/>
     ${eyes(33)}${blush(40, 13)}<ellipse cx="32" cy="40" rx="3.4" ry="2.4" fill="${INK}"/>${smile(44)}` },
  panda: { name: 'Panda', svg:
    `<circle cx="16" cy="20" r="7.5" fill="#2e2a2b"/><circle cx="48" cy="20" r="7.5" fill="#2e2a2b"/>
     <circle cx="32" cy="36" r="20" fill="#fbfbfb" stroke="#e0dada" stroke-width="1.5"/>
     <ellipse cx="24" cy="35" rx="5.5" ry="7" fill="#2e2a2b" transform="rotate(-28 24 35)"/><ellipse cx="40" cy="35" rx="5.5" ry="7" fill="#2e2a2b" transform="rotate(28 40 35)"/>
     <circle cx="24.5" cy="34.5" r="2.3" fill="#fff"/><circle cx="39.5" cy="34.5" r="2.3" fill="#fff"/><circle cx="25" cy="35" r="1.2" fill="${INK}"/><circle cx="39" cy="35" r="1.2" fill="${INK}"/>
     ${blush(44, 13)}<ellipse cx="32" cy="42" rx="2.8" ry="2" fill="${INK}"/>${smile(45)}` },
  owl: { name: 'Owl', svg:
    `<path d="M14 24 L13 10 L24 18 Z" fill="#7b5aa6"/><path d="M50 24 L51 10 L40 18 Z" fill="#7b5aa6"/>
     <circle cx="32" cy="36" r="20" fill="#8d6bb8"/><ellipse cx="32" cy="46" rx="11" ry="8" fill="#c7b2e4"/>
     <circle cx="24" cy="33" r="7.5" fill="#fff"/><circle cx="40" cy="33" r="7.5" fill="#fff"/>
     <circle cx="24.5" cy="33.5" r="3.6" fill="${INK}"/><circle cx="39.5" cy="33.5" r="3.6" fill="${INK}"/><circle cx="25.5" cy="32.3" r="1.2" fill="#fff"/><circle cx="40.5" cy="32.3" r="1.2" fill="#fff"/>
     <path d="M29 40 L35 40 L32 45 Z" fill="#f6a623"/>` },
  frog: { name: 'Frog', svg:
    `<circle cx="21" cy="24" r="9" fill="#7cc26b"/><circle cx="43" cy="24" r="9" fill="#7cc26b"/>
     <ellipse cx="32" cy="40" rx="23" ry="16" fill="#7cc26b"/>
     <circle cx="21" cy="23" r="5.5" fill="#fff"/><circle cx="43" cy="23" r="5.5" fill="#fff"/><circle cx="21.5" cy="23.5" r="2.8" fill="${INK}"/><circle cx="42.5" cy="23.5" r="2.8" fill="${INK}"/>
     ${blush(43, 15)}<path d="M22 42 q10 8 20 0" stroke="${INK}" stroke-width="1.8" fill="none" stroke-linecap="round"/>` },
  dragon: { name: 'Dragon', svg:
    `<path d="M20 22 L15 5 L28 17 Z" fill="#ffd166"/><path d="M44 22 L49 5 L36 17 Z" fill="#ffd166"/>
     <path d="M27 17 L32 9 L37 17 Z" fill="#2d9483"/>
     <circle cx="32" cy="37" r="20" fill="#3fb3a0"/><ellipse cx="32" cy="46" rx="11" ry="7.5" fill="#9fe0c9"/>
     <path d="M12 38 l-6 -3 l3 6 Z M52 38 l6 -3 l-3 6 Z" fill="#2d9483"/>
     ${eyes(34)}${blush(40, 13)}<circle cx="29" cy="45" r="1.2" fill="#236e62"/><circle cx="35" cy="45" r="1.2" fill="#236e62"/>${smile(48)}` },
  unicorn: { name: 'Unicorn', svg:
    `<circle cx="17" cy="24" r="7" fill="#ff9ecf"/><circle cx="13" cy="33" r="6" fill="#b69cff"/><circle cx="15" cy="42" r="5" fill="#8fd3ff"/>
     <path d="M20 22 L19 12 L27 18 Z" fill="#fbf5ff" stroke="#e5d8f2" stroke-width="1.2"/><path d="M44 22 L45 12 L37 18 Z" fill="#fbf5ff" stroke="#e5d8f2" stroke-width="1.2"/>
     <circle cx="33" cy="37" r="19" fill="#fbf5ff" stroke="#e5d8f2" stroke-width="1.5"/>
     <path d="M33 2 L28.5 19 L37.5 19 Z" fill="#ffc94d"/><path d="M30 13 l6 -2 M29.5 16.5 l7 -2 M31 9.5 l4 -1.5" stroke="#e59f1f" stroke-width="1.1"/>
     <circle cx="24" cy="22" r="5" fill="#ff9ecf"/>
     ${eyes(36)}${blush(42)}${smile(43)}` },
  ghost: { name: 'Ghost', svg:
    `<path d="M14 32 A18 18 0 0 1 50 32 V54 q-3 4 -6 0 q-3 -4 -6 0 q-3 4 -6 0 q-3 -4 -6 0 q-3 4 -6 0 Z" fill="#fbfbff" stroke="#d6d0e6" stroke-width="1.5"/>
     <ellipse cx="25" cy="32" rx="3" ry="4" fill="${INK}"/><ellipse cx="39" cy="32" rx="3" ry="4" fill="${INK}"/><circle cx="26" cy="30.5" r="1" fill="#fff"/><circle cx="40" cy="30.5" r="1" fill="#fff"/>
     ${blush(39, 13)}<ellipse cx="32" cy="41" rx="2.6" ry="3" fill="${INK}"/>` },
  robot: { name: 'Robot', svg:
    `<path d="M32 16 V8" stroke="#6d8fb3" stroke-width="2.5"/><circle cx="32" cy="7" r="3.5" fill="#ff6b6b"/>
     <rect x="7" y="31" width="5" height="12" rx="2" fill="#6d8fb3"/><rect x="52" y="31" width="5" height="12" rx="2" fill="#6d8fb3"/>
     <rect x="11" y="16" width="42" height="38" rx="11" fill="#9fc0e0"/><rect x="16" y="23" width="32" height="22" rx="7" fill="#2a3a4f"/>
     <circle cx="25" cy="33" r="3.2" fill="#7ff0ff"/><circle cx="39" cy="33" r="3.2" fill="#7ff0ff"/><path d="M28.5 38.5 q3.5 3 7 0" stroke="#7ff0ff" stroke-width="1.8" fill="none" stroke-linecap="round"/>
     <circle cx="18" cy="50" r="1.6" fill="#6d8fb3"/><circle cx="46" cy="50" r="1.6" fill="#6d8fb3"/>` },
  // v0.7a.3 — two people in work clothes, plus a wolf and a lion.
  suitm: { name: 'Exec', svg:
    `<path d="M9 66 Q10 50 32 48.5 Q54 50 55 66 Z" fill="#2f3e5c"/><path d="M24.5 49.5 L32 61 L39.5 49.5 Q32 48 24.5 49.5 Z" fill="#fff"/>
     <path d="M24.5 49.5 L29 57 L26 58.5 L22 51 Z M39.5 49.5 L35 57 L38 58.5 L42 51 Z" fill="#24314a"/>
     <path d="M30.6 52.5 h2.8 l1.2 7.5 l-2.6 3 l-2.6 -3 Z" fill="#c8413a"/><path d="M30 49.5 h4 l-.6 3 h-2.8 Z" fill="#a8322c"/>
     <circle cx="15" cy="33" r="3.6" fill="#e9b98f"/><circle cx="49" cy="33" r="3.6" fill="#e9b98f"/>
     <circle cx="32" cy="32" r="17" fill="#f0c49c"/>
     <path d="M15 31 Q13.5 13 32 12.5 Q50.5 13 49 31 Q47.5 23 42 20.5 Q33 24.5 22 20 Q16.5 23 15 31 Z" fill="#3b2a20"/>
     ${eyes(32, 6.5, 2.6)}${blush(38, 11)}${smile(39)}` },
  suitf: { name: 'Boss', svg:
    `<path d="M12.5 46 Q10 13 32 11.5 Q54 13 51.5 46 Q47 49 43.5 46 L43.5 30 L20.5 30 L20.5 46 Q17 49 12.5 46 Z" fill="#5a3522"/>
     <path d="M9 66 Q10 50 32 48.5 Q54 50 55 66 Z" fill="#7a2f47"/><path d="M25 49.5 L32 60 L39 49.5 Q32 48 25 49.5 Z" fill="#fbf3ee"/>
     <path d="M25 49.5 L29.5 56.5 L26.5 58 L22.5 51 Z M39 49.5 L34.5 56.5 L37.5 58 L41.5 51 Z" fill="#62243a"/>
     <circle cx="32" cy="32" r="16.5" fill="#c68a62"/>
     <circle cx="15.6" cy="38" r="1.5" fill="#fff" stroke="#e3d6cc" stroke-width=".5"/><circle cx="48.4" cy="38" r="1.5" fill="#fff" stroke="#e3d6cc" stroke-width=".5"/>
     <path d="M15.5 31.5 Q15 12.5 33 12.5 Q49.5 13.5 48.8 30 Q43 18.5 27 21.5 Q20 23.5 15.5 31.5 Z" fill="#6b4029"/>
     ${eyes(32, 6.5, 2.6)}${blush(38, 11)}<path d="M29 39 q3 2.8 6 0" stroke="#a63d4f" stroke-width="1.9" fill="none" stroke-linecap="round"/>` },
  wolf: { name: 'Wolf', svg:
    `<path d="M11 31 L13 4 L29 18 Z" fill="#5c6b7d"/><path d="M53 31 L51 4 L35 18 Z" fill="#5c6b7d"/><path d="M15.5 23 L16 11 L24.5 18.5 Z" fill="#3d4756"/><path d="M48.5 23 L48 11 L39.5 18.5 Z" fill="#3d4756"/>
     <path d="M14 44 l-5 1 l3.5 -4 l-4.5 -1 l4.5 -3.5 Z M50 44 l5 1 l-3.5 -4 l4.5 -1 l-4.5 -3.5 Z" fill="#5c6b7d"/>
     <circle cx="32" cy="36" r="20" fill="#5c6b7d"/>
     <path d="M32 21 L27.5 30 Q19 30 14 39 Q20 56 32 56 Q44 56 50 39 Q45 30 36.5 30 Z" fill="#e8ecf1"/>
     ${eyes(34)}<ellipse cx="32" cy="42" rx="3" ry="2.1" fill="${INK}"/>${smile(45)}` },
  lion: { name: 'Lion', svg:
    `${[0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330].map((d) => { const r = d * Math.PI / 180; return `<circle cx="${(32 + 20 * Math.cos(r)).toFixed(1)}" cy="${(36 + 20 * Math.sin(r)).toFixed(1)}" r="8" fill="${d % 60 ? '#b5642a' : '#c9772f'}"/>`; }).join('')}
     <circle cx="32" cy="36" r="20" fill="#c9772f"/>
     <circle cx="20" cy="22" r="5" fill="#f2bd62"/><circle cx="44" cy="22" r="5" fill="#f2bd62"/><circle cx="20" cy="22" r="2.4" fill="#d9944a"/><circle cx="44" cy="22" r="2.4" fill="#d9944a"/>
     <circle cx="32" cy="37" r="15.5" fill="#f2bd62"/><ellipse cx="32" cy="44" rx="8.5" ry="6" fill="#fbe2b3"/>
     ${eyes(34)}<path d="M29.2 40 h5.6 l-2.8 3 Z" fill="#6e3f22"/><path d="M32 43 v1.5" stroke="${INK}" stroke-width="1.4"/>${catMouth(44.2)}` },
};
const DEFAULT_BUDDY = 'fox';
// v0.5 — outfits. Each buddy has anchor points so items sit on the head, eyes and neck.
// top: where a hat rests · eye: eye line · dx: half the eye spacing · neck: chin line
const ANCHOR = {
  cat: { top: 17, eye: 35, dx: 7, neck: 54 },   pup: { top: 17, eye: 34, dx: 7, neck: 54 },
  bunny: { top: 20, eye: 37, dx: 7, neck: 55 }, fox: { top: 17, eye: 34, dx: 7, neck: 54 },
  bear: { top: 17, eye: 33, dx: 7, neck: 54 },  panda: { top: 17, eye: 34.5, dx: 7.5, neck: 54 },
  owl: { top: 17, eye: 33.5, dx: 7.5, neck: 54 }, frog: { top: 17, eye: 23.5, dx: 10.5, neck: 54 },
  dragon: { top: 18, eye: 34, dx: 7, neck: 55 }, unicorn: { top: 19, eye: 36, dx: 7, neck: 54, hornOver: true },
  ghost: { top: 15, eye: 32, dx: 7, neck: 47 }, robot: { top: 17, eye: 33, dx: 7, neck: 53 },
  suitm: { top: 14, eye: 32, dx: 6.5, neck: 49 }, suitf: { top: 14, eye: 32, dx: 6.5, neck: 49 },
  wolf: { top: 17, eye: 34, dx: 7, neck: 55 },  lion: { top: 17, eye: 34, dx: 7, neck: 55 },
};
const ACCESSORIES = {
  beanie:   { slot: 'head', name: 'Beanie',  draw: (a) => { const t = a.top; return `<path d="M19 ${t + 3} a13 11.5 0 0 1 26 0 z" fill="#3d8bd3"/><path d="M24 ${t - 5} v7 M29 ${t - 7.5} v9 M35 ${t - 7.5} v9 M40 ${t - 5} v7" stroke="#2f73b3" stroke-width="1.4"/><rect x="17.5" y="${t + 0.5}" width="29" height="5.5" rx="2.7" fill="#2a66a3"/><circle cx="32" cy="${t - 9.5}" r="3.4" fill="#f4f1ee"/>`; } },
  crown:    { slot: 'head', name: 'Crown',   draw: (a) => { const t = a.top; return `<path d="M21 ${t + 2} L20.5 ${t - 8} L26.5 ${t - 2.5} L32 ${t - 11} L37.5 ${t - 2.5} L43.5 ${t - 8} L43 ${t + 2} Z" fill="#ffc83d" stroke="#e3a106" stroke-width="1.2" stroke-linejoin="round"/><circle cx="32" cy="${t - 2}" r="1.8" fill="#e8475f"/><circle cx="25.5" cy="${t - 0.5}" r="1.3" fill="#4cc9f0"/><circle cx="38.5" cy="${t - 0.5}" r="1.3" fill="#4cc9f0"/>`; } },
  flowers:  { slot: 'head', name: 'Flower crown', draw: (a) => { const t = a.top; const f = (x, y, c) => `<g transform="translate(${x} ${y})"><circle r="2.3" cx="0" cy="-2" fill="${c}"/><circle r="2.3" cx="1.9" cy="-0.6" fill="${c}"/><circle r="2.3" cx="1.2" cy="1.7" fill="${c}"/><circle r="2.3" cx="-1.2" cy="1.7" fill="${c}"/><circle r="2.3" cx="-1.9" cy="-0.6" fill="${c}"/><circle r="1.4" fill="#ffd166"/></g>`; return `<path d="M17 ${t + 3} Q32 ${t - 5} 47 ${t + 3}" stroke="#5cae5a" stroke-width="2" fill="none"/>` + f(19, t + 1.5, '#ff8fb1') + f(25.5, t - 1.5, '#fff') + f(32, t - 2.5, '#b69cff') + f(38.5, t - 1.5, '#fff') + f(45, t + 1.5, '#ff8fb1'); } },
  partyhat: { slot: 'head', name: 'Party hat', draw: (a) => { const t = a.top; return `<path d="M25.5 ${t + 2} L33 ${t - 16} L40.5 ${t + 2} Z" fill="#7c5cff"/><circle cx="30" cy="${t - 3}" r="1.4" fill="#ffd166"/><circle cx="35" cy="${t - 7}" r="1.4" fill="#ff8fb1"/><circle cx="33.5" cy="${t - 0.5}" r="1.4" fill="#4cc9f0"/><circle cx="33" cy="${t - 16.5}" r="2.8" fill="#ffd166"/>`; } },
  wizard:   { slot: 'head', name: 'Wizard hat', draw: (a) => { const t = a.top; return `<path d="M24.5 ${t + 1} Q30 ${t - 12} 36 ${t - 21} Q37 ${t - 10} 40 ${t + 1} Z" fill="#5b47a8"/><ellipse cx="32" cy="${t + 1.5}" rx="15" ry="3.4" fill="#45358a"/><path d="M33 ${t - 9} l1 2.2 2.4 .3 -1.8 1.6 .5 2.4 -2.1 -1.2 -2.1 1.2 .5 -2.4 -1.8 -1.6 2.4 -.3z" fill="#ffd166"/>`; } },
  sunglasses: { slot: 'face', name: 'Sunglasses', draw: (a) => { const y = a.eye, dx = a.dx, w = dx >= 10 ? 13 : 11; return `<rect x="${32 - dx - w / 2}" y="${y - 4.2}" width="${w}" height="8" rx="3.2" fill="#1f1d2b"/><rect x="${32 + dx - w / 2}" y="${y - 4.2}" width="${w}" height="8" rx="3.2" fill="#1f1d2b"/><path d="M${32 - dx + w / 2} ${y - 1.5} Q32 ${y - 3.5} ${32 + dx - w / 2} ${y - 1.5}" stroke="#1f1d2b" stroke-width="1.6" fill="none"/><path d="M${32 - dx - 3} ${y - 2} l2.5 -1.2 M${32 + dx - 3} ${y - 2} l2.5 -1.2" stroke="#fff" stroke-width="1.1" stroke-linecap="round" opacity=".8"/>`; } },
  scarf:    { slot: 'neck', name: 'Scarf', draw: (a) => { const c = a.neck; return `<path d="M17.5 ${c - 4} Q32 ${c + 2.5} 46.5 ${c - 4} L46.5 ${c + 1.5} Q32 ${c + 8} 17.5 ${c + 1.5} Z" fill="#e2463b"/><path d="M20 ${c - 1.5} Q32 ${c + 4.5} 44 ${c - 1.5}" stroke="#fff" stroke-width="1" stroke-dasharray="2 2" fill="none" opacity=".6"/><rect x="37" y="${c + 1}" width="5.5" height="9" rx="2" fill="#c7362c" transform="rotate(-14 39.7 ${c + 1})"/>`; } },
  bowtie:   { slot: 'neck', name: 'Bow tie', draw: (a) => { const c = a.neck; return `<path d="M32 ${c} L24.5 ${c - 4.5} Q23 ${c} 24.5 ${c + 4.5} Z M32 ${c} L39.5 ${c - 4.5} Q41 ${c} 39.5 ${c + 4.5} Z" fill="#e2463b"/><rect x="29.8" y="${c - 2.3}" width="4.4" height="4.6" rx="1.4" fill="#b8302a"/>`; } },
};

// The buddy in its outfit (no weather look), as the inside of a 64×64 SVG.
export function buddyInner(id, outfit = {}) {
  const key = BUDDIES[id] ? id : DEFAULT_BUDDY;
  const a = ANCHOR[key];
  let s = BUDDIES[key].svg;
  for (const slot of ['neck', 'face', 'head']) {
    const item = ACCESSORIES[outfit?.[slot]];
    if (item && item.slot === slot) s += item.draw(a);
  }
  if (a.hornOver && outfit?.head && ACCESSORIES[outfit.head]) s += `<path d="M33 2 L28.5 19 L37.5 19 Z" fill="#ffc94d"/><path d="M30 13 l6 -2 M29.5 16.5 l7 -2 M31 9.5 l4 -1.5" stroke="#e59f1f" stroke-width="1.1"/>`;
  return s;
}
export { BUDDIES, DEFAULT_BUDDY };
