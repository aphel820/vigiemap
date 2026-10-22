// SPDX-License-Identifier: AGPL-3.0-or-later
// Vigie : générateur de QR minimal, sans dépendance (mode alphanumérique, niveau M, v1 à 6).
// Un QR ne sert ici qu'à transmettre un code (cellule, binôme) ou l'adresse de Vigie de la main à la
// main : ce n'est pas de la sécurité, juste un canal. Rend une matrice de booléens (true = module noir) ; l'appli la
// dessine sur un canvas. Pour LIRE un QR on utilise l'API native BarcodeDetector (voir app.js).
// Algorithme standard (Reed-Solomon sur GF(256), placement, masquage) ; on plafonne à la
// version 6 pour ne jamais avoir à gérer l'information de version (qui n'existe qu'à partir de 7).

// ------------------------------------------------------------ corps de Galois GF(256)
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
    let x = 1;
    for (let i = 0; i < 255; i++) {
        EXP[i] = x;
        LOG[x] = i;
        x <<= 1;
        if (x & 0x100) x ^= 0x11d; // polynôme primitif des QR
    }
    for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();
const gfMul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

function polyMul(a, b) {
    const r = new Array(a.length + b.length - 1).fill(0);
    for (let i = 0; i < a.length; i++) for (let j = 0; j < b.length; j++) r[i + j] ^= gfMul(a[i], b[j]);
    return r;
}

// Polynôme générateur pour n codewords de correction
function genPoly(n) {
    let poly = [1];
    for (let i = 0; i < n; i++) poly = polyMul(poly, [1, EXP[i]]);
    return poly;
}

// Reste de la division polynomiale = codewords de correction d'erreur
function eccOf(data, n) {
    const gen = genPoly(n);
    const res = data.concat(new Array(n).fill(0));
    for (let i = 0; i < data.length; i++) {
        const coef = res[i];
        if (coef !== 0) for (let j = 0; j < gen.length; j++) res[i + j] ^= gfMul(gen[j], coef);
    }
    return res.slice(data.length);
}

// ------------------------------------------------------------ paramètres par version (niveau M)
// size, codewords de correction par bloc, tailles des blocs de données, centre d'alignement
const VERS = {
    1: { size: 21, ec: 10, blocks: [16], align: [] },
    2: { size: 25, ec: 16, blocks: [28], align: [6, 18] },
    3: { size: 29, ec: 26, blocks: [44], align: [6, 22] },
    4: { size: 33, ec: 18, blocks: [32, 32], align: [6, 26] },
    5: { size: 37, ec: 24, blocks: [43, 43], align: [6, 30] },
    6: { size: 41, ec: 16, blocks: [27, 27, 27, 27], align: [6, 34] },
};
const ALNUM_CAP = { 1: 20, 2: 38, 3: 61, 4: 90, 5: 122, 6: 154 };
const ALNUM = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';

function pickVersion(len) {
    for (let v = 1; v <= 6; v++) if (len <= ALNUM_CAP[v]) return v;
    throw new Error('Texte trop long pour un QR version 6.');
}

// ------------------------------------------------------------ codage des données
function encodeData(text, version) {
    const bits = [];
    const push = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1); };
    push(0b0010, 4);          // mode alphanumérique
    push(text.length, 9);     // indicateur de longueur (9 bits pour les versions 1 à 9)
    for (let i = 0; i < text.length; i += 2) {
        if (i + 1 < text.length) push(ALNUM.indexOf(text[i]) * 45 + ALNUM.indexOf(text[i + 1]), 11);
        else push(ALNUM.indexOf(text[i]), 6);
    }
    const totalData = VERS[version].blocks.reduce((a, b) => a + b, 0);
    const cap = totalData * 8;
    for (let i = 0; i < 4 && bits.length < cap; i++) bits.push(0); // terminateur
    while (bits.length % 8 !== 0) bits.push(0);
    const pad = [0xEC, 0x11];
    for (let i = 0; bits.length < cap; i++) push(pad[i % 2], 8);
    const cw = [];
    for (let i = 0; i < bits.length; i += 8) {
        let b = 0;
        for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
        cw.push(b);
    }
    return cw;
}

