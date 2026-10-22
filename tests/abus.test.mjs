// Lot 3 de l'audit : abus (côté serveur)
import { randomBytes } from 'node:crypto';
process.env.DEMO = '1'; process.env.CERT = 'nope'; process.env.KEY = 'nope';
process.env.POW_BITS = '0'; process.env.POW_BITS_URGENT = '0';
process.argv.push('--port=4503');
const { Config } = await import(new URL('../config.js', import.meta.url));
await import(new URL('../server.js', import.meta.url));
await new Promise((r) => setTimeout(r, 500));
const B = 'http://localhost:4503';
let fails = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} : ${m}`); if (!c) fails++; };
const hex = (n) => randomBytes(n).toString('hex');
const req = async (m, u, b) => {
    const r = await fetch(B + u, { method: m, headers: b ? { 'Content-Type': 'application/json' } : {}, body: b ? JSON.stringify(b) : undefined });
    let j = null; try { j = await r.json(); } catch {}
    return { status: r.status, j };
};
const get = async (id) => (await req('GET', '/api/reports?s=259.176')).j.find((r) => r.id === id);
const report = async (type, lat, lng) => (await req('POST', '/api/reports', { type, lat, lng, voter: hex(16) })).j.id;

// 1. « Ce n'est plus là » : jamais « peut-être terminé » sur une nasse ou une sortie fermée
const nasse = await report('nasse', 48.8601, 2.3401);
const ferme = await report('ferme', 48.8611, 2.3411);
const gaz = await report('gaz', 48.8621, 2.3421);
for (const id of [nasse, ferme, gaz]) for (let i = 0; i < 3; i++) await req('POST', `/api/reports/${id}/gone`, { voter: hex(16) });
ok((await get(nasse)).ended === false, 'nasse : trois « plus là » anonymes ne la font pas passer en « peut-être terminé »');
ok((await get(ferme)).ended === false, 'sortie fermée : idem');
ok((await get(gaz)).ended === true, 'gaz : « peut-être terminé » comme avant');

// 2. Marques de cellule : une marque connue passe même quand elles sont saturées, une nouvelle non
Config.maxCellTags = 2;
const id = await report('charge', 48.8631, 2.3431);
const tagA = hex(8);
await req('POST', `/api/reports/${id}/confirm`, { voter: hex(16), tag: tagA });
await req('POST', `/api/reports/${id}/confirm`, { voter: hex(16), tag: hex(8) });
await req('POST', `/api/reports/${id}/confirm`, { voter: hex(16), tag: hex(8) });
let r = await get(id);
ok(r.tags.length === 2, `marques saturées à 2 : une troisième marque nouvelle refusée (${r.tags.length})`);
await req('POST', `/api/reports/${id}/confirm`, { voter: hex(16), tag: tagA });
ok((await get(id)).tags.includes(tagA), 'un autre membre de la même cellule : sa marque (déjà connue) est acceptée');
Config.maxCellTags = 50;

// 3. Une marque ne vaut que tant que sa propre observation est récente
const id2 = await report('tirs', 48.8641, 2.3441);
const tagB = hex(8);
await req('POST', `/api/reports/${id2}/confirm`, { voter: hex(16), tag: tagB });
ok((await get(id2)).tags.includes(tagB), 'marque fraîche : publiée');
const ttl = Config.reportTtlMin;
Config.reportTtlMin = 0.002; // 120 ms
await new Promise((res) => setTimeout(res, 200));
await req('POST', `/api/reports/${id2}/confirm`, { voter: hex(16) }); // confirmation anonyme : rafraîchit le danger
const r2 = await get(id2);
Config.reportTtlMin = ttl;
ok(r2 && !r2.tags.includes(tagB), 'marque trop ancienne : plus publiée, même si des confirmations anonymes rafraîchissent le danger');

// 4. Le téléphone connaît le plafond des marques
ok((await req('GET', '/api/config')).j.maxCellTags === 50, 'config : maxCellTags publié');

console.log(fails ? `\n${fails} ÉCHEC(S)` : '\nTOUT PASSE');
process.exit(fails ? 1 : 0);
