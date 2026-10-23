import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Vent en relief : 9 points par secteur en relief, 1 en plaine, le téléphone prend le plus proche,
// chaque point compté dans le quota d'Open-Meteo
let fails = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} : ${m}`); if (!c) fails++; };

const { windPoints, nearestWind, tile2lat, tile2lng, CALM_KMH } = await import(new URL('../public/js/vent.js', import.meta.url));

// 1. Points de relevé
const n = 512;
const plain = windPoints(259, 176, 9, false);
ok(plain.length === 1, 'plaine : un seul point');
const grid = windPoints(264, 183, 9, true);
ok(grid.length === 9, 'relief : 9 points');
const inside = grid.every(([la, lo]) => la <= tile2lat(183, n) && la >= tile2lat(184, n) && lo >= tile2lng(264, n) && lo <= tile2lng(265, n));
ok(inside, 'les 9 points sont dans le secteur');
ok(grid[4][0] === windPoints(264, 183, 9, false)[0][0] && grid[4][1] === windPoints(264, 183, 9, false)[0][1], 'le point du milieu de la grille est le centre du secteur');

// 2. Le plus proche, choisi sur le téléphone
const w = { fromDeg: 192, speedKmh: 17, points: grid.map(([lat, lng], i) => ({ lat, lng, fromDeg: i * 40, speedKmh: i })) };
const grenoble = [45.19, 5.72];
const near = nearestWind(w, grenoble);
ok(near.fromDeg === 6 * 40 && near.speedKmh === 6, `Grenoble : le point de la grille le plus proche (sud-ouest du secteur), pas le centre (${JSON.stringify(near)})`);
ok(nearestWind({ fromDeg: 10, speedKmh: 12 }, grenoble).fromDeg === 10, 'sans grille : le relevé du secteur');
ok(nearestWind(w, null).fromDeg === 192, 'sans position : le centre');
ok(nearestWind(null, grenoble) === null, 'sans vent : rien');
ok(CALM_KMH === 8, 'vent faible : sous 8 km/h, pas de flèche');

// 3. Serveur : faux service météo qui compte les points demandés
const realFetch = globalThis.fetch;
const calls = [];
let illisible = 2; // le point que le faux service météo rend illisible
globalThis.fetch = (url, opts) => {
    const u = String(url);
    if (!u.includes('open-meteo')) return realFetch(url, opts);
    const lats = new URL(u).searchParams.get('latitude').split(',');
    calls.push(lats.length);
    const one = (i) => ({ current: { wind_direction_10m: i === illisible ? 'nord' : i * 30, wind_speed_10m: 10 + i } });
    return Promise.resolve(new Response(JSON.stringify(lats.length === 1 ? one(0) : lats.map((_, i) => one(i)))));
};
const dir = mkdtempSync(path.join(tmpdir(), 'vigie-vent-'));
const RELIEFS = ['258.175', '259.175', '260.175', '258.176', '259.176', '260.176', '258.177'];
writeFileSync(path.join(dir, 'relief.json'), JSON.stringify({ secteurs: RELIEFS }));
process.env.RELIEF_FILE = path.join(dir, 'relief.json');
process.env.CERT = 'nope';
process.env.KEY = 'nope';
process.env.POW_BITS = '8';
process.env.MEDIC_CODE = 'code-medic-de-test-solide';
process.argv.push('--port=4414');
await import(new URL('../server.js', import.meta.url));
await new Promise((res) => setTimeout(res, 300));
const wind = async (s) => (await realFetch(`http://localhost:4414/api/wind?s=${s}`)).json();

const r = await wind('259.176');
ok(calls[0] === 9, `secteur en relief : 9 points demandés en une requête (${calls[0]})`);
ok(Array.isArray(r.points) && r.points.length === 8, `relevé illisible d'un point écarté, les 8 autres envoyés (${r.points?.length})`);
ok(r.fromDeg === 4 * 30 && r.speedKmh === 14, 'le vent du secteur est celui du centre (pour les anciennes versions de l\'appli)');
ok(r.points.every((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng) && Number.isInteger(p.speedKmh)), 'chaque point : position et vent arrondi');
const before = calls.length;
await wind('259.176');
ok(calls.length === before, 'redemandé aussitôt : pas d\'appel en plus (relevé gardé 15 min)');

const lyon = await wind('262.180');
ok(calls.at(-1) === 1 && !lyon.points && lyon.fromDeg === 0, 'secteur en plaine : un seul point, comme avant');

// 4. Quota : chaque point compte ; 60 par minute, donc 6 secteurs en relief au plus dans la minute
// Le centre illisible : les 8 autres points servent quand même, le plus proche du centre le remplace
illisible = 4;
const sansCentre = await wind('258.175');
ok(sansCentre.points?.length === 8 && sansCentre.points.some((p) => p.fromDeg === sansCentre.fromDeg && p.speedKmh === sansCentre.speedKmh),
    'centre illisible : les 8 autres points envoyés, le vent du secteur pris sur un voisin du centre');
illisible = 2;

// Déjà 19 points (Paris 9, Lyon 1, 258.175 9) : 4 secteurs en relief passent (55), le 5e ferait 64
const res = [];
for (const s of RELIEFS.filter((x) => x !== '259.176' && x !== '258.175')) res.push(await wind(s));
const pointsThisMinute = calls.reduce((a, b) => a + b, 0);
ok(pointsThisMinute === 55, `chaque point compte dans le quota : 55 points demandés dans la minute (${pointsThisMinute})`);
ok(res.slice(0, 4).every((x) => x.points?.length === 8) && res[4].unavailable === true, 'le 5e secteur en relief de la minute attend : pas de relevé plutôt qu\'un dépassement du quota');

rmSync(dir, { recursive: true, force: true });
// Laisse se fermer les connexions en cours : sous Windows, quitter au milieu fait planter Node (libuv)
await new Promise((res) => setTimeout(res, 300));
console.log(fails ? `\n${fails} ÉCHEC(S)` : '\nTOUT PASSE');
process.exit(fails ? 1 : 0);
