import { fileURLToPath } from 'node:url';
import { randomBytes, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

// Vérifie que chaque constat de l'audit est fermé (serveur hors démo, preuves de travail légères)
const SERVER = fileURLToPath(new URL('../server.js', import.meta.url));
let fails = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} : ${m}`); if (!c) fails++; };

// --- refus de démarrer (processus séparés)
const start = (env) => spawnSync(process.execPath, [SERVER, '--port=4499'], { env: { ...process.env, CERT: 'nope', KEY: 'nope', ...env }, timeout: 15000, encoding: 'utf8' });
let r = start({ MEDIC_CODE: '' });
ok(r.status === 1 && /MEDIC_CODE/.test(r.stderr), 'sans MEDIC_CODE : refuse de démarrer');
r = start({ MEDIC_CODE: 'a-remplacer' });
ok(r.status === 1, 'MEDIC_CODE « a-remplacer » : refuse de démarrer');
r = start({ MEDIC_CODE: 'court' });
ok(r.status === 1, 'MEDIC_CODE trop court : refuse de démarrer');
r = start({ MEDIC_CODE: 'x'.repeat(24), POW_BITS: '' });
ok(r.status === 1 && /POW_BITS/.test(r.stderr), 'POW_BITS vide : refuse de démarrer (ne coupe plus la protection)');
r = start({ MEDIC_CODE: 'x'.repeat(24), PMTILES: '/nexistepas/carte.pmtiles' });
ok(r.status === 1 && /carte/.test(r.stderr), 'carte illisible : refuse de démarrer (plus de repli muet)');

// --- serveur de test dans ce processus
process.env.CERT = 'nope';
process.env.KEY = 'nope';
process.env.POW_BITS = '8';
process.env.POW_BITS_URGENT = '6';
process.env.MEDIC_CODE = 'code-medic-de-test-solide';
process.argv.push('--port=4407');
const { Config } = await import(new URL('../config.js', import.meta.url));
await import(new URL('../server.js', import.meta.url));
const { solveSync } = await import(new URL('../public/js/pow.js', import.meta.url));
await new Promise((res) => setTimeout(res, 300));

const B = 'http://localhost:4407';
const hex = (n) => randomBytes(n).toString('hex');
const pow = (subject, bits) => {
    const bucket = Math.floor(Date.now() / Config.powWindowMs);
    return `${bucket}.${solveSync(subject, bits, bucket)}`;
};
const req = async (m, u, b, h = {}, ct = 'application/json') => {
    const res = await fetch(B + u, { method: m, headers: { ...(b !== undefined ? { 'Content-Type': ct } : {}), ...h }, body: b !== undefined ? (typeof b === 'string' ? b : JSON.stringify(b)) : undefined });
    let j = null; try { j = await res.json(); } catch {}
    return { status: res.status, j, headers: res.headers };
};
const report = (type, lat, lng, voter = hex(16)) => req('POST', '/api/reports', { type, lat, lng, voter }, { 'X-Pow': pow(`report|${type}|${lat}|${lng}|${voter}`, 8) });
const vote = (id, kind, voter = hex(16)) => req('POST', `/api/reports/${id}/${kind}`, { voter }, { 'X-Pow': pow(`${kind}|${id}|${voter}`, 8) });
const help = (type, lat, lng, withPow = true) => req('POST', '/api/help', { type, lat, lng }, withPow ? { 'X-Pow': pow(`help|${type}|${lat}|${lng}`, 6) } : {});
// Hors démo, plus de lecture directe : la photo d'un secteur se lit au début du flux (preuve légère)
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

// 1. Aide : preuve de travail légère, refus au plafond, jamais d'éviction
ok((await help('blesse', 48.86, 2.35, false)).status === 429, 'aide sans preuve de travail : refusée');
const h1 = await help('blesse', 48.86, 2.35);
ok(h1.status === 201, 'aide avec preuve légère : acceptée');
Config.maxHelpsPerSector = 3;
await help('gaze', 48.861, 2.351); await help('malaise', 48.862, 2.352);
const full = await help('isole', 48.863, 2.353);
ok(full.status === 503 && /112/.test(full.j?.error), 'aide au plafond du secteur : refus 503 qui rappelle le 112');
const own = await req('GET', `/api/help/${h1.j.id}`, undefined, { 'X-Owner-Token': h1.j.ownerToken });
ok(own.status === 200, 'la première demande est toujours là (pas d\'éviction par un flood)');
ok((await help('blesse', 45.76, 4.83)).status === 201, 'autre secteur (Lyon) : non touché par la saturation de Paris');
const medic = await req('GET', '/api/help?s=259.176', undefined, { 'X-Medic-Code': Config.medicCode || 'code-medic-de-test-solide' });
ok(medic.status === 200 && medic.j.length === 3, `medic : voit les 3 demandes de son secteur (${medic.j?.length})`);

// 2. Binôme : adresse longue, preuve de travail, refus au plafond
ok((await req('GET', `/api/buddy/${hex(4)}`)).status === 404, 'ancienne adresse courte (4 octets) : refusée');
const relay = hex(16);
const member = hex(8);
const token = hex(16);
ok((await req('POST', `/api/buddy/${relay}`, { member, blob: 'x'.repeat(40), token })).status === 429, 'binôme sans preuve : refusé');
ok((await req('POST', `/api/buddy/${relay}`, { member, blob: 'x'.repeat(40) }, { 'X-Pow': pow(`buddy|${relay}|${member}`, 6) })).status === 400, 'binôme sans jeton d\x27écriture : refusé');
ok((await req('POST', `/api/buddy/${relay}`, { member, blob: 'x'.repeat(40), token }, { 'X-Pow': pow(`buddy|${relay}|${member}`, 6) })).status === 201, 'binôme avec preuve légère : accepté');
ok((await req('POST', `/api/buddy/${relay}`, { member, blob: 'y'.repeat(40), token: hex(16) }, { 'X-Pow': pow(`buddy|${relay}|${member}`, 6) })).status === 403, 'autre téléphone avec le même membre : ne peut pas écraser le message (403)');
ok((await req('POST', `/api/buddy/${relay}`, { member, blob: 'z'.repeat(40), token }, { 'X-Pow': pow(`buddy|${relay}|${member}`, 6) })).status === 201, 'le bon téléphone remplace son propre message');
Config.maxBuddyEntries = 1;
const relay2 = hex(16);
ok((await req('POST', `/api/buddy/${relay2}`, { member, blob: 'x'.repeat(40), token }, { 'X-Pow': pow(`buddy|${relay2}|${member}`, 6) })).status === 503, 'binômes au plafond : nouveau refusé (503)');
ok((await req('GET', `/api/buddy/${relay}`)).j.length === 1, 'le binôme existant est intact (pas d\'éviction)');

// 3. Signalements : refus au plafond du secteur, votant mal formé, « plus là » n'efface plus
Config.maxReportsPerSector = 2;
const a = await report('charge', 48.85, 2.34);
const b = await report('nasse', 48.852, 2.342);
ok(a.status === 201 && b.status === 201, 'deux signalements acceptés');
ok((await report('gaz', 48.854, 2.344)).status === 503, 'troisième dans le même secteur : refusé (503), pas d\'éviction');
ok(await get(a.j.id), 'le premier est toujours sur la carte');
const arr = await req('POST', '/api/reports', { type: 'eau', lat: 45.75, lng: 4.85, voter: [hex(16)] }, { 'X-Pow': '0.0' });
ok(arr.status === 400, 'votant envoyé sous forme de tableau : refusé');
for (let i = 0; i < 3; i++) await vote(a.j.id, 'confirm');
for (let i = 0; i < 6; i++) await vote(a.j.id, 'gone');
const ga = await get(a.j.id);
ok(ga && ga.ended === true, 'six « plus là » : le danger reste visible, marqué « peut-être terminé »');
await vote(a.j.id, 'confirm');
ok((await get(a.j.id)).ended === false, 'une nouvelle confirmation remet « terminé » à zéro');
Config.maxReportsPerSector = 200;
const merged = await report('charge', 48.8505, 2.34);   // carré voisin au nord (~56 m) : fusion
const far = await report('charge', 48.851, 2.341);      // ~130 m : la rue d'à côté, plus de fusion
ok(merged.j?.merged === true && merged.j.id === a.j.id, 'carré voisin (56 m), même type : fusionné');
ok(far.status === 201 && far.j?.merged === false, 'à 130 m : plus fusionné (avant : jusqu\'à 120 m)');

// 4. Flux temps réel : secteurs obligatoires, plafond
ok((await fetch(`${B}/api/stream`)).status === 400, 'flux sans secteurs : refusé (jamais toute la France)');
Config.maxStreams = 1;
const c1 = new AbortController();
ok((await fetch(`${B}/api/stream?s=259.176`)).status === 429, 'flux sans preuve de travail : refusé');
const streamPow = pow('stream|259.176', 8);
const s1 = await fetch(`${B}/api/stream?s=259.176&pow=${streamPow}`, { signal: c1.signal });
ok(s1.status === 200, 'premier flux accepté (avec preuve)');
ok((await fetch(`${B}/api/stream?s=259.176&pow=${streamPow}`)).status === 429, 'même preuve rejouée : refusée');
ok((await fetch(`${B}/api/stream?s=259.176&pow=${pow('stream|259.176', 8)}`)).status === 503, 'flux au plafond : refusé (503)');
c1.abort();
Config.maxStreams = 20000;

// 5. Formulaires d'autres sites, fichiers non prévus, en-têtes
const plain = await req('POST', '/api/help', JSON.stringify({ type: 'blesse', lat: 48.86, lng: 2.35 }), { 'X-Pow': pow('help|blesse|48.86|2.35', 6) }, 'text/plain');
ok(plain.status === 400, 'corps en text/plain (formulaire d\'un autre site) : refusé');
ok((await fetch(`${B}/js/app.js.bak4`)).status === 404, 'fichier .bak : jamais servi');
ok((await fetch(`${B}/.env`)).status === 404, 'fichier caché : jamais servi');
const page = await fetch(`${B}/`);
const csp = page.headers.get('content-security-policy') || '';
ok(csp.includes("form-action 'self'") && csp.includes("base-uri 'none'"), 'CSP : form-action et base-uri');
const conf = (await req('GET', '/api/config')).j;
ok(conf.powBitsUrgent === 6 && !('demoMedicCode' in conf && conf.demoMedicCode), 'config : difficulté urgente publiée, aucun code medic exposé');

// 6. Codes courts : preuve de travail, pas de prolongation
const cell = { id: hex(4), key: hex(10) };
ok((await req('POST', '/api/cell/pair', cell)).status === 429, 'code court sans preuve : refusé');
const pr = await req('POST', '/api/cell/pair', cell, { 'X-Pow': pow(`pair|${cell.id}`, 8) });
ok(pr.status === 201, 'code court avec preuve : créé');
ok((await req('POST', '/api/cell/claim', { pin: pr.j.pin })).status === 429, 'essai de code sans preuve : refusé (force brute hors de portée)');
const norm = pr.j.pin.toUpperCase();
const cl = await req('POST', '/api/cell/claim', { pin: pr.j.pin.toLowerCase() }, { 'X-Pow': pow(`claim|${norm}`, 8) });
ok(cl.j?.key === cell.key, 'essai avec preuve : bonne cellule');

// 6 bis. Deuxième audit : lecture par secteur, autres sites, effacement, tuiles sans date
ok((await req('GET', '/api/reports?s=259.176')).status === 404, 'lecture directe des signalements hors démo : introuvable (tout passe par le flux, avec preuve)');
ok((await req('GET', '/api/help', undefined, { 'X-Medic-Code': 'code-medic-de-test-solide' })).status === 400, 'liste medic sans secteur : refusée');
ok((await req('GET', '/api/config', undefined, { 'Sec-Fetch-Site': 'cross-site' })).status === 403, 'requête venue d\'un autre site : refusée');
const eff = await fetch(`${B}/api/efface`, { method: 'POST' });
ok(eff.status === 204 && /storage/.test(eff.headers.get('clear-site-data') || ''), 'effacement : Clear-Site-Data envoyé');
const tile = await fetch(`${B}/tiles/14/8299/5636.mvt`);
ok(tile.headers.get('cache-control') === 'no-store' && !tile.headers.get('date'), `tuile : no-store et sans date (${tile.status})`);
ok(conf.now > 0 && Math.abs(conf.now - Date.now()) < 5000, 'config : heure du serveur publiée (horloge du téléphone recalée)');

// 6 ter. Anti-rejeu plein : les plus anciennes sortent, aucune preuve valide n'est refusée
Config.maxPowSeen = 4;
Config.maxHelpsPerSector = 3000;
let allIn = true;
for (let i = 0; i < 8; i++) allIn = (await help('blesse', 43.3 + i / 1000, 5.37)).status === 201 && allIn;
ok(allIn, 'anti-rejeu au plafond : 8 demandes d\'aide valides de suite, toutes acceptées');
Config.maxPowSeen = 2_000_000;

// 7. Vent : seulement dans les zones couvertes
ok((await req('GET', '/api/wind?s=0.0')).j?.unavailable === true, 'vent d\'un secteur hors zone (au milieu de l\'océan) : refusé');

console.log(fails ? `\n${fails} ÉCHEC(S)` : '\nTOUT PASSE');
process.exit(fails ? 1 : 0);