// Découpe en blocs, calcule la correction, puis entrelace (données puis correction)
function assemble(dataCw, version) {
    const { blocks, ec } = VERS[version];
    const dataB = [];
    const eccB = [];
    let p = 0;
    for (const len of blocks) {
        const d = dataCw.slice(p, p + len);
        p += len;
        dataB.push(d);
        eccB.push(eccOf(d, ec));
    }
    const out = [];
    const maxD = Math.max(...blocks);
    for (let i = 0; i < maxD; i++) for (const b of dataB) if (i < b.length) out.push(b[i]);
    for (let i = 0; i < ec; i++) for (const b of eccB) out.push(b[i]);
    return out;
}

// ------------------------------------------------------------ information de format (BCH 15 bits)
const getBit = (x, i) => (x >>> i) & 1;

function formatBits(mask) {
    const data = (0b00 << 3) | mask; // niveau M = 0b00
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    return ((data << 10) | rem) ^ 0x5412;
}

// ------------------------------------------------------------ construction de la matrice
function newGrid(version) {
    const size = VERS[version].size;
    const mod = Array.from({ length: size }, () => new Array(size).fill(0));
    const fn = Array.from({ length: size }, () => new Array(size).fill(false));
    const set = (r, c, v) => { mod[r][c] = v; fn[r][c] = true; };

    // Repères de détection (3 coins) + séparateurs
    const finder = (cr, cc) => {
        for (let dr = -4; dr <= 4; dr++) for (let dc = -4; dc <= 4; dc++) {
            const r = cr + dr;
            const c = cc + dc;
            if (r < 0 || r >= size || c < 0 || c >= size) continue;
            const d = Math.max(Math.abs(dr), Math.abs(dc));
            set(r, c, d !== 2 && d !== 4 ? 1 : 0);
        }
    };
    finder(3, 3);
    finder(3, size - 4);
    finder(size - 4, 3);

    // Motifs de synchronisation
    for (let i = 0; i < size; i++) {
        if (!fn[6][i]) set(6, i, i % 2 === 0 ? 1 : 0);
        if (!fn[i][6]) set(i, 6, i % 2 === 0 ? 1 : 0);
    }

    // Motifs d'alignement (un seul, au centre, pour les versions 2 à 6)
    const al = VERS[version].align;
    for (let i = 0; i < al.length; i++) {
        for (let j = 0; j < al.length; j++) {
            const corner = (i === 0 && j === 0) || (i === 0 && j === al.length - 1) || (i === al.length - 1 && j === 0);
            if (corner) continue;
            const cr = al[i];
            const cc = al[j];
            for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) {
                set(cr + dr, cc + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1 ? 1 : 0);
            }
        }
    }

    set(size - 8, 8, 1); // module toujours noir

    // Réserve l'emplacement de l'information de format (écrite plus tard, après le choix du masque)
    const fmt = formatCoords(size);
    for (const [r, c] of fmt.all) fn[r][c] = true;

    return { mod, fn, size };
}

// Coordonnées [ligne, colonne] des 15 bits d'information de format (bit 0 = poids faible), en deux copies.
// Piège : la norme et les implémentations de référence décrivent souvent ces positions en (x, y), soit
// (colonne, ligne). Les transposer ici donne un QR qui a l'air normal mais qu'aucun lecteur ne décode.
function formatCoords(size) {
    const a = [];
    for (let i = 0; i <= 5; i++) a.push([i, 8]);       // colonne 8, lignes 0 à 5
    a.push([7, 8]); a.push([8, 8]); a.push([8, 7]);    // bits 6, 7, 8
    for (let i = 9; i < 15; i++) a.push([8, 14 - i]);  // ligne 8, colonnes 5 à 0
    const b = [];
    for (let i = 0; i < 8; i++) b.push([8, size - 1 - i]);    // ligne 8, colonnes de droite
    for (let i = 8; i < 15; i++) b.push([size - 15 + i, 8]);  // colonne 8, lignes du bas
    return { a, b, all: [...a, ...b] };
}

