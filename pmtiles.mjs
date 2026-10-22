// SPDX-License-Identifier: AGPL-3.0-or-later
// Vigie : codec PMTiles v3 (lecteur par plages + écrivain) pour la carte auto-hébergée.
// Sans dépendance (zlib de Node). Fidèle à la spec PMTiles v3 pour rester interopérable avec
// l'outil officiel `pmtiles`. Lecture de n'importe quelle archive (raster ou vectorielle, jusqu'à la
// France entière) par plages dans le fichier. Écriture avec un index à un ou deux niveaux (racine +
// feuilles), suffisant pour de petites archives ; les grosses se font avec l'outil `pmtiles`.

import { open, writeFile } from 'node:fs/promises';
import { gzipSync, gunzipSync, brotliDecompressSync } from 'node:zlib';
import { createHash } from 'node:crypto';

// ------------------------------------------------------------ identifiant Hilbert d'une tuile z/x/y
export function zxyToTileId(z, x, y) {
    let acc = 0;
    for (let t = 0; t < z; t++) acc += Math.pow(4, t); // tuiles des zooms inférieurs
    const n = 1 << z;
    let d = 0;
    let xx = x;
    let yy = y;
    for (let s = n >> 1; s > 0; s = Math.floor(s / 2)) {
        const rx = (xx & s) > 0 ? 1 : 0;
        const ry = (yy & s) > 0 ? 1 : 0;
        d += s * s * ((3 * rx) ^ ry);
        if (ry === 0) {
            if (rx === 1) { xx = s - 1 - xx; yy = s - 1 - yy; }
            const tmp = xx; xx = yy; yy = tmp;
        }
    }
    return acc + d;
}

// ------------------------------------------------------------ varints (LEB128 non signé)
function writeVarint(arr, n) {
    while (n >= 128) { arr.push((n % 128) + 128); n = Math.floor(n / 128); }
    arr.push(n);
}
function readVarint(buf, p) {
    let shift = 0;
    let result = 0;
    let b;
    do {
        b = buf[p++];
        result += (b & 0x7f) * Math.pow(2, shift);
        shift += 7;
    } while (b & 0x80);
    return [result, p];
}

// ------------------------------------------------------------ répertoires (entrées triées par tileId)
function serializeDirectory(entries) {
    const a = [];
    writeVarint(a, entries.length);
    let last = 0;
    for (const e of entries) { writeVarint(a, e.tileId - last); last = e.tileId; }
    for (const e of entries) writeVarint(a, e.runLength);
    for (const e of entries) writeVarint(a, e.length);
    for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        if (i > 0 && e.offset === entries[i - 1].offset + entries[i - 1].length) writeVarint(a, 0);
        else writeVarint(a, e.offset + 1);
    }
    return Buffer.from(a);
}
function deserializeDirectory(buf) {
    let p = 0;
    let n;
    [n, p] = readVarint(buf, p);
    const entries = new Array(n);
    let last = 0;
    for (let i = 0; i < n; i++) { let d; [d, p] = readVarint(buf, p); last += d; entries[i] = { tileId: last, runLength: 0, length: 0, offset: 0 }; }
    for (let i = 0; i < n; i++) { let v; [v, p] = readVarint(buf, p); entries[i].runLength = v; }
    for (let i = 0; i < n; i++) { let v; [v, p] = readVarint(buf, p); entries[i].length = v; }
    for (let i = 0; i < n; i++) {
        let v;
        [v, p] = readVarint(buf, p);
        entries[i].offset = (v === 0 && i > 0) ? entries[i - 1].offset + entries[i - 1].length : v - 1;
    }
    return entries;
}

// Recherche d'une tuile : entrée exacte, run (tuiles identiques), ou pointeur de feuille (runLength 0)
function findTile(entries, tileId) {
    let lo = 0;
    let hi = entries.length - 1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (tileId < entries[mid].tileId) hi = mid - 1;
        else if (tileId > entries[mid].tileId) lo = mid + 1;
        else return entries[mid];
    }
    if (hi >= 0) {
        const e = entries[hi];
        if (e.runLength === 0) return e;
        if (tileId - e.tileId < e.runLength) return e;
    }
    return null;
}

const TILE_TYPES = { png: 2, jpeg: 3, jpg: 3, webp: 4, avif: 5, mvt: 1, pbf: 1 };
const TYPE_MIME = { 1: 'application/vnd.mapbox-vector-tile', 2: 'image/png', 3: 'image/jpeg', 4: 'image/webp', 5: 'image/avif' };

