// Suite de l'audit : vie privée et robustesse du serveur
import http from 'node:http';
import { randomBytes } from 'node:crypto';

let fails = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} : ${m}`); if (!c) fails++; };

// Horloge réglable (le serveur tourne dans ce processus) et faux service météo
const realNow = Date.now;
let skew = 0;
Date.now = () => realNow() + skew;
const realFetch = globalThis.fetch;
let meteo = 'ok';
let meteoCalls = 0;
globalThis.fetch = (url, opts) => {
    if (String(url).includes('open-meteo')) {
        meteoCalls++;
        if (meteo === 'fail') return Promise.reject(new Error('panne'));
        const cur = meteo === 'bad' ? { wind_direction_10m: 'nord', wind_speed_10m: {} } : { wind_direction_10m: 270, wind_speed_10m: 12.4 };
        return Promise.resolve(new Response(JSON.stringify({ current: cur })));
    }
    return realFetch(url, opts);
};

process.env.CERT = 'nope';
process.env.KEY = 'nope';
process.env.POW_BITS = '8';
process.env.POW_BITS_URGENT = '6';
process.env.MEDIC_CODE = 'code-medic-de-test-solide';
process.argv.push('--port=4408');
const { Config } = await import(new URL('../config.js', import.meta.url));
await import(new URL('../server.js', import.meta.url));
const { solveSync } = await import(new URL('../public/js/pow.js', import.meta.url));
await new Promise((res) => setTimeout(res, 300));

const B = 'http://localhost:4408';
const hex = (n) => randomBytes(n).toString('hex');
const pow = (subject, bits) => {
    const bucket = Math.floor(Date.now() / Config.powWindowMs);
    return `${bucket}.${solveSync(subject, bits, bucket)}`;
};
const req = async (m, u, b, h = {}) => {
    const res = await fetch(B + u, { method: m, headers: { ...(b !== undefined ? { 'Content-Type': 'application/json' } : {}), ...h }, body: b !== undefined ? JSON.stringify(b) : undefined });
    let j = null; try { j = await res.json(); } catch {}
    return { status: res.status, j, headers: res.headers };
};
const report = (type, lat, lng, voter = hex(16)) => req('POST', '/api/reports', { type, lat, lng, voter }, { 'X-Pow': pow(`report|${type}|${lat}|${lng}|${voter}`, 8) });
const vote = (id, kind, voter = hex(16)) => req('POST', `/api/reports/${id}/${kind}`, { voter }, { 'X-Pow': pow(`${kind}|${id}|${voter}`, 8) });
const snapshot = async (s) => {
    const c = new AbortController();
    const r = await fetch(`${B}/api/stream?s=${s}&pow=${pow(`stream|${s}`, 8)}`, { signal: c.signal });
    const rd = r.body.getReader();
    let txt = '';
    while (!/event: snapshot\ndata: .*\n\n/.test(txt)) {
        const { value, done } = await rd.read();
        if (done) break;
        txt += new TextDecoder().decode(value);
    }
    c.abort();
    const m = txt.match(/event: snapshot\ndata: (.*)\n/);
    return m ? JSON.parse(m[1]) : [];
};
const get = async (id) => (await snapshot('259.176')).find((x) => x.id === id);

// 1. En-têtes
const idx = await realFetch(`${B}/`);
ok(idx.headers.get('cross-origin-opener-policy') === 'same-origin', 'Cross-Origin-Opener-Policy: same-origin');
const tag = idx.headers.get('etag');
ok(/^"[A-Za-z0-9_-]{16}"$/.test(tag || ''), `étiquette de cache opaque, sans date en clair : ${tag}`);
ok((await realFetch(`${B}/`, { headers: { 'If-None-Match': tag } })).status === 304, 'revalidation : 304 avec cette étiquette');
const png = await realFetch(`${B}/icon-192.png`);
const ptag = png.headers.get('etag');
ok(/^"[A-Za-z0-9_-]{16}"$/.test(ptag || '') && (await realFetch(`${B}/icon-192.png`, { headers: { 'If-None-Match': ptag } })).status === 304, 'fichier non compressé : étiquette opaque et 304');

// 2. Ce qui est diffusé reste grossier
const a = await report('charge', 48.8601, 2.3501);
let p = await get(a.j.id);
ok(p && p.createdAt === undefined, 'createdAt n\'est plus diffusé');
ok(p && p.updatedAt % 60_000 === 0, 'heure diffusée à la minute près');
for (let i = 0; i < 5; i++) await vote(a.j.id, 'confirm');
p = await get(a.j.id);
ok(p.confirmations === 5, `6 téléphones : affiché « 5 et plus » (${p.confirmations})`);
for (let i = 0; i < 5; i++) await vote(a.j.id, 'confirm');
p = await get(a.j.id);
ok(p.confirmations === 10 && p.confirmed, `11 téléphones : affiché « 10 et plus » (${p.confirmations})`);

// 3. Annulation par l'auteur
const own = await report('tirs', 48.8622, 2.3522);
await vote(own.j.id, 'confirm');
const del = await req('DELETE', `/api/reports/${own.j.id}`, undefined, { 'X-Delete-Token': own.j.deleteToken });
ok(del.status === 409 && (await get(own.j.id)), 'déjà confirmé par d\'autres : l\'auteur ne peut plus l\'effacer (409)');
const solo = await report('gaz', 48.8633, 2.3533);
ok((await req('DELETE', `/api/reports/${solo.j.id}`, undefined, { 'X-Delete-Token': solo.j.deleteToken })).status === 204, 'seul à l\'avoir vu : annulation acceptée');

// 4. Vote en vol pendant l'annulation : le signalement ne revient pas
const g = await report('nasse', 48.8644, 2.3544);
const voter = hex(16);
const body = JSON.stringify({ voter });
const inflight = new Promise((resolve) => {
    const r = http.request(`${B}/api/reports/${g.j.id}/confirm`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'X-Pow': pow(`confirm|${g.j.id}|${voter}`, 8) } }, (res) => { res.resume(); resolve(res.statusCode); });
    r.flushHeaders();
    setTimeout(async () => {
        await req('DELETE', `/api/reports/${g.j.id}`, undefined, { 'X-Delete-Token': g.j.deleteToken });
        r.end(body);
    }, 150);
});
const st = await inflight;
ok(st === 404 && !(await get(g.j.id)), `vote arrivé après l'annulation : 404, et rien ne réapparaît (${st})`);

