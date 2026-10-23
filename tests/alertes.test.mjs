import http from 'node:http';
import { createPublicKey, verify, randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Alertes en poche des medics : envoi vide et signé (VAPID), seulement vers les services de
// notification autorisés, pas pour une demande annulée, au plus une par minute, abonnement mort oublié
let fails = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} : ${m}`); if (!c) fails++; };

// Faux service de notification : note chaque envoi ; « /mort » répond 410 (abonnement abandonné)
const got = [];
const svc = http.createServer((req, res) => {
    let len = 0;
    req.on('data', (c) => { len += c.length; });
    req.on('end', () => {
        got.push({ path: req.url, method: req.method, headers: req.headers, len });
        res.writeHead(req.url === '/mort' ? 410 : req.url === '/vieille-cle' ? 403 : 201);
        res.end();
    });
});
await new Promise((r) => svc.listen(4413, '127.0.0.1', r));
const SVC = 'http://127.0.0.1:4413';

process.env.CERT = 'nope';
process.env.KEY = 'nope';
process.env.POW_BITS = '8';
process.env.POW_BITS_URGENT = '6';
process.env.MEDIC_CODE = 'code-medic-de-test-solide';
const dir = mkdtempSync(path.join(tmpdir(), 'vigie-alertes-'));
const LIST = path.join(dir, 'medics.txt');
process.env.MEDIC_LIST = LIST;
process.env.PUSH_HOSTS = '127.0.0.1';
process.env.PUSH_INSECURE_TEST = '1';
process.argv.push('--port=4412');
const { Config } = await import(new URL('../config.js', import.meta.url));
await import(new URL('../server.js', import.meta.url));
const { solveSync } = await import(new URL('../public/js/pow.js', import.meta.url));
await new Promise((res) => setTimeout(res, 300));
Config.pushDelayMs = 200;

const B = 'http://localhost:4412';
const MEDIC = { 'X-Medic-Code': 'code-medic-de-test-solide' };
const wait = (ms) => new Promise((res) => setTimeout(res, ms));
const req = async (m, u, b, h = {}) => {
    const res = await fetch(B + u, { method: m, headers: { ...(b !== undefined ? { 'Content-Type': 'application/json' } : {}), ...h }, body: b !== undefined ? JSON.stringify(b) : undefined });
    let j = null; try { j = await res.json(); } catch {}
    return { status: res.status, j };
};
const help = async (lat, lng) => {
    const bucket = Math.floor(Date.now() / Config.powWindowMs);
    const pow = `${bucket}.${solveSync(`help|blesse|${lat}|${lng}`, 6, bucket)}`;
    return (await req('POST', '/api/help', { type: 'blesse', lat, lng }, { 'X-Pow': pow })).j;
};
const subscribe = (endpoint, headers = MEDIC, s = '259.176') => req('POST', `/api/push?s=${s}`, { endpoint }, headers);

// 1. Inscription : medics seulement, services de notification autorisés seulement
const cfg = (await req('GET', '/api/config')).j;
ok(/^[A-Za-z0-9_-]{87}$/.test(cfg.vapidKey || ''), 'la clé publique VAPID est donnée par /api/config (65 octets)');
ok((await subscribe(`${SVC}/abo1`, {})).status === 403, 'sans code medic : inscription refusée');
ok((await subscribe('https://exemple.org/abo')).status === 400, 'adresse d\'alerte hors des services de notification : refusée');
ok((await subscribe('http://localhost:4412/api/config')).status === 400, 'adresse vers le serveur lui-même : refusée');
ok((await subscribe(`${SVC}/abo1`, MEDIC, '')).status === 400, 'sans secteurs : refusée');
ok((await subscribe(`${SVC}/abo1`)).status === 200, 'medic, service autorisé, secteur de Paris : inscrit');

// 2. Une demande dans le secteur : une alerte vide et signée, après le délai d'annulation
await help(48.86, 2.35);
ok(got.length === 0, 'rien ne part tout de suite (le temps d\'annuler une demande touchée par erreur)');
await wait(500);
ok(got.length === 1 && got[0].path === '/abo1' && got[0].method === 'POST', 'une alerte envoyée à l\'abonné du secteur');
const a = got[0]?.headers || {};
ok(got[0]?.len === 0 && a['content-length'] === '0', 'l\'alerte est vide : ni lieu, ni besoin');
ok(a.ttl === '600' && a.urgency === 'high', 'TTL 10 min, urgence haute');
const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(a.authorization || '');
ok(Boolean(m) && m[4] === cfg.vapidKey, 'signée VAPID, avec la clé publique du serveur');
if (m) {
    const head = JSON.parse(Buffer.from(m[1], 'base64url'));
    const claims = JSON.parse(Buffer.from(m[2], 'base64url'));
    const pub = Buffer.from(m[4], 'base64url');
    const key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') }, format: 'jwk' });
    const good = verify('sha256', Buffer.from(`${m[1]}.${m[2]}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(m[3], 'base64url'));
    ok(head.alg === 'ES256' && good, 'signature ES256 valide');
    const t = Math.floor(Date.now() / 1000);
    ok(claims.aud === SVC && claims.exp > t && claims.exp <= t + 3600 && claims.sub === 'mailto:contact@vigiemap.org', 'audience = le service, expiration sous une heure, contact du projet');
}

