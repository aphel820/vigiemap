// Lot 1 de l'audit : le serveur ne doit pas pouvoir tomber par la mémoire
import { randomBytes } from 'node:crypto';
process.env.DEMO = '1'; process.env.CERT = 'nope'; process.env.KEY = 'nope';
process.env.POW_BITS = '0'; process.env.POW_BITS_URGENT = '0';
process.argv.push('--port=4501');
const { Config } = await import(new URL('../config.js', import.meta.url));
await import(new URL('../server.js', import.meta.url));
await new Promise((r) => setTimeout(r, 500));
const B = 'http://localhost:4501';
let fails = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} : ${m}`); if (!c) fails++; };
const hex = (n) => randomBytes(n).toString('hex');
const req = async (m, u, b, h = {}) => {
    const r = await fetch(B + u, { method: m, headers: { ...(b ? { 'Content-Type': 'application/json' } : {}), ...h }, body: b ? JSON.stringify(b) : undefined });
    let j = null; try { j = await r.json(); } catch {}
    return { status: r.status, j };
};

// 1. Secteurs inventés : la mémoire ne grossit plus
const randSectors = () => Array.from({ length: 18 }, () => `${100000 + Math.floor(Math.random() * 9e7)}.${Math.floor(Math.random() * 9e7)}`).join(',');
global.gc?.();
const before = process.memoryUsage().heapUsed;
for (let i = 0; i < 3000; i++) await fetch(`${B}/api/reports?s=${randSectors()}`).then((r) => r.arrayBuffer());
global.gc?.();
const grew = (process.memoryUsage().heapUsed - before) / 1e6;
ok(grew < 8, `3 000 lectures de 18 secteurs inventés : tas +${grew.toFixed(1)} Mo (avant le correctif : ~54 000 entrées gardées pour toujours)`);

// 2. Vote sans effet : pas de rediffusion
const s = '259.176';
const ctrl = new AbortController();
const events = [];
const sse = await fetch(`${B}/api/stream?s=${s}`, { signal: ctrl.signal });
const rd = sse.body.getReader();
(async () => { try { for (;;) { const { value, done } = await rd.read(); if (done) break; events.push(new TextDecoder().decode(value)); } } catch {} })();
await new Promise((r) => setTimeout(r, 300));
const v1 = hex(16);
const cr = await req('POST', '/api/reports', { type: 'tension', lat: 48.8601, lng: 2.3401, voter: v1 });
await new Promise((r) => setTimeout(r, 200));
const count = () => events.join('').split('event: report').length - 1;
const c0 = count();
for (let i = 0; i < 5; i++) await req('POST', `/api/reports/${cr.j.id}/confirm`, { voter: v1 });
await new Promise((r) => setTimeout(r, 300));
ok(count() === c0, `5 confirmations du même votant (sans effet) : ${count() - c0} rediffusion(s), attendu 0`);
await req('POST', `/api/reports/${cr.j.id}/confirm`, { voter: hex(16) });
await new Promise((r) => setTimeout(r, 300));
ok(count() === c0 + 1, 'une vraie nouvelle confirmation : rediffusée une fois');
ctrl.abort();

// 3. Empreinte de vote de 64 caractères : refusée
ok((await req('POST', '/api/reports', { type: 'gaz', lat: 48.861, lng: 2.341, voter: hex(32) })).status === 400, 'empreinte de 64 caractères : refusée (16 à 32 seulement)');

// 4. Relais binôme : plafond en nombre de messages, mise à jour toujours possible
Config.maxBuddyEntries = 2;
const member = () => hex(8);
const post = (g, m, tok, blob = 'x'.repeat(40)) => req('POST', `/api/buddy/${g}`, { member: m, blob, token: tok });
const g1 = hex(16), m1 = member(), t1 = hex(16), m2 = member(), t2 = hex(16);
ok((await post(g1, m1, t1)).status === 201 && (await post(hex(16), m2, t2)).status === 201, 'deux messages dans deux groupes : acceptés');
ok((await post(hex(16), member(), hex(16))).status === 503, 'troisième nouveau membre au plafond : refusé (503)');
ok((await post(g1, m1, t1, 'y'.repeat(60))).status === 201, 'au plafond, un membre déjà présent met encore à jour son message (une alarme passe)');
ok((await post(hex(16), member(), hex(16), 'z'.repeat(700))).status === 400, 'message de 700 caractères : refusé (600 au plus)');
Config.maxBuddyEntries = 20000;

// 5. Plafond national : chaque secteur garde des places
Config.maxReports = 1;
const lyon = await req('POST', '/api/reports', { type: 'charge', lat: 45.76, lng: 4.84, voter: hex(16) });
ok(lyon.status === 201, `plafond national atteint : un premier danger à Lyon passe quand même (${lyon.status})`);
Config.minPerSector = 0;
ok((await req('POST', '/api/reports', { type: 'nasse', lat: 43.30, lng: 5.37, voter: hex(16) })).status === 503, 'sans place garantie, il aurait été refusé (contrôle)');
Config.minPerSector = 10; Config.maxReports = 5000;

// 6. Requêtes venues d'un autre site : refusées, sauf l'ouverture de l'appli par un lien
const tile = await fetch(`${B}/tiles/10/518/352.mvt`, { headers: { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'no-cors', 'Sec-Fetch-Dest': 'image' } });
ok(tile.status === 403, 'tuile chargée en image par un autre site : refusée');
const js = await fetch(`${B}/js/app.js`, { headers: { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'no-cors' } });
ok(js.status === 403, 'fichier de l\'appli chargé par un autre site : refusé');
// fetch de Node impose « Sec-Fetch-Mode: cors » : requête brute pour simuler une vraie navigation
const http = await import('node:http');
const navStatus = await new Promise((res) => http.get({ host: 'localhost', port: 4501, path: '/', headers: { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' } }, (r) => { r.resume(); res(r.statusCode); }));
ok(navStatus === 200, 'ouvrir Vigie depuis un lien d\'un autre site : autorisé');
ok((await fetch(`${B}/tiles/10/518/352.mvt`)).status !== 403, 'tuile demandée par l\'appli elle-même : servie');

console.log(fails ? `\n${fails} ÉCHEC(S)` : '\nTOUT PASSE');
process.exit(fails ? 1 : 0);