// ------------------------------------------------------------ en-tête (127 octets, little-endian)
function writeHeader(f) {
    const h = Buffer.alloc(127);
    h.write('PMTiles', 0, 'ascii');
    h.writeUInt8(3, 7);
    const u64 = (v, off) => h.writeBigUInt64LE(BigInt(v), off);
    u64(f.rootOffset, 8); u64(f.rootLength, 16);
    u64(f.metaOffset, 24); u64(f.metaLength, 32);
    u64(f.leafOffset, 40); u64(f.leafLength, 48);
    u64(f.tileDataOffset, 56); u64(f.tileDataLength, 64);
    u64(f.addressedTiles, 72); u64(f.tileEntries, 80); u64(f.tileContents, 88);
    h.writeUInt8(1, 96);                 // clustered
    h.writeUInt8(2, 97);                 // compression interne : gzip
    h.writeUInt8(f.tileComp, 98);        // compression des tuiles
    h.writeUInt8(f.tileType, 99);
    h.writeUInt8(f.minZoom, 100);
    h.writeUInt8(f.maxZoom, 101);
    h.writeInt32LE(f.minLonE7, 102);
    h.writeInt32LE(f.minLatE7, 106);
    h.writeInt32LE(f.maxLonE7, 110);
    h.writeInt32LE(f.maxLatE7, 114);
    h.writeUInt8(f.minZoom, 118);        // zoom central
    h.writeInt32LE(f.centerLonE7, 119);
    h.writeInt32LE(f.centerLatE7, 123);
    return h;
}
function readHeader(buf) {
    if (buf.slice(0, 7).toString('ascii') !== 'PMTiles' || buf[7] !== 3) throw new Error('Pas un PMTiles v3.');
    const u64 = (off) => Number(buf.readBigUInt64LE(off));
    return {
        rootOffset: u64(8), rootLength: u64(16),
        metaOffset: u64(24), metaLength: u64(32),
        leafOffset: u64(40), leafLength: u64(48),
        tileDataOffset: u64(56),
        internalComp: buf[97], tileComp: buf[98], tileType: buf[99],
        minZoom: buf[100], maxZoom: buf[101],
    };
}

const inflateInternal = (b, comp) => (comp === 2 ? gunzipSync(b) : comp === 3 ? brotliDecompressSync(b) : b);

// ------------------------------------------------------------ lecteur
// Lecture par plages dans le fichier : une archive de plusieurs gigaoctets (la France entière) ne
// tient pas en mémoire. Seuls l'en-tête et le répertoire racine sont lus au départ ; les répertoires
// feuilles déjà lus sont gardés en mémoire (les plus récents), les tuiles sont lues à la demande.
export async function openPmtiles(path) {
    const fh = await open(path, 'r');
    const read = async (off, len) => {
        const b = Buffer.alloc(len);
        await fh.read(b, 0, len, off);
        return b;
    };
    const header = readHeader(await read(0, 127));
    const mime = TYPE_MIME[header.tileType] || 'application/octet-stream';
    const rootEntries = deserializeDirectory(inflateInternal(await read(header.rootOffset, header.rootLength), header.internalComp));
    let metadata = {};
    try {
        metadata = JSON.parse(inflateInternal(await read(header.metaOffset, header.metaLength), header.internalComp).toString('utf8'));
    } catch { /* métadonnées absentes ou illisibles : pas grave */ }

    const leaves = new Map(); // offset -> entrées, du plus ancien au plus récent
    async function readLeaf(off, len) {
        let entries = leaves.get(off);
        if (entries) { leaves.delete(off); leaves.set(off, entries); return entries; }
        entries = deserializeDirectory(inflateInternal(await read(off, len), header.internalComp));
        leaves.set(off, entries);
        // 200 feuilles récentes (~26 Mo avec la carte de France à zoom 14, qui en a ~380) : de quoi couvrir
        // une manif dans de nombreuses villes à la fois sans relire et redécompresser sans cesse (~3 ms par
        // feuille, sur le seul fil du serveur). Toutes les garder coûterait 50 Mo, 190 avec une carte à zoom 15.
        if (leaves.size > 200) leaves.delete(leaves.keys().next().value);
        return entries;
    }

    // Renvoie { data, mime, encoding } : les tuiles compressées (gzip) le restent, le serveur les
    // envoie telles quelles (Content-Encoding) et le navigateur les décompresse.
    async function getTile(z, x, y) {
        if (z < header.minZoom || z > header.maxZoom) return null;
        const tileId = zxyToTileId(z, x, y);
        let entries = rootEntries;
        for (let depth = 0; depth < 4; depth++) {
            const e = findTile(entries, tileId);
            if (!e) return null;
            if (e.runLength === 0) { entries = await readLeaf(header.leafOffset + e.offset, e.length); continue; }
            const data = await read(header.tileDataOffset + e.offset, e.length);
            return { data, mime, encoding: header.tileComp === 2 ? 'gzip' : null };
        }
        return null;
    }
    return { header, mime, metadata, getTile, close: () => fh.close() };
}

