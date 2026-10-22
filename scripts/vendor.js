// SPDX-License-Identifier: AGPL-3.0-or-later
// Copie Leaflet, protomaps-leaflet et la police Atkinson Hyperlegible dans public/vendor.
// Aucun CDN au chargement : le téléphone ne parle qu'à notre serveur.

import { cpSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NM = path.join(ROOT, 'node_modules');
const OUT = path.join(ROOT, 'public', 'vendor');

mkdirSync(path.join(OUT, 'leaflet'), { recursive: true });
mkdirSync(path.join(OUT, 'fonts'), { recursive: true });

cpSync(path.join(NM, 'leaflet', 'dist', 'leaflet.js'), path.join(OUT, 'leaflet', 'leaflet.js'));
cpSync(path.join(NM, 'leaflet', 'dist', 'leaflet.css'), path.join(OUT, 'leaflet', 'leaflet.css'));

// Dessin de la carte vectorielle par le téléphone, dans Leaflet (canvas, sans WebGL ni police externe)
mkdirSync(path.join(OUT, 'protomaps-leaflet'), { recursive: true });
cpSync(path.join(NM, 'protomaps-leaflet', 'dist', 'protomaps-leaflet.js'), path.join(OUT, 'protomaps-leaflet', 'protomaps-leaflet.js'));

// Styles jour et nuit de Protomaps, avec des noms de lieux et de rues bien plus contrastés (lisibles en
// courant, en plein soleil) : environ 7:1 au lieu de 2 à 3:1. Générés ici, servis par Vigie comme le reste.
const { namedFlavor } = await import('@protomaps/basemaps');
const LISIBLE = {
    light: {
        roads_label_minor: '#5c5c5c', roads_label_major: '#474747', address_label: '#666666',
        subplace_label: '#5c5c5c', city_label: '#2e2e2e', state_label: '#707070', country_label: '#707070',
    },
    dark: {
        roads_label_minor: '#a8a8a8', roads_label_major: '#c2c2c2', address_label: '#999999',
        subplace_label: '#a8a8a8', city_label: '#dedede', state_label: '#8f8f8f', country_label: '#8f8f8f',
    },
};
const flavors = Object.fromEntries(Object.entries(LISIBLE).map(([name, over]) => [name, { ...namedFlavor(name), ...over }]));
writeFileSync(path.join(OUT, 'protomaps-leaflet', 'flavors.js'), `// Généré par scripts/vendor.js\nexport const FLAVORS = ${JSON.stringify(flavors)};\n`);

// Atkinson Hyperlegible : dessinée pour les malvoyants, lisible avec les yeux qui pleurent
const fonts = path.join(NM, '@fontsource', 'atkinson-hyperlegible', 'files');
for (const w of [400, 700]) {
    cpSync(
        path.join(fonts, `atkinson-hyperlegible-latin-${w}-normal.woff2`),
        path.join(OUT, 'fonts', `atkinson-${w}.woff2`),
    );
}

console.log('Vigie : dépendances copiées dans public/vendor');
