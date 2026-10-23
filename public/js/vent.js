// SPDX-License-Identifier: AGPL-3.0-or-later
// Vigie : où relever le vent dans un secteur, et quel relevé afficher. Chargé par le serveur (où
// demander le vent), le script du relief, l'appli (le relevé le plus proche) et les tests.

// Coordonnées d'un bord de tuile de la grille des secteurs (zoom n = 2^zoom)
export const tile2lng = (x, n) => (x / n) * 360 - 180;
export const tile2lat = (y, n) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;

// Points de relevé d'un secteur, arrondis à 0,01° (environ 1 km) : son centre seulement en plaine ;
// en relief, une grille de 3 x 3 (le centre au milieu de la liste), car le vent d'une vallée et
// celui d'une crête voisine n'ont parfois rien à voir, jusqu'à souffler en sens inverse.
const GRID = [1 / 6, 3 / 6, 5 / 6];
export function windPoints(sx, sy, zoom, grid) {
    const n = 2 ** zoom;
    const fr = grid ? GRID : [0.5];
    const round = (v) => Math.round(v * 100) / 100;
    const pts = [];
    for (const fy of fr) for (const fx of fr) pts.push([round(tile2lat(sy + fy, n)), round(tile2lng(sx + fx, n))]);
    return pts;
}

// En dessous, la direction du vent ne veut plus dire grand-chose : pas de flèche
export const CALM_KMH = 8;

// Le relevé le plus proche de la position, choisi sur le téléphone : le serveur envoie tous les
// points du secteur et ne sait pas lequel est affiché
export function nearestWind(w, pos) {
    if (!w) return null;
    const pts = Array.isArray(w.points) && w.points.length ? w.points : null;
    if (!pts || !pos) return { fromDeg: w.fromDeg, speedKmh: w.speedKmh };
    const cos = Math.cos((pos[0] * Math.PI) / 180);
    let best = pts[0];
    let bestD = Infinity;
    for (const p of pts) {
        const d = (p.lat - pos[0]) ** 2 + ((p.lng - pos[1]) * cos) ** 2;
        if (d < bestD) { bestD = d; best = p; }
    }
    return { fromDeg: best.fromDeg, speedKmh: best.speedKmh };
}