function placeData(grid, codewords) {
    const { mod, fn, size } = grid;
    let bit = 0;
    const total = codewords.length * 8;
    for (let right = size - 1; right >= 1; right -= 2) {
        if (right === 6) right = 5; // la colonne 6 est une synchro
        for (let v = 0; v < size; v++) {
            for (let j = 0; j < 2; j++) {
                const col = right - j;
                const up = ((right + 1) & 2) === 0;
                const row = up ? size - 1 - v : v;
                if (!fn[row][col] && bit < total) {
                    mod[row][col] = getBit(codewords[bit >>> 3], 7 - (bit & 7));
                    bit++;
                }
            }
        }
    }
}

const MASKS = [
    (r, c) => (r + c) % 2 === 0,
    (r, c) => r % 2 === 0,
    (r, c) => c % 3 === 0,
    (r, c) => (r + c) % 3 === 0,
    (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
    (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
    (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
    (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

function applyMask(grid, maskFn) {
    const { mod, fn, size } = grid;
    const out = mod.map((row) => row.slice());
    for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (!fn[r][c] && maskFn(r, c)) out[r][c] ^= 1;
    return out;
}

function drawFormat(out, size, mask) {
    const bits = formatBits(mask);
    const { a, b } = formatCoords(size);
    a.forEach(([r, c], i) => { out[r][c] = getBit(bits, i); });
    b.forEach(([r, c], i) => { out[r][c] = getBit(bits, i); });
    out[size - 8][8] = 1;
}

// Pénalité : plus c'est bas, plus le QR se lit bien. N'importe quel masque donne un QR décodable ;
// ce score ne fait qu'optimiser la lisibilité.
function penalty(m, size) {
    let p = 0;
    const line = (get) => {
        for (let i = 0; i < size; i++) {
            let run = 1;
            let s = '';
            for (let k = 0; k < size; k++) {
                s += get(i, k) ? '1' : '0';
                if (k > 0) {
                    if (get(i, k) === get(i, k - 1)) { run++; if (run === 5) p += 3; else if (run > 5) p += 1; }
                    else run = 1;
                }
            }
            for (let k = 0; k + 10 < size + 1; k++) {
                const w = s.substr(k, 11);
                if (w === '10111010000' || w === '00001011101') p += 40;
            }
        }
    };
    line((i, k) => m[i][k]); // lignes
    line((i, k) => m[k][i]); // colonnes
    let dark = 0;
    for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) {
        if (m[r][c]) dark++;
        if (r < size - 1 && c < size - 1) {
            const v = m[r][c];
            if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) p += 3;
        }
    }
    p += Math.floor(Math.abs((dark / (size * size)) * 100 - 50) / 5) * 10;
    return p;
}

// ------------------------------------------------------------ point d'entrée
// Rend une matrice booléenne (true = noir). `text` doit être en majuscules alphanumériques.
export function qrMatrix(text) {
    // Un caractère hors du mode alphanumérique donnait en silence un QR illisible : erreur visible à la place
    if ([...text].some((c) => !ALNUM.includes(c))) throw new Error(`QR : caractère non pris en charge dans « ${text} »`);
    const version = pickVersion(text.length);
    const codewords = assemble(encodeData(text, version), version);
    const grid = newGrid(version);
    placeData(grid, codewords);

    let best = null;
    let bestScore = Infinity;
    for (let mask = 0; mask < 8; mask++) {
        const out = applyMask(grid, MASKS[mask]);
        drawFormat(out, grid.size, mask);
        const score = penalty(out, grid.size);
        if (score < bestScore) { bestScore = score; best = out; }
    }
    return best.map((row) => row.map((v) => v === 1));
}

// Exposé pour les tests de non-régression (vecteurs de référence). Sans effet sur le rendu.
export const _internals = { encodeData, assemble, eccOf, formatBits, VERS };
