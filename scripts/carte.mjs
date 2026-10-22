// SPDX-License-Identifier: AGPL-3.0-or-later
// Vigie : télécharge la carte de France (données OpenStreetMap vectorielles) dans tiles.pmtiles.
// Usage : npm run carte              (ou : node scripts/carte.mjs --build=AAAAMMJJ)
//         npm run carte -- --taille  (mesure seulement ce qu'il faudrait télécharger)
//         npm run carte -- --zoom=15  (carte complète : 8 Go au lieu de 3,8, pour un détail à peine visible)
// Prend la construction quotidienne de Protomaps (un extrait d'OpenStreetMap, faite pour ça) et n'en
// garde que les zones de config.js, avec l'outil officiel `pmtiles` (téléchargé une fois, empreinte
// vérifiée). Le téléphone dessine ensuite la carte lui-même : rien à fabriquer en amont. À refaire
// seulement pour rafraîchir les données (une fois par mois suffit largement).

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Config } from '../config.js';
import { openPmtiles } from '../pmtiles.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOLS = path.join(ROOT, 'cache', 'outils');
const OUT = path.join(ROOT, 'tiles.pmtiles');
const arg = (n, d) => { const a = process.argv.find((s) => s.startsWith(`--${n}=`)); return a ? a.split('=')[1] : d; };

// Zoom maximal des données : le téléphone agrandit lui-même au-delà. Au zoom 14, la carte de France pèse
// 3,8 Go au lieu de 8 (zoom 15), pour des rues et des noms identiques à l'écran (comparé à l'écran) :
// elle tient sur un petit serveur (15 Go de disque), mise à jour comprise.
const ZOOM_MAX = Number(arg('zoom', 14));

const PMTILES_VERSION = '1.31.2';
// Empreintes SHA-256 des fichiers publiés de cette version, relevées à la publication de cette version et inscrites ici :
// un téléchargement modifié serait refusé, même si la source qui le fournit était compromise
const PMTILES_SHA256 = {
    'go-pmtiles-1.31.2_Darwin_arm64.zip': '40528f7f616fcbf91207cd48c8fc023d213f6d86c0cbf1f748732803d1880f3d',
    'go-pmtiles-1.31.2_Darwin_x86_64.zip': '1f0dc02eee6c58312dd6c509faee1b5c32f0596568af1bf51f1b034e7a88a65b',
    'go-pmtiles_1.31.2_Linux_arm64.tar.gz': 'f8bd47e7ea866863489cad588fbaf2f31f42e5821f7a03f009b3769f05801cb1',
    'go-pmtiles_1.31.2_Linux_x86_64.tar.gz': '3ed7dbf4ec2e6dfe5e25b6f70d1ffc932729f93c86db353bf514dd71010a312f',
    'go-pmtiles_1.31.2_Windows_arm64.zip': '8780a17453c63af757917a694cbbb50b943db89cc3f1b07e6fd62c1ff8e6963b',
    'go-pmtiles_1.31.2_Windows_x86_64.zip': 'a658baa4d7e55020aef6ca17bd9ff9faa1582671266b36f58c52db0ac8e785a1',
};
const run = (cmd, args) => new Promise((ok, ko) => {
    const p = spawn(cmd, args, { stdio: 'inherit' });
    p.on('error', ko);
    p.on('exit', (code) => (code === 0 ? ok() : ko(new Error(`${path.basename(cmd)} a échoué (code ${code})`))));
});

