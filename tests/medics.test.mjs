import { randomBytes, createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Codes de collectifs de medics : même empreinte dans l'appli et au serveur, liste relue sans
// redémarrer, code coupé dès que son empreinte est retirée, ancien code du serveur toujours valable
let fails = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} : ${m}`); if (!c) fails++; };

const dir = mkdtempSync(path.join(tmpdir(), 'vigie-medics-'));
const LIST = path.join(dir, 'medics.txt');
process.env.CERT = 'nope';
process.env.KEY = 'nope';
process.env.POW_BITS = '8';
process.env.POW_BITS_URGENT = '6';
process.env.MEDIC_CODE = 'code-medic-de-test-solide';
process.env.MEDIC_LIST = LIST;
process.argv.push('--port=4411');
await import(new URL('../server.js', import.meta.url));
const { medicPrint, b32encode, MEDIC_CODE_RE } = await import(new URL('../public/js/codes.js', import.meta.url));
await new Promise((res) => setTimeout(res, 300));

const B = 'http://localhost:4411';
const status = async (code, u = '/api/help?s=259.176', method = 'GET') =>
    (await fetch(B + u, { method, headers: code ? { 'X-Medic-Code': code } : {} })).status;
const wait = (ms) => new Promise((res) => setTimeout(res, ms));
const newCode = () => `${b32encode(randomBytes(14))}M`;

// 1. L'empreinte : SHA-256 du code nettoyé, 10 octets en base32, comme le calcule Node
const code = newCode();
ok(MEDIC_CODE_RE.test(code), `code de collectif : 24 caractères finissant par M (${code})`);
const ref = b32encode(createHash('sha256').update(code).digest().subarray(0, 10));
ok(medicPrint(code) === ref, 'empreinte de l\'appli = SHA-256 de Node, 16 caractères');
const grouped = code.toLowerCase().replace(/(.{4})(?=.)/g, '$1-');
ok(medicPrint(grouped) === ref, 'même empreinte avec tirets et minuscules');

// 2. Avant l'ajout : refusé ; l'ancien code du serveur marche toujours
ok(await status(code) === 403, 'code de collectif absent de la liste : refusé');
ok(await status('code-medic-de-test-solide') === 200, 'ancien code du serveur (MEDIC_CODE) : toujours accepté');

// 3. Ajout à chaud, avec commentaire, ligne vide et ligne invalide ignorés
writeFileSync(LIST, `# liste de test\n\n${ref.replace(/(.{4})(?=.)/g, '$1-')}\npas-une-empreinte\n`);
await wait(1100);
ok(await status(code) === 200, 'empreinte ajoutée : le code marche, sans redémarrage');
ok(await status(grouped) === 200, 'code tapé avec tirets et minuscules : accepté');
ok(await status(newCode()) === 403, 'un autre code de collectif : toujours refusé');
ok(await status(`${code.slice(0, -1)}C`) === 403, 'même code avec le type d\'une cellule : refusé');

// 4. Prendre en charge une demande avec un code de collectif
const lat = 48.86, lng = 2.35;
const bucket = Math.floor(Date.now() / 300_000);
const { solveSync } = await import(new URL('../public/js/pow.js', import.meta.url));
const powH = `${bucket}.${solveSync(`help|blesse|${lat}|${lng}`, 6, bucket)}`;
const h = await (await fetch(`${B}/api/help`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Pow': powH }, body: JSON.stringify({ type: 'blesse', lat, lng }) })).json();
ok(await status(code, `/api/help/${h.id}/take`, 'POST') === 200, 'un code de collectif peut prendre une demande en charge');

// 5. Retrait : le code est coupé, sans redémarrage ; fichier supprimé : plus aucun code de collectif
writeFileSync(LIST, '# vide\n');
await wait(1100);
ok(await status(code) === 403, 'empreinte retirée : le code ne marche plus');
writeFileSync(LIST, `${ref}\n`);
await wait(1100);
ok(await status(code) === 200, 'remise dans la liste : il remarche');
rmSync(LIST);
await wait(1100);
ok(await status(code) === 403, 'liste supprimée : aucun code de collectif accepté');
ok(await status('code-medic-de-test-solide') === 200, '… et l\'ancien code du serveur marche toujours');

rmSync(dir, { recursive: true, force: true });
console.log(fails ? `\n${fails} ÉCHEC(S)` : '\nTOUT PASSE');
process.exit(fails ? 1 : 0);
