// SPDX-License-Identifier: AGPL-3.0-or-later
// Vigie : empaquette un dossier de tuiles raster (z/x/y) en une archive PMTiles auto-hébergée.
// Usage : node scripts/build-pmtiles.mjs [--src=cache/tiles] [--out=tiles.pmtiles] [--type=png]
// La vraie carte (France entière, vectorielle) se télécharge avec npm run carte. Ce script-ci sert
// seulement à empaqueter un dossier de tuiles images déjà présent (par exemple le cache du proxy).

import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writePmtiles } from '../pmtiles.mjs';

const arg = (n, d) => { const a = process.argv.find((s) => s.startsWith(`--${n}=`)); return a ? a.split('=')[1] : d; };
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.resolve(arg('src', path.join(ROOT, 'cache', 'tiles')));
const out = path.resolve(arg('out', path.join(ROOT, 'tiles.pmtiles')));
const type = arg('type', 'png');
const ext = `.${type}`;

const isDir = async (p) => { try { return (await stat(p)).isDirectory(); } catch { return false; } };

const tiles = [];
for (const z of await readdir(src).catch(() => [])) {
    const zp = path.join(src, z);
    if (!/^\d+$/.test(z) || !(await isDir(zp))) continue;
    for (const x of await readdir(zp)) {
        const xp = path.join(zp, x);
        if (!/^\d+$/.test(x) || !(await isDir(xp))) continue;
        for (const f of await readdir(xp)) {
            if (!f.endsWith(ext)) continue;
            const y = f.slice(0, -ext.length);
            if (!/^\d+$/.test(y)) continue;
            tiles.push({ z: +z, x: +x, y: +y, data: await readFile(path.join(xp, f)) });
        }
    }
}

if (!tiles.length) {
    console.error(`Aucune tuile ${ext} trouvée sous ${src}. Prépare une zone dans l'appli, ou indique --src.`);
    process.exit(1);
}

const r = await writePmtiles(out, tiles, { type });
console.log(`Écrit ${out}`);
console.log(`  ${r.tiles} tuiles (${r.contents} contenus uniques), zooms ${r.minZoom} à ${r.maxZoom}, ${(r.bytes / 1e6).toFixed(2)} Mo`);
console.log(`Pour servir : PMTILES=${path.relative(ROOT, out)} node server.js`);