// ------------------------------------------------------------ écrivain
const tile2lon = (x, z) => (x / Math.pow(2, z)) * 360 - 180;
const tile2lat = (y, z) => {
    const n = Math.PI - (2 * Math.PI * y) / Math.pow(2, z);
    return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
};

// tiles : [{ z, x, y, data:Buffer }] ; type : 'png' | 'webp' | 'jpeg' | 'mvt' ...
export async function writePmtiles(path, tiles, { type = 'png', maxRootBytes = 16000, attribution = '© contributeurs OpenStreetMap' } = {}) {
    if (!tiles.length) throw new Error('Aucune tuile à empaqueter.');
    const tileType = TILE_TYPES[type];
    if (!tileType) throw new Error(`Type de tuile inconnu : ${type}`);

    for (const t of tiles) t.tileId = zxyToTileId(t.z, t.x, t.y);
    tiles.sort((a, b) => a.tileId - b.tileId);

    // Section des tuiles : contenus dédoublonnés, entrées en runs quand c'est possible
    const seen = new Map();
    const chunks = [];
    let dataLen = 0;
    let contents = 0;
    const entries = [];
    let minZoom = 30;
    let maxZoom = 0;
    let minLon = 180;
    let minLat = 90;
    let maxLon = -180;
    let maxLat = -90;
    for (const t of tiles) {
        minZoom = Math.min(minZoom, t.z); maxZoom = Math.max(maxZoom, t.z);
        minLon = Math.min(minLon, tile2lon(t.x, t.z)); maxLon = Math.max(maxLon, tile2lon(t.x + 1, t.z));
        maxLat = Math.max(maxLat, tile2lat(t.y, t.z)); minLat = Math.min(minLat, tile2lat(t.y + 1, t.z));
        const hash = createHash('sha256').update(t.data).digest('hex');
        let loc = seen.get(hash);
        if (!loc) { loc = { offset: dataLen, length: t.data.length }; seen.set(hash, loc); chunks.push(t.data); dataLen += t.data.length; contents++; }
        const last = entries[entries.length - 1];
        if (last && last.offset === loc.offset && last.length === loc.length && last.tileId + last.runLength === t.tileId) last.runLength++;
        else entries.push({ tileId: t.tileId, offset: loc.offset, length: loc.length, runLength: 1 });
    }
    const tileData = Buffer.concat(chunks, dataLen);

    // Index : racine seule si elle tient, sinon racine -> feuilles
    let rootDir = gzipSync(serializeDirectory(entries));
    let leafDir = Buffer.alloc(0);
    if (rootDir.length > maxRootBytes) {
        const leafSize = 4096;
        const leafEntries = [];
        const leafBufs = [];
        let leafOff = 0;
        for (let i = 0; i < entries.length; i += leafSize) {
            const chunk = entries.slice(i, i + leafSize);
            const lb = gzipSync(serializeDirectory(chunk));
            leafEntries.push({ tileId: chunk[0].tileId, offset: leafOff, length: lb.length, runLength: 0 });
            leafBufs.push(lb);
            leafOff += lb.length;
        }
        leafDir = Buffer.concat(leafBufs);
        rootDir = gzipSync(serializeDirectory(leafEntries));
        if (rootDir.length > 16000) throw new Error('Trop de tuiles pour un index à deux niveaux ; utilise le CLI `pmtiles`.');
    }

    const metadata = gzipSync(Buffer.from(JSON.stringify({ name: 'vigie', attribution })));
    const e7 = (v) => Math.round(v * 1e7);
    const rootOffset = 127;
    const metaOffset = rootOffset + rootDir.length;
    const leafOffset = metaOffset + metadata.length;
    const tileDataOffset = leafOffset + leafDir.length;
    const header = writeHeader({
        rootOffset, rootLength: rootDir.length,
        metaOffset, metaLength: metadata.length,
        leafOffset, leafLength: leafDir.length,
        tileDataOffset, tileDataLength: tileData.length,
        addressedTiles: tiles.length, tileEntries: entries.length, tileContents: contents,
        tileComp: 1, tileType, minZoom, maxZoom,
        minLonE7: e7(minLon), minLatE7: e7(minLat), maxLonE7: e7(maxLon), maxLatE7: e7(maxLat),
        centerLonE7: e7((minLon + maxLon) / 2), centerLatE7: e7((minLat + maxLat) / 2),
    });

    await writeFile(path, Buffer.concat([header, rootDir, metadata, leafDir, tileData]));
    return { tiles: tiles.length, contents, minZoom, maxZoom, bytes: 127 + rootDir.length + metadata.length + leafDir.length + tileData.length };
}
