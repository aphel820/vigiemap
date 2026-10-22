import { createHmac, randomBytes } from 'node:crypto';

// Modèle « confiance locale » : cellules libres, marques relayées par le serveur
process.env.DEMO = '1';
process.env.CERT = 'nope';
process.env.KEY = 'nope';
process.env.POW_BITS = '0';
process.env.POW_BITS_URGENT = '0';
process.argv.push('--port=4404');
await import(new URL('../server.js', import.meta.url));
await new Promise((r) => setTimeout(r, 400));

const B = 'http://localhost:4404';
let fails = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} : ${m}`); if (!c) fails++; };
const req = async (m, u, b) => {
    const r = await fetch(B + u, { method: m, headers: b ? { 'Content-Type': 'application/json' } : {}, body: b ? JSON.stringify(b) : undefined });
    let j = null; try { j = await r.json(); } catch {}
    return { status: r.status, j };
};
const hex = (n) => randomBytes(n).toString('hex');
// Même calcul que le téléphone : HMAC(clé, "vigie:vu:" + id), 8 octets
const tagOf = (key, id) => createHmac('sha256', key).update(`vigie:vu:${id}`).digest('hex').slice(0, 16);
const cellA = { id: hex(4), key: hex(10) };
const cellB = { id: hex(4), key: hex(10) };
const get = async (id) => (await req('GET', '/api/reports?s=259.176')).j.find((r) => r.id === id);

// config : plus de seuil « vérifié » ni de code graine
const conf = (await req('GET', '/api/config')).j;
ok(!('cellVerifyThreshold' in conf) && !('demoSeedCode' in conf), 'config sans seuil vérifié ni code graine');

// les routes de l'ancien modèle n'existent plus
ok((await req('POST', '/api/cell', {})).status === 404, 'plus de création de cellule côté serveur');
ok((await req('GET', '/api/org/key')).status === 404, 'plus de route organisateur');
ok((await req('POST', '/api/cell/check', {})).status === 404, 'plus de vérification de cellule');

// signalement puis marque (l'id n'est connu qu'après)
const v1 = hex(16);
const cr = await req('POST', '/api/reports', { type: 'charge', lat: 48.8675, lng: 2.3637, voter: v1 });
ok(cr.status === 201, 'signalement créé');
const id = cr.j.id;
ok((await req('POST', `/api/reports/${id}/tag`, { voter: v1, tag: tagOf(cellA.key, id) })).status === 204, 'marque posée par l\'auteur');
let r = await get(id);
ok(r.tags.length === 1 && r.tags[0] === tagOf(cellA.key, id), 'la marque est relayée telle quelle');
ok(!('cells' in r) && !('verified' in r), 'plus de compte de cellules ni de « vérifié » global');
ok((await req('POST', `/api/reports/${id}/tag`, { voter: v1, tag: tagOf(cellB.key, id) })).status === 409, 'une seule marque par votant');
ok((await req('POST', `/api/reports/${id}/tag`, { voter: hex(16), tag: tagOf(cellB.key, id) })).status === 409, 'marque refusée pour un votant pas compté');
ok((await req('POST', `/api/reports/${id}/tag`, { voter: v1, tag: 'zz' })).status === 409, 'marque mal formée refusée');

// confirmations avec marque
const v2 = hex(16);
await req('POST', `/api/reports/${id}/confirm`, { voter: v2, tag: tagOf(cellA.key, id) });
r = await get(id);
ok(r.confirmations === 2 && r.tags.length === 1, 'même cellule : une seule marque (dédoublonnée), deux personnes');
const v3 = hex(16);
await req('POST', `/api/reports/${id}/confirm`, { voter: v3, tag: tagOf(cellB.key, id) });
r = await get(id);
ok(r.tags.length === 2, 'deuxième cellule : deuxième marque');

// reconnaissance locale : chaque cellule ne reconnaît que la sienne
ok(r.tags.includes(tagOf(cellA.key, id)) && r.tags.includes(tagOf(cellB.key, id)), 'A et B se reconnaissent');
ok(!r.tags.includes(tagOf(hex(10), id)), 'une cellule étrangère ne se reconnaît pas');

// une marque recopiée sur un autre signalement ne vaut rien pour les membres
const v4 = hex(16);
const other = (await req('POST', '/api/reports', { type: 'gaz', lat: 48.869, lng: 2.36, voter: v4 })).j.id;
await req('POST', `/api/reports/${other}/tag`, { voter: v4, tag: tagOf(cellA.key, id) });
const o = await get(other);
ok(o.tags.length === 1 && !o.tags.includes(tagOf(cellA.key, other)), 'marque recopiée : A ne la reconnaît pas sur l\'autre signalement');

// plafond de marques par signalement
const capId = (await req('POST', '/api/reports', { type: 'eau', lat: 48.866, lng: 2.37, voter: hex(16) })).j.id;
const { Config } = await import(new URL('../config.js', import.meta.url));
for (let i = 0; i < 45; i++) await req('POST', `/api/reports/${capId}/confirm`, { voter: hex(16), tag: hex(8) });
ok((await get(capId)).tags.length === 45, `confirmations payées : marquées même au-delà du plafond de ${Config.maxVoters} votants (de faux votants ne bloquent pas les vrais membres)`);
for (let i = 0; i < 20; i++) await req('POST', `/api/reports/${capId}/confirm`, { voter: hex(16), tag: hex(8) });
ok((await get(capId)).tags.length === Config.maxCellTags, `plafond de ${Config.maxCellTags} marques par signalement respecté`);

// code court : le téléphone confie la cellule, un autre la récupère
const p1 = await req('POST', '/api/cell/pair', cellA);
ok(p1.status === 201 && /^[0-9A-Z]{8}$/.test(p1.j.pin), `code court créé (${p1.j?.pin})`);
const p2 = await req('POST', '/api/cell/pair', cellA);
ok(p2.j.pin === p1.j.pin, 'même cellule : même code (réutilisable)');
const cl = await req('POST', '/api/cell/claim', { pin: p1.j.pin.toLowerCase().replace(/(.{4})/, '$1-') });
ok(cl.j?.id === cellA.id && cl.j?.key === cellA.key, 'code court -> même cellule');
ok((await req('POST', '/api/cell/pair', { id: 'xyz', key: cellA.key })).status === 400, 'cellule mal formée refusée');

console.log(fails ? `\n${fails} ÉCHEC(S)` : '\nTOUT PASSE');
process.exit(fails ? 1 : 0);
