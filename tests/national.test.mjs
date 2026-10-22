import { randomBytes } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Échelle nationale : carte vectorielle de France, zones, secteurs
process.env.CERT = 'nope';
process.env.KEY = 'nope';
process.env.POW_BITS = '0';
process.env.POW_BITS_URGENT = '0';
process.env.MEDIC_CODE = 'code-medic-de-test-solide';
process.argv.push('--port=4405');
const t0 = Date.now();
await import(new URL('../server.js', import.meta.url));
await new Promise((r) => setTimeout(r, 300));
const startMs = Date.now() - t0;

const B = 'http://localhost:4405';
let fails = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} : ${m}`); if (!c) fails++; };
const hex = (n) => randomBytes(n).toString('hex');
const req = async (m, u, b) => {
    const r = await fetch(B + u, { method: m, headers: b ? { 'Content-Type': 'application/json' } : {}, body: b ? JSON.stringify(b) : undefined });
    let j = null; try { j = await r.json(); } catch {}
    return { status: r.status, j };
};
const sector = (lat, lng, z = 9) => {
    const n = 2 ** z; const r = lat * Math.PI / 180;
    return `${Math.floor((lng + 180) / 360 * n)}.${Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n)}`;
};
const tileXY = (lat, lng, z) => sector(lat, lng, z).split('.').map(Number);

const conf = (await req('GET', '/api/config')).j;
ok(conf.zoom === 6 && Math.abs(conf.center[0] - 46.6) < 0.1, 'vue de départ : la France');

// Carte de France : seulement si elle est là (npm run carte, 3,8 Go). Sans elle (copie neuve,
// intégration continue), ces contrôles sautent ; jamais de repli sur les tuiles d'OpenStreetMap ici.
if (!existsSync(fileURLToPath(new URL('../tiles.pmtiles', import.meta.url)))) {
    console.log('SAUT : carte de France absente (tiles.pmtiles), contrôles des tuiles ignorés');
} else {
    ok(startMs < 3000, `démarrage avec l'archive de plusieurs Go en ${startMs} ms (lecture par plages)`);
    const zmax = conf.tiles.maxZoom;
    ok(conf.tiles.type === 'vector' && zmax >= 14, `carte vectorielle, zooms ${conf.tiles.minZoom} à ${zmax}`);
    // tuiles vectorielles : Paris, Lyon, Réunion, la mer
    for (const [nom, lat, lng] of [['Paris', 48.8675, 2.3637], ['Lyon', 45.764, 4.8357], ['Saint-Denis (Réunion)', -20.879, 55.448], ['Ajaccio', 41.92, 8.74]]) {
        const [x, y] = tileXY(lat, lng, zmax);
        const t1 = Date.now();
        const r = await fetch(`${B}/tiles/${zmax}/${x}/${y}.mvt`, { headers: { 'Accept-Encoding': 'identity' } });
        const raw = Buffer.from(await r.arrayBuffer());
        const enc = r.headers.get('content-encoding');
        // fetch de Node décompresse déjà selon Content-Encoding ; on vérifie que c'est bien du MVT (protobuf)
        const body = raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw) : raw;
        const looksMvt = body[0] === 0x1a; // champ 3 (layer), type longueur
        ok(r.status === 200 && enc === 'gzip' && looksMvt, `tuile ${nom} z${zmax} : ${r.status}, ${enc}, ${Math.round(body.length / 1024)} Ko décompressés, ${Date.now() - t1} ms`);
    }
    const [mx, my] = tileXY(45.5, -8.0, 12); // plein Atlantique
    ok((await fetch(`${B}/tiles/12/${mx}/${my}.mvt`)).status === 204, 'tuile en pleine mer : vide (204)');
    ok((await fetch(`${B}/tiles/0/0/0.mvt`)).status === 200, 'tuile monde z0 servie (vue nationale)');
}

// zones : France oui, ailleurs non
const report = (lat, lng, type = 'charge') => req('POST', '/api/reports', { type, lat, lng, voter: hex(16) });
const paris = await report(48.8675, 2.3637);
const lyon = await report(45.764, 4.8357, 'gaz');
ok(paris.status === 201 && lyon.status === 201, 'signalements acceptés à Paris et à Lyon');
ok((await report(-20.879, 55.448)).status === 201, 'signalement accepté à La Réunion');
ok((await report(51.5074, -0.1278)).status === 400, 'signalement refusé à Londres (hors zone)');
ok((await report(40.4168, -3.7038)).status === 400, 'signalement refusé à Madrid (hors zone)');

// secteurs : on ne reçoit que ce qu'on regarde
const sP = sector(48.8675, 2.3637);
const sL = sector(45.764, 4.8357);
// Hors démo, la photo d'un secteur se lit au début du flux (preuve à 0 bit dans ce test)
const snapshotOf = async (s) => {
    const c = new AbortController();
    const r = await fetch(`${B}/api/stream?s=${s}`, { signal: c.signal });
    const rd = r.body.getReader();
    let txt = '';
    while (!/event: snapshot\ndata: .*\n\n/.test(txt)) { const { value, done } = await rd.read(); if (done) break; txt += new TextDecoder().decode(value); }
    c.abort();
    return JSON.parse(txt.match(/event: snapshot\ndata: (.*)\n/)[1]);
};
const onlyParis = await snapshotOf(sP);
ok(onlyParis.some((r) => r.id === paris.j.id) && !onlyParis.some((r) => r.id === lyon.j.id), `photo par secteur : Paris sans Lyon (${onlyParis.length})`);
ok((await req('GET', `/api/reports?s=${sP}`)).status === 404, 'lecture directe hors démo : introuvable');

// flux : un téléphone à Lyon ne reçoit pas les évènements de Paris
const ctrl = new AbortController();
const events = [];
const sse = await fetch(`${B}/api/stream?s=${sL}`, { signal: ctrl.signal });
const reader = sse.body.getReader();
(async () => { try { for (;;) { const { value, done } = await reader.read(); if (done) break; events.push(new TextDecoder().decode(value)); } } catch {} })();
await new Promise((r) => setTimeout(r, 300));
const snap = events.join('');
ok(snap.includes(lyon.j.id) && !snap.includes(paris.j.id), 'flux Lyon : la photo de départ ne contient que Lyon');
const paris2 = await report(48.85, 2.35, 'eau');
const lyon2 = await report(45.75, 4.85, 'nasse');
await new Promise((r) => setTimeout(r, 300));
const all = events.join('');
ok(all.includes(lyon2.j.id) && !all.includes(paris2.j.id), 'flux Lyon : reçoit le nouveau danger de Lyon, pas celui de Paris');
ctrl.abort();

// demandes d'aide : un medic ne voit que son secteur (code medic affiché au démarrage, ici celui de la démo absent)
ok((await req('GET', `/api/wind?s=${sP}`)).status === 200, 'vent par secteur : réponse');
ok((await req('GET', '/api/wind?s=zz')).j?.unavailable === true, 'vent : secteur invalide refusé proprement');

console.log(fails ? `\n${fails} ÉCHEC(S)` : '\nTOUT PASSE');
process.exit(fails ? 1 : 0);
