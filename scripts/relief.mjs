// SPDX-License-Identifier: AGPL-3.0-or-later
// Vigie : liste les secteurs en relief (relief.json), où le vent est relevé sur 9 points au lieu d'un.
// À relancer seulement si les zones ou la taille des secteurs changent (le relief, lui, ne bouge pas) :
//   node scripts/relief.mjs
// Interroge le service d'altitude d'Open-Meteo (gratuit, 100 points par requête) : un secteur est en
// relief si ses 9 points de relevé ont plus de SEUIL_M mètres d'écart d'altitude. Open-Meteo compte
// chaque point comme un appel (600 par minute au plus) : une requête toutes les 11 s, 8 min en tout.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Config } from '../config.js';
import { windPoints } from '../public/js/vent.js';

const SEUIL_M = 250;
const OUT = fileURLToPath(new URL('../relief.json', import.meta.url));
const n = 2 ** Config.sectorZoom;
const lng2x = (lng) => Math.floor(((lng + 180) / 360) * n);
const lat2y = (lat) => {
    const r = (lat * Math.PI) / 180;
    return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n);
};

// Tous les secteurs qui touchent une zone couverte
const secteurs = new Set();
for (const [, [w, s, e, nn]] of Config.zones) {
    for (let x = lng2x(w); x <= lng2x(e); x++) for (let y = lat2y(nn); y <= lat2y(s); y++) secteurs.add(`${x}.${y}`);
}
const liste = [...secteurs].map((k) => ({ k, pts: windPoints(...k.split('.').map(Number), Config.sectorZoom, true) }));
const tous = liste.flatMap((s) => s.pts);
console.log(`${liste.length} secteurs, ${tous.length} points d'altitude à lire`);

// Altitudes déjà lues gardées dans cache/ : un calcul interrompu reprend où il s'était arrêté
const CACHE = fileURLToPath(new URL('../cache/relief-altitudes.json', import.meta.url));
let connues = {};
try { connues = JSON.parse(readFileSync(CACHE, 'utf8')); } catch { /* premier passage */ }
const cle = (p) => `${p[0]},${p[1]}`;
const attendre = (ms) => new Promise((res) => setTimeout(res, ms));
const manquants = [...new Map(tous.filter((p) => !(cle(p) in connues)).map((p) => [cle(p), p])).values()];
console.log(`${manquants.length} à lire (${tous.length - manquants.length} déjà en cache)`);
for (let i = 0; i < manquants.length; i += 100) {
    const lot = manquants.slice(i, i + 100);
    const url = `https://api.open-meteo.com/v1/elevation?latitude=${lot.map((p) => p[0]).join(',')}&longitude=${lot.map((p) => p[1]).join(',')}`;
    let r = await fetch(url);
    // Limite atteinte (autre usage de la même adresse) : on attend la minute, ou l'heure, suivante
    while (r.status === 429) {
        const raison = await r.text();
        if (/daily/i.test(raison)) throw new Error('Limite du jour d\'Open-Meteo atteinte : relance demain, le calcul reprendra où il en est.');
        const ms = /hourly/i.test(raison) ? 3_660_000 - (Date.now() % 3_600_000) : 65_000;
        console.log(`\nLimite ${/hourly/i.test(raison) ? 'de l\'heure' : 'de la minute'} d'Open-Meteo : reprise dans ${Math.ceil(ms / 60_000)} min`);
        await attendre(ms);
        r = await fetch(url);
    }
    if (!r.ok) throw new Error(`Open-Meteo : ${r.status} ${await r.text()}`);
    const j = await r.json();
    if (!Array.isArray(j.elevation) || j.elevation.length !== lot.length) throw new Error('réponse inattendue');
    lot.forEach((p, k) => { connues[cle(p)] = j.elevation[k]; });
    mkdirSync(path.dirname(CACHE), { recursive: true });
    writeFileSync(CACHE, JSON.stringify(connues));
    process.stdout.write(`\r${Math.min(i + 100, manquants.length)} / ${manquants.length}`);
    await attendre(11_000);
}
console.log();
const alt = tous.map((p) => connues[cle(p)]);

const relief = [];
liste.forEach((s, i) => {
    const e = alt.slice(i * 9, i * 9 + 9).filter(Number.isFinite);
    if (e.length && Math.max(...e) - Math.min(...e) > SEUIL_M) relief.push(s.k);
});
relief.sort();
writeFileSync(OUT, `${JSON.stringify({ seuilM: SEUIL_M, zoom: Config.sectorZoom, secteurs: relief })}\n`);
console.log(`${relief.length} secteurs en relief sur ${liste.length} : ${OUT}`);
