process.env.TZ = 'Europe/Paris'; // les changements d'heure testés sont ceux de la France
// Jour du cache de carte au changement d'heure (Europe/Paris) : nouvelle méthode contre l'ancienne
const fs = require('fs');
const src = fs.readFileSync(require('path').join(__dirname, '..', 'public', 'sw.js'), 'utf8');
const RealDate = Date;
let fake;
global.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [fake])); } static now() { return fake; } };
const m = src.match(/const localDay[\s\S]*?\n};\n/);
const { localDay, tilesCache } = new Function(`${m[0]}; return { localDay, tilesCache };`)();
const old = (daysAgo) => `vigie-tiles-${localDay(new Date(Date.now() - daysAgo * 86_400_000))}`;
for (const [label, iso, want] of [
    ['nuit après le passage à l\'heure d\'été', '2026-03-30T00:30:00+02:00', 'vigie-tiles-2026-03-29'],
    ['soir du passage à l\'heure d\'hiver', '2026-10-25T23:30:00+01:00', 'vigie-tiles-2026-10-24'],
    ['jour ordinaire', '2026-10-22T12:00:00+02:00', 'vigie-tiles-2026-10-21'],
]) {
    fake = new RealDate(iso).getTime();
    console.log(`${tilesCache(1) === want ? 'PASS' : 'FAIL'} : ${label} : hier = ${tilesCache(1)} (ancienne méthode : ${old(1)})`);
    if (tilesCache(1) !== want) process.exitCode = 1;
}