// 4 bis. Fenêtre de la preuve de travail : une d'avance acceptée, deux refusées, deux de retard refusées
const powAt = (subject, bits, shift) => {
    const bucket = Math.floor(Date.now() / Config.powWindowMs) + shift;
    return `${bucket}.${solveSync(subject, bits, bucket)}`;
};
const tryShift = async (shift) => {
    const v = hex(16);
    const lat = 48.87 + Math.random() / 100;
    return (await req('POST', '/api/reports', { type: 'gaz', lat, lng: 2.36, voter: v }, { 'X-Pow': powAt(`report|gaz|${lat}|2.36|${v}`, 8, shift) })).status;
};
ok((await tryShift(1)) === 201, 'téléphone un peu en avance (fenêtre suivante) : accepté');
ok((await tryShift(2)) === 429, 'deux fenêtres d\'avance : refusé');
ok((await tryShift(-2)) === 429, 'deux fenêtres de retard : refusé');

// 4 ter. Lot A : marque recopiée, iframes d'autres sites
const tv = await report('ferme', 48.8655, 2.3555);
const tagT = hex(8);
const member = hex(16);
await req('POST', `/api/reports/${tv.j.id}/confirm`, { voter: member, tag: tagT }, { 'X-Pow': pow(`confirm|${tv.j.id}|${member}`, 8) });
ok((await get(tv.j.id))?.tags.includes(tagT), 'marque de cellule posée');
skew += 20 * 60_000;
const copier = hex(16);
await req('POST', `/api/reports/${tv.j.id}/confirm`, { voter: copier, tag: tagT }, { 'X-Pow': pow(`confirm|${tv.j.id}|${copier}`, 8) });
skew += 6 * 60_000;
const tvp = await get(tv.j.id);
ok(tvp && !tvp.tags.includes(tagT), 'marque recopiée 20 min plus tard : pas rafraîchie, plus publiée après 25 min');
// http brut : le fetch de Node impose son propre Sec-Fetch-Mode
const rawGet = (path, headers) => new Promise((resolve) => http.get(`${B}${path}`, { headers }, (res) => { res.resume(); resolve(res.statusCode); }));
const frame = await rawGet('/icon-192.png', { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'iframe' });
ok(frame === 403, `navigation dans une iframe d'un autre site : refusée (${frame})`);
const top = await rawGet('/', { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' });
ok(top === 200, `ouvrir Vigie depuis un lien (page entière) : accepté (${top})`);

// 5. Vent
const wind = async () => (await req('GET', '/api/wind?s=259.176')).j;
meteo = 'fail';
ok((await wind()).unavailable === true && meteoCalls === 1, 'panne météo au premier relevé : pas de vent');
await wind();
ok(meteoCalls === 1, 'pas de nouvel appel dans la minute qui suit');
skew += 61_000;
meteo = 'ok';
let w = await wind();
ok(w.fromDeg === 270 && w.speedKmh === 12 && meteoCalls === 2, 'une minute plus tard : nouvel essai, vent revenu');
skew += 11 * 60_000;
meteo = 'bad';
w = await wind();
ok(w.fromDeg === 270 && meteoCalls === 3, 'réponse inattendue : ignorée, la dernière valeur reste');
skew += 31 * 60_000;
meteo = 'fail';
ok((await wind()).unavailable === true, 'relevé de plus de 30 min : plus servi comme actuel');
// Secteur écrit autrement : même relevé, pas un appel de plus au service météo
skew += 61_000;
meteo = 'ok';
await wind();
const callsBefore = meteoCalls;
const padded = (await req('GET', '/api/wind?s=0259.0176')).j;
ok(padded.fromDeg === 270 && meteoCalls === callsBefore, `« 0259.0176 » = « 259.176 » : aucun appel en plus (${meteoCalls - callsBefore})`);
ok((await req('GET', '/api/wind?s=9999.1')).j.unavailable === true, 'secteur hors de la grille : refusé');

console.log(fails ? `\n${fails} ÉCHEC(S)` : '\nTOUT PASSE');
process.exit(fails ? 1 : 0);
