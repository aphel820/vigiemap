import { sha256, leadingZeroBits, solveSync } from '../public/js/pow.js';
import { createHash } from 'node:crypto';

let fails = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} : ${m}`); if (!c) fails++; };
const hex = (u8) => [...u8].map((x) => x.toString(16).padStart(2, '0')).join('');
const enc = (s) => new TextEncoder().encode(s);

// 1. vecteurs SHA-256 connus
ok(hex(sha256(enc('abc'))) === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', 'SHA-256("abc")');
ok(hex(sha256(enc(''))) === 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 'SHA-256("")');
const long = 'a'.repeat(1000);
ok(hex(sha256(enc(long))) === createHash('sha256').update(long).digest('hex'), 'SHA-256(1000 octets) == Node');
// quelques chaînes variées comparées à Node
let allMatch = true;
for (let i = 0; i < 200; i++) { const s = `vigie|${i}|${Math.random()}`; if (hex(sha256(enc(s))) !== createHash('sha256').update(s).digest('hex')) allMatch = false; }
ok(allMatch, '200 chaînes aléatoires : mon SHA-256 == celui de Node');

// 2. solveur : le nonce trouvé donne bien un digest avec assez de zéros, vérifiable par Node
const subject = 'report|gaz|48.8675|2.3637|abc123';
const bucket = 12345;
for (const bits of [8, 12, 16]) {
    const t0 = Date.now();
    const nonce = solveSync(subject, bits, bucket);
    const dt = Date.now() - t0;
    const digest = createHash('sha256').update(`${subject}|${bucket}|${nonce}`).digest();
    ok(nonce >= 0 && leadingZeroBits(digest, bits), `solve ${bits} bits -> nonce ${nonce} (vérifié par Node), ${dt} ms`);
}

// 3. mesure du débit (hachages/s) pour calibrer la difficulté
const t0 = Date.now();
let n = 0;
while (Date.now() - t0 < 500) { sha256(enc(`m${n}`)); n++; }
console.log(`débit ~ ${Math.round(n / (Date.now() - t0) * 1000 / 1000)} k hachages/s (sur cette machine)`);

console.log(fails ? `\n${fails} ÉCHEC(S)` : '\nTOUT PASSE');
process.exit(fails ? 1 : 0);
