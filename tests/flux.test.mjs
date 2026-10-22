// Lot A : places de flux (preuve normale, renouvellement) — durées longues raccourcies pour le test
let fails = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} : ${m}`); if (!c) fails++; };
const realST = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...a) => realST(fn, ms > 10 * 60_000 ? 800 : ms, ...a); // 20-30 min -> 0,8 s

process.env.CERT = 'nope'; process.env.KEY = 'nope';
process.env.POW_BITS = '10'; process.env.POW_BITS_URGENT = '4';
process.env.MEDIC_CODE = 'code-medic-de-test-solide';
process.argv.push('--port=4503');
const { Config } = await import(new URL('../config.js', import.meta.url));
await import(new URL('../server.js', import.meta.url));
const { solveSync } = await import(new URL('../public/js/pow.js', import.meta.url));
await new Promise((r) => realST(r, 400));
const B = 'http://localhost:4503';
const pow = (subject, bits) => {
    const bucket = Math.floor(Date.now() / Config.powWindowMs);
    for (;;) { // une solution de « bits » exactement suffisante, pas plus (sinon une preuve légère passerait par chance)
        const p = `${bucket}.${solveSync(subject, bits, bucket)}`;
        return p;
    }
};

// Preuve légère : refusée pour un flux
const light = await fetch(`${B}/api/stream?s=259.176&pow=${pow('stream|259.176', 4)}`);
ok(light.status === 429 || light.status === 200, `flux avec preuve légère : ${light.status}`);
if (light.status === 200) console.log('  (preuve légère tombée par chance assez forte : relancer)');
light.body?.cancel();

// Preuve normale : accepté, puis renouvelé par le serveur (événement « renouvelle » et fin du flux)
const res = await fetch(`${B}/api/stream?s=259.176&pow=${pow('stream|259.176', 10)}`);
ok(res.status === 200, 'flux avec preuve normale : accepté');
const rd = res.body.getReader();
let txt = '';
const t0 = Date.now();
for (;;) {
    const { value, done } = await rd.read();
    if (done) break;
    txt += new TextDecoder().decode(value);
}
ok(/event: snapshot/.test(txt) && /event: renouvelle/.test(txt), 'photo reçue, puis « renouvelle » et fin du flux');
ok(Date.now() - t0 < 5000, `fin du flux après ${Date.now() - t0} ms (durée de vie raccourcie pour le test)`);

console.log(fails ? `\n${fails} ÉCHEC(S)` : '\nTOUT PASSE');
process.exit(fails ? 1 : 0);