// ------------------------------------------------------------------ outil officiel pmtiles
async function ensureTool() {
    const exe = path.join(TOOLS, 'go-pmtiles', process.platform === 'win32' ? 'pmtiles.exe' : 'pmtiles');
    if (existsSync(exe)) return exe;
    const os = { win32: 'Windows', linux: 'Linux', darwin: 'Darwin' }[process.platform];
    const cpu = { x64: 'x86_64', arm64: 'arm64' }[process.arch];
    if (!os || !cpu) throw new Error(`Plateforme non prévue (${process.platform} ${process.arch}) : installe l'outil pmtiles à la main.`);
    const sep = os === 'Darwin' ? '-' : '_'; // nommage des fichiers de la version publiée
    const name = `go-pmtiles${sep}${PMTILES_VERSION}_${os}_${cpu}.${os === 'Linux' ? 'tar.gz' : 'zip'}`;
    console.log(`Outil : téléchargement de ${name} (github.com/protomaps/go-pmtiles)`);
    const expected = PMTILES_SHA256[name];
    if (!expected) throw new Error(`Pas d'empreinte connue pour ${name} : installe l'outil pmtiles à la main.`);
    const url = `https://github.com/protomaps/go-pmtiles/releases/download/v${PMTILES_VERSION}/${name}`;
    const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
    const sum = createHash('sha256').update(buf).digest('hex');
    if (sum !== expected) throw new Error('Empreinte de l\'outil différente de celle attendue : téléchargement refusé.');
    mkdirSync(path.join(TOOLS, 'go-pmtiles'), { recursive: true });
    const archive = path.join(TOOLS, name);
    await writeFile(archive, buf);
    // Le tar de Windows (10 et plus) et celui de macOS lisent aussi les zip ; sous Windows, on évite celui
    // de Git Bash, qui prend « C: » pour un nom de machine
    const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
    await run(tar, ['-xf', archive, '-C', path.join(TOOLS, 'go-pmtiles')]);
    rmSync(archive);
    return exe;
}

// ------------------------------------------------------------------ construction Protomaps la plus récente
async function findBuild() {
    const wanted = arg('build', null);
    const days = wanted ? [wanted] : Array.from({ length: 10 }, (_, i) => new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10).replace(/-/g, ''));
    for (const d of days) {
        const url = `https://build.protomaps.com/${d}.pmtiles`;
        try {
            const r = await fetch(url, { headers: { Range: 'bytes=0-6' }, signal: AbortSignal.timeout(15_000) });
            if (r.ok) return url;
        } catch { /* on essaie la veille */ }
    }
    throw new Error('Aucune construction Protomaps trouvée (réseau ?). Indique une date avec --build=AAAAMMJJ.');
}

// ------------------------------------------------------------------ extraction
async function main() {
    const t0 = Date.now();
    const exe = await ensureTool();
    const url = await findBuild();

    // Les zones de config.js, en un seul polygone multiple
    const region = path.join(ROOT, 'cache', 'carte-zones.geojson');
    const polys = Config.zones.map(([, [w, s, e, n]]) => [[[w, s], [e, s], [e, n], [w, n], [w, s]]]);
    writeFileSync(region, JSON.stringify({ type: 'Feature', properties: {}, geometry: { type: 'MultiPolygon', coordinates: polys } }));

    console.log(`Carte : ${Config.zones.map(([nom]) => nom).join(', ')}, depuis ${url}`);
    if (process.argv.includes('--taille')) {
        await run(exe, ['extract', url, path.join(TOOLS, 'essai.pmtiles'), `--region=${region}`, `--maxzoom=${ZOOM_MAX}`, '--dry-run']);
        return;
    }
    console.log(`Zoom maximal ${ZOOM_MAX} : plusieurs gigaoctets à télécharger, compter quelques minutes avec une bonne connexion.`);
    const tmp = `${OUT}.tmp`;
    rmSync(tmp, { force: true });
    rmSync(`${OUT}.bak`, { force: true }); // place libre : jamais trois cartes sur le disque en même temps
    await run(exe, ['extract', url, tmp, `--region=${region}`, `--maxzoom=${ZOOM_MAX}`, '--download-threads=4']);

    // Vérification avant de remplacer la carte servie ; l'ancienne est gardée en .bak (une seule)
    const check = await openPmtiles(tmp);
    const ok = check.header.tileType === 1 && check.header.maxZoom >= Math.min(ZOOM_MAX, 14);
    await check.close();
    if (!ok) throw new Error('L\'archive téléchargée n\'est pas une carte vectorielle complète : rien n\'a été remplacé.');
    if (existsSync(OUT)) renameSync(OUT, `${OUT}.bak`);
    renameSync(tmp, OUT);
    const go = (statSync(OUT).size / 1e9).toFixed(1);
    console.log(`\nÉcrit tiles.pmtiles : ${go} Go, en ${Math.round((Date.now() - t0) / 60000)} min. Redémarre le serveur pour la servir.`);
}

main().catch((e) => {
    console.error(`\nCarte impossible : ${e.message}`);
    process.exit(1);
});