// 3. Au plus une alerte par minute pour un même téléphone
await help(48.861, 2.351);
await wait(500);
ok(got.length === 1, 'deuxième demande dans la minute : pas de deuxième alerte');

// 4. Autre secteur : rien ; demande annulée avant le délai : rien
Config.pushMinGapMs = 0;
await help(45.76, 4.83);
await wait(500);
ok(got.length === 1, 'demande à Lyon : pas d\'alerte pour un medic inscrit à Paris');
const h = await help(48.862, 2.352);
await req('DELETE', `/api/help/${h.id}`, undefined, { 'X-Owner-Token': h.ownerToken });
await wait(500);
ok(got.length === 1, 'demande annulée tout de suite : pas d\'alerte');

// 5. Abonnement mort (le service répond 410) : oublié après le premier essai
ok((await subscribe(`${SVC}/mort`)).status === 200, 'second abonné inscrit');
await help(48.863, 2.353);
await wait(500);
const n = got.length;
ok(got.some((g) => g.path === '/mort'), 'alerte tentée vers l\'abonnement mort');
await help(48.864, 2.354);
await wait(500);
ok(got.slice(n).every((g) => g.path !== '/mort') && got.slice(n).some((g) => g.path === '/abo1'), 'abonnement mort oublié, l\'autre reçoit toujours');

// 6. Couper ses alertes (sans code medic) ; expiration
ok((await req('DELETE', '/api/push', { endpoint: `${SVC}/abo1` })).status === 204, 'couper ses alertes : sans code medic, avec son adresse');
const before = got.length;
await help(48.865, 2.355);
await wait(500);
ok(got.length === before, 'alertes coupées : plus rien n\'arrive');
// 7. Le service refuse l'envoi (403 : inscrit avec une ancienne clé du serveur) : abonnement oublié
ok((await subscribe(`${SVC}/vieille-cle`)).status === 200, 'abonné inscrit avec une clé que le service refuse');
await help(48.865, 2.357);
await wait(500);
const avant403 = got.filter((g) => g.path === '/vieille-cle').length;
await help(48.865, 2.358);
await wait(500);
ok(avant403 === 1 && got.filter((g) => g.path === '/vieille-cle').length === 1, 'refus 403 du service : abonnement oublié, plus d\'essai');

// 8. Code de collectif retiré : ses alertes s'arrêtent aussitôt (téléphone saisi)
const { b32encode, medicPrint } = await import(new URL('../public/js/codes.js', import.meta.url));
const code = `${b32encode(randomBytes(14))}M`;
writeFileSync(LIST, `${medicPrint(code)}\n`);
await wait(1100);
ok((await subscribe(`${SVC}/collectif`, { 'X-Medic-Code': code })).status === 200, 'inscription avec un code de collectif');
await help(48.866, 2.359);
await wait(500);
ok(got.some((g) => g.path === '/collectif'), 'le collectif reçoit l\'alerte');
writeFileSync(LIST, '# vide\n');
await wait(1100);
const avantRetrait = got.length;
await help(48.867, 2.36);
await wait(500);
ok(got.slice(avantRetrait).every((g) => g.path !== '/collectif'), 'empreinte retirée : plus aucune alerte pour ce code');

// 9. Expiration
Config.pushTtlMin = 0.001; // environ 60 ms
await subscribe(`${SVC}/abo2`);
await wait(150);
await help(48.868, 2.361);
await wait(500);
ok(!got.some((g) => g.path === '/abo2'), 'inscription expirée : oubliée, plus d\'alerte');

svc.close();
rmSync(dir, { recursive: true, force: true });
await wait(300); // sous Windows, quitter au milieu de connexions qui se ferment fait planter Node
console.log(fails ? `\n${fails} ÉCHEC(S)` : '\nTOUT PASSE');
process.exit(fails ? 1 : 0);
