// SPDX-License-Identifier: AGPL-3.0-or-later
// Vigie : serveur minimal (API, flux temps réel, proxy de tuiles, démo)
// Principes : aucun journal de requêtes, aucune IP conservée, tout vit en mémoire et expire.

import http from 'node:http';
import https from 'node:https';
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { randomBytes, timingSafeEqual, createHash, createHmac, createECDH, createPrivateKey, sign } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompress, gzip, constants as zlib } from 'node:zlib';
import { promisify } from 'node:util';
import { pipeline } from 'node:stream';
import { Config } from './config.js';
import { openPmtiles } from './pmtiles.mjs';
import { cleanCode, medicPrint, MEDIC_CODE_RE, PRINT_RE } from './public/js/codes.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const VIGIE_VERSION = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const PUBLIC_DIR = path.join(ROOT, 'public');
const TILE_DIR = path.join(ROOT, 'cache', 'tiles');

// Refuse de démarrer plutôt que de tourner dégradé sans le dire
function fatal(msg) {
    console.error(`Vigie ne démarre pas : ${msg}`);
    process.exit(1);
}

// Tuiles auto-hébergées : archive PMTiles explicite (variable PMTILES) ou tiles.pmtiles à la racine,
// lue par plages ; sans archive, repli sur le proxy OpenStreetMap plus bas, en dev seulement : en ligne
// (HOST posé), ce repli enverrait la zone regardée à OpenStreetMap et écrirait des tuiles sur le disque.
const PMTILES_PATH = Config.pmtilesPath || (existsSync(path.join(ROOT, 'tiles.pmtiles')) ? path.join(ROOT, 'tiles.pmtiles') : null);
if (!PMTILES_PATH && Config.host) fatal('pas de carte (tiles.pmtiles). Télécharge-la d\'abord avec npm run carte.');
let tiles = null;
// Ce que le téléphone doit savoir du fond : zoom maximal (au-delà, il agrandit), mention à afficher,
// et une version qui change avec l'archive, pour qu'aucun cache ne garde les anciennes tuiles.
// type : 'vector' (la carte de France, dessinée par le téléphone) ou 'raster' (images toutes faites).
let tileInfo = { type: 'raster', minZoom: 0, maxZoom: 19, attribution: '© contributeurs OpenStreetMap', version: 'osm' };
if (PMTILES_PATH) {
    try {
        tiles = await openPmtiles(PMTILES_PATH);
        const st = await stat(PMTILES_PATH);
        tileInfo = {
            type: tiles.header.tileType === 1 ? 'vector' : 'raster',
            minZoom: tiles.header.minZoom,
            maxZoom: tiles.header.maxZoom,
            // Carte vectorielle : données OpenStreetMap mises en forme par Protomaps (mention obligatoire)
            attribution: tiles.header.tileType === 1 ? Config.mapAttribution : (tiles.metadata.attribution || tileInfo.attribution),
            version: createHash('sha256').update(`${st.size}:${st.mtimeMs}`).digest('hex').slice(0, 8),
        };
        console.log(`Tuiles : archive PMTiles ${PMTILES_PATH} (zooms ${tiles.header.minZoom} à ${tiles.header.maxZoom})`);
    } catch (e) {
        fatal(`carte ${PMTILES_PATH} illisible (${e.message}). Refais-la avec npm run carte.`);
    }
}

// HTTPS : certificat explicite (variables CERT/KEY), ou cert/vigie.crt + cert/vigie.key à la racine pour
// tester sur le Wi-Fi. Derrière Caddy (HOST posé), jamais de détection automatique : un dossier cert/
// recopié par erreur ferait parler Vigie en https à Caddy, qui attend du http (panne totale).
const localCert = (f) => (!Config.host && existsSync(path.join(ROOT, 'cert', f)) ? path.join(ROOT, 'cert', f) : null);
const CERT_PATH = Config.tlsCert || localCert('vigie.crt');
const KEY_PATH = Config.tlsKey || localCert('vigie.key');
let tlsOptions = null;
if (CERT_PATH && KEY_PATH) {
    try {
        tlsOptions = { cert: await readFile(CERT_PATH), key: await readFile(KEY_PATH) };
    } catch (e) {
        console.error(`Certificat illisible (${e.message}) : démarrage en http.`);
    }
}

const MIN = 60_000;
const GRID = 0.0005; // environ 50 m : on ne stocke jamais un point plus précis
const REPORT_TYPES = new Set(['charge', 'nasse', 'gaz', 'eau', 'tirs', 'interp', 'tension', 'agressif', 'filtrage', 'ferme']);
const HELP_TYPES = new Set(['blesse', 'gaze', 'malaise', 'isole']);
const ID_RE = /^[a-f0-9]{16}$/;
const VOTER_RE = /^[a-f0-9]{16,32}$/; // le téléphone n'envoie que 16 ou 32 caractères
const GROUP_RE = /^[a-f0-9]{32}$/;   // adresse du relais binôme : SHA-256 du secret de groupe, 16 octets
const MEMBER_RE = /^[a-f0-9]{16}$/;  // id de membre (aléatoire, local au téléphone)
const TILE_RE = /^\/tiles\/(\d{1,2})\/(\d{1,7})\/(\d{1,7})\.(?:png|mvt)$/;

const reports = new Map();
const helps = new Map();
const buddies = new Map(); // groupId -> Map(memberId -> { blob, at }) : relais binôme, contenu chiffré
let buddyEntries = 0;      // messages présents dans le relais, tous groupes confondus
const powSeen = new Map(); // digest -> fenêtre : anti-rejeu des preuves de travail (élagué par fenêtre)
const pairings = new Map(); // code court -> { id, key, at } : partage d'une cellule par code court (réutilisable)
const streams = new Set();

// Code medic : en démo toujours « medic-demo » (jamais le vrai, qui serait affiché) ; en vrai, obligatoire,
// long, et jamais écrit dans un journal
// (16 caractères au moins : tiré au hasard, par exemple `openssl rand -hex 12`, il est impossible à deviner)
if (!Config.demo && (!Config.medicCode || Config.medicCode.length < 16 || Config.medicCode === 'a-remplacer')) {
    fatal('MEDIC_CODE manquant, trop court (16 caractères au moins, tirés au hasard) ou encore à « a-remplacer ».');
}
const medicCode = Config.demo ? 'medic-demo' : Config.medicCode;

// Codes des collectifs de medics : le serveur ne connaît que leurs empreintes (voir public/js/codes.js),
// sans nom, une par ligne dans Config.medicList. Saisi, il ne révèle ni les codes ni les collectifs.
// La liste est relue quand le fichier change (au plus une fois par seconde) : ajouter ou couper un
// collectif ne redémarre rien, donc n'efface rien. Fichier absent ou illisible : aucun code de collectif.
let medicPrints = new Set();
const medicListSeen = { at: 0, mtime: -1 };
function currentMedicPrints() {
    if (!Config.medicList || now() - medicListSeen.at < 1000) return medicPrints;
    medicListSeen.at = now();
    try {
        const { mtimeMs } = statSync(Config.medicList);
        if (mtimeMs !== medicListSeen.mtime) {
            medicListSeen.mtime = mtimeMs;
            medicPrints = new Set(readFileSync(Config.medicList, 'utf8').split('\n')
                .map((l) => cleanCode(l.replace(/#.*/, ''))).filter((p) => PRINT_RE.test(p)));
        }
    } catch {
        medicPrints = new Set();
        medicListSeen.mtime = -1;
    }
    return medicPrints;
}

const BASE_HEADERS = {
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'Cross-Origin-Resource-Policy': 'same-origin',
    // Une page qui ouvre Vigie ne garde aucune prise sur son onglet (ni le remplacer, ni le lire)
    'Cross-Origin-Opener-Policy': 'same-origin',
    // Caméra autorisée pour la même origine seulement (scan du QR de parrainage, flux jamais envoyé).
    'Permissions-Policy': 'camera=(self), microphone=(), interest-cohort=()',
    'Content-Security-Policy': [
        "default-src 'self'",
        "img-src 'self' data:",
        "style-src 'self' 'unsafe-inline'",
        "script-src 'self'",
        "connect-src 'self'",
        "font-src 'self'",
        "manifest-src 'self'",
        "worker-src 'self'",
        "frame-ancestors 'none'",
        // Pas de formulaire envoyé ailleurs, pas de base d'adresses détournée (défense en profondeur)
        "form-action 'self'",
        "base-uri 'none'",
    ].join('; '),
};

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.webmanifest': 'application/manifest+json',
    '.woff2': 'font/woff2',
    '.json': 'application/json; charset=utf-8',
};

// ---------------------------------------------------------------- outils

const now = () => Date.now();
const newId = () => randomBytes(8).toString('hex');
const snap = (v) => Number((Math.round(v / GRID) * GRID).toFixed(4));

function distanceM(a, b) {
    const rad = (d) => (d * Math.PI) / 180;
    const dLat = rad(b.lat - a.lat);
    const dLng = rad(b.lng - a.lng);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * 6371000 * Math.asin(Math.sqrt(h));
}

// Arrondit le point et refuse ce qui sort de la zone couverte
function cleanPoint(lat, lng) {
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    const p = { lat: snap(lat), lng: snap(lng) };
    const inside = Config.zones.some(([, [w, s, e, n]]) => p.lng >= w && p.lng <= e && p.lat >= s && p.lat <= n);
    return inside ? p : null;
}

// ---------------------------------------------------------------- secteurs (carrés d'environ 50 km)
// Chaque danger et chaque demande d'aide appartient à un secteur (tuile de zoom Config.sectorZoom).
// Un téléphone s'abonne aux secteurs autour de sa position (?s=x.y,x.y) : le serveur apprend donc où il
// est à 50 km près (les tuiles de carte demandées le disent déjà plus finement), jamais la position GPS
// exacte.
const SECTOR_RE = /^\d{1,4}\.\d{1,4}$/;

function sectorOf(lat, lng) {
    const n = 2 ** Config.sectorZoom;
    const r = (lat * Math.PI) / 180;
    const x = Math.floor(((lng + 180) / 360) * n);
    const y = Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n);
    return `${x}.${y}`;
}

// Secteurs demandés (paramètre s), ou null si absent (tout : outils et tests)
// Secteur sous sa seule forme canonique (« 0259.0176 » devient « 259.176 »), dans la grille : sinon un
// même endroit écrit de dix façons comptait dix fois (relevés de vent, budget du service météo)
function normSector(s) {
    if (!SECTOR_RE.test(String(s))) return null;
    const [x, y] = String(s).split('.').map(Number);
    const n = 2 ** Config.sectorZoom;
    return x < n && y < n ? `${x}.${y}` : null;
}

function sectorsOf(url) {
    const raw = url.searchParams.get('s');
    if (raw === null) return null;
    return new Set(raw.split(',').map(normSector).filter(Boolean).slice(0, Config.maxSectors));
}
const inSectors = (set, item) => !set || set.has(item.sector);

function sameSecret(given, expected) {
    const a = Buffer.from(String(given || ''));
    const b = Buffer.from(String(expected || ''));
    return a.length > 0 && a.length === b.length && timingSafeEqual(a, b);
}

// ---------------------------------------------------------------- preuve de travail (anti-spam sans IP)
function hasLeadingZeroBits(buf, bits) {
    let i = 0;
    let b = bits;
    while (b >= 8) { if (buf[i] !== 0) return false; i++; b -= 8; }
    return b === 0 || (buf[i] >>> (8 - b)) === 0;
}

// Le sujet est lié au contenu de la requête : un flood doit résoudre un puzzle par action distincte.
// L'en-tête X-Pow vaut "fenêtre.nonce". Coûteux à produire côté client, un seul hachage ici.
// bits : Config.powBits (signalements, votes, codes courts) ou Config.powBitsUrgent (aide, binôme).
function powOk(subject, header, bits = Config.powBits) {
    if (!bits) return true;
    // Filet mémoire : au plafond, on oublie les solutions les plus anciennes (jamais de refus général,
    // sinon remplir cette table bloquerait toute action protégée du pays, demandes d'aide comprises)
    if (powSeen.size >= Config.maxPowSeen) {
        let n = Math.ceil(Config.maxPowSeen / 10);
        for (const k of powSeen.keys()) { powSeen.delete(k); if (--n <= 0) break; }
    }
    const h = String(header || '');
    const dot = h.indexOf('.');
    if (dot < 1) return false;
    const bucket = Number(h.slice(0, dot));
    const nonce = h.slice(dot + 1);
    if (!Number.isInteger(bucket) || !/^\d{1,20}$/.test(nonce)) return false;
    const nowBucket = Math.floor(now() / Config.powWindowMs);
    // Fenêtre courante, précédente, ou suivante : un téléphone un peu en avance (moins de 5 min) n'est
    // plus refusé. Le ménage de powSeen reste juste (une entrée d'avance vit une fenêtre de plus).
    if (bucket < nowBucket - 1 || bucket > nowBucket + 1) return false;
    const digest = createHash('sha256').update(`${subject}|${bucket}|${nonce}`).digest();
    if (!hasLeadingZeroBits(digest, bits)) return false;
    const key = digest.toString('hex').slice(0, 24);
    if (powSeen.has(key)) return false; // une solution ne sert qu'une fois
    powSeen.set(key, bucket);
    return true;
}

// Refus de preuve : avec l'heure du serveur, pour que le téléphone corrige son horloge et recommence
const powRefused = (res) => json(res, 429, { error: 'Preuve de travail requise ou invalide.', now: now() });

// ---------------------------------------------------------------- cellules de confiance
// Une cellule est une clé tirée au hasard sur un téléphone, qui circule de la main à la main (QR ou
// code) : n'importe qui en crée une et la fait grandir en la faisant scanner. Pas d'admin, pas de
// graine : le serveur ne connaît pas les cellules. Quand un membre confirme un danger, son téléphone
// joint une marque, HMAC(clé, "vigie:vu:" + id du signalement) sur 8 octets, que le serveur se
// contente de relayer. Seuls les membres de la cellule savent la reconnaître (« vu par ta cellule ») ;
// elle change d'un signalement à l'autre (rien à relier) et ne se recopie pas sur un autre signalement.

const TAG_RE = /^[a-f0-9]{16}$/;
const CELL_ID_RE = /^[a-f0-9]{8}$/;   // 4 octets
const CELL_KEY_RE = /^[a-f0-9]{20}$/; // 10 octets

// Marque de cellule : une seule par votant. paid = vote de confirmation dont la preuve de travail vient
// d'être vérifiée (acceptée même si le plafond de votants est atteint : de faux votants ne bloquent pas
// les vrais membres) ; sinon, le votant doit déjà être compté (marque posée après un signalement).
function addTag(r, voter, tag, paid = false) {
    if (!TAG_RE.test(String(tag || '')) || r.tagged.has(voter)) return false;
    if (!paid && !r.voters.has(voter)) return false;
    const known = r.tags.has(String(tag)); // un autre membre de la même cellule : même marque
    if ((!known && r.tags.size >= Config.maxCellTags) || r.tagged.size >= 2 * Config.maxCellTags) return false;
    r.tagged.add(voter);
    // Heure de la PREMIÈRE observation, jamais rafraîchie : la marque est publique dans le flux, n'importe
    // qui pourrait la recopier pour garder « vu par ta cellule » en vie pendant des heures. Limite assumée :
    // un membre qui reconfirme plus tard ne fait pas revenir le badge.
    if (!known) r.tags.set(String(tag), now());
    return true;
}

// Code court de partage : le téléphone confie sa cellule au serveur sous un code de 8 caractères,
// réutilisable pendant 12 h à partir de sa création (jamais prolongé), pour qui ne peut pas scanner.
// Seule entorse au « le serveur ne connaît pas les cellules » : pendant ce temps, il pourrait
// reconnaître ses marques. Le QR et le code long ne passent jamais par le serveur. Chaque essai de
// code coûte une preuve de travail : deviner un code au hasard (40 bits) devient hors de portée.
const PAIR_TTL = Config.pairTtlMin * MIN;
const CODE_ALPH = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function newCode(taken) {
    let c;
    do { c = Array.from({ length: 8 }, () => CODE_ALPH[randomBytes(1)[0] % 32]).join(''); } while (taken.has(c));
    return c;
}
// Tolère les confusions de saisie (I et L -> 1, O -> 0, U -> V), les tirets et les minuscules
const normCode = (s) => String(s || '').toUpperCase()
    .replace(/I/g, '1').replace(/L/g, '1').replace(/O/g, '0').replace(/U/g, 'V')
    .replace(/[^0-9A-Z]/g, '');

async function pairCell(req, res) {
    const b = await readJson(req);
    const id = String(b?.id || '');
    const key = String(b?.key || '');
    if (!CELL_ID_RE.test(id) || !CELL_KEY_RE.test(key)) return json(res, 400, { error: 'Cellule invalide.' });
    if (!powOk(`pair|${id}`, req.headers['x-pow'])) return powRefused(res);
    // Réutilise le code encore valable de cette cellule (avec le temps qui lui reste), sinon en crée un
    for (const [p, v] of pairings) {
        if (v.id === id && v.key === key && now() - v.at <= PAIR_TTL) return json(res, 201, { pin: p, ttlMs: PAIR_TTL - (now() - v.at) });
    }
    // Au plafond, on refuse (une éviction laisserait un flood effacer les vrais codes)
    if (pairings.size >= Config.maxPairings) return json(res, 503, { error: 'Trop de codes courts en cours : partage plutôt le QR.' });
    const pin = newCode(pairings);
    pairings.set(pin, { id, key, at: now() });
    return json(res, 201, { pin, ttlMs: PAIR_TTL });
}

async function claimCell(req, res) {
    const b = await readJson(req);
    const pin = normCode(b?.pin);
    if (!powOk(`claim|${pin}`, req.headers['x-pow'])) return powRefused(res);
    const e = pairings.get(pin);
    if (!e || now() - e.at > PAIR_TTL) { if (e) pairings.delete(pin); return json(res, 404, { error: 'Code court inconnu ou expiré.' }); }
    return json(res, 200, { id: e.id, key: e.key });
}

function json(res, status, body) {
    if (status === 204) {
        res.writeHead(204, BASE_HEADERS);
        return res.end();
    }
    res.writeHead(status, { ...BASE_HEADERS, 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
}

// Corps JSON uniquement (Content-Type application/json) : un formulaire ou un lien posté depuis un
// autre site ne peut pas déclencher une action ici (et servir à un flood réparti chez les visiteurs)
function readJson(req, limit = 2048) {
    return new Promise((resolve) => {
        if (!String(req.headers['content-type'] || '').startsWith('application/json')) {
            req.resume(); // on jette le corps
            resolve(null);
            return;
        }
        const chunks = [];
        let size = 0;
        req.on('data', (c) => {
            size += c.length;
            if (size > limit) {
                resolve(null);
                req.destroy();
            } else {
                chunks.push(c);
            }
        });
        req.on('end', () => {
            try {
                resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
            } catch {
                resolve(null);
            }
        });
        req.on('error', () => resolve(null));
    });
}

// ---------------------------------------------------------------- signalements

// Nasse et sortie fermée : jamais de « peut-être terminé » sur des votes anonymes. Ce serait le seul
// signal qui dit « tu peux y aller » : quelques faux votes suffiraient à y attirer les gens.
const NO_ENDED = new Set(['nasse', 'ferme']);

// Ce qui est public reste grossier : l'heure à la minute et le nombre de téléphones par paliers, 1, 2, 3,
// 5 et plus, 10 et plus (assez pour juger un danger, pas pour suivre la foule vote par vote). Limite : un
// signalement est diffusé à l'instant où il arrive, l'arrondi n'empêche pas de le relier au téléphone
// qu'on a vu envoyer quelque chose au même moment (voir SECURITE.md).
const toMinute = (ms) => Math.floor(ms / MIN) * MIN;
const tier = (n) => (n >= 10 ? 10 : n >= 5 ? 5 : n);
// « Ce n'est plus là » : jamais d'effacement par des votes (deux faux votes feraient disparaître une vraie
// nasse), seulement un « peut-être terminé » affiché ; l'expiration fait le reste
const isEnded = (r) => !NO_ENDED.has(r.type) && r.gone.size >= Math.max(Config.goneThreshold, r.voters.size);

function publicReport(r) {
    const t = now();
    return {
        id: r.id,
        type: r.type,
        lat: r.lat,
        lng: r.lng,
        updatedAt: toMinute(r.updatedAt),
        confirmations: tier(r.voters.size),
        confirmed: r.voters.size >= Config.confirmThreshold,
        ended: isEnded(r),
        // Marques de cellule : chaque téléphone y cherche la sienne. Une marque ne vaut que tant que sa propre
        // observation est récente : des confirmations anonymes rafraîchissent l'heure du danger, pas elle.
        tags: [...r.tags].filter(([, at]) => t - at < Config.reportTtlMin * MIN).map(([tag]) => tag),
    };
}

// Index par secteur, et photo JSON de chaque secteur gardée jusqu'à son prochain changement : après un
// redémarrage, des milliers de téléphones qui se reconnectent ne font pas recalculer la même liste
const bySector = new Map();   // secteur -> Set de signalements
const sectorJson = new Map(); // secteur -> leurs versions publiques, en JSON (sans crochets)

function addReport(r) {
    reports.set(r.id, r);
    if (!bySector.has(r.sector)) bySector.set(r.sector, new Set());
    bySector.get(r.sector).add(r);
    sectorJson.delete(r.sector);
}

function sectorSnapshot(sector) {
    // Secteur vide ou inventé : rien à garder (sinon chaque secteur demandé resterait en mémoire pour toujours)
    if (!bySector.has(sector)) return '';
    let s = sectorJson.get(sector);
    if (s === undefined) {
        s = [...(bySector.get(sector) || [])].map((r) => JSON.stringify(publicReport(r))).join(',');
        sectorJson.set(sector, s);
    }
    return s;
}
const snapshotOf = (sectors) => `[${[...sectors].map(sectorSnapshot).filter(Boolean).join(',')}]`;

// Envoie un évènement aux flux abonnés au secteur (ou à tous si sector est null). Un flux qui ne lit
// plus (téléphone parti, ou attaque qui ouvre des flux sans les lire) est coupé avant de remplir la mémoire.
function sendFrame(res, frame) {
    if (res.writableLength > 65_536) { res.destroy(); streams.delete(res); return; }
    res.vigieLastAt = now();
    res.write(frame);
}

function broadcast(event, data, sector = null) {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of streams) if (!sector || res.vigieSectors.has(sector)) sendFrame(res, frame);
}

// Ne rediffuse que ce qui a changé pour les téléphones, ou au plus une fois par minute pour rafraîchir
// l'heure : un vote sans effet ne doit pas renvoyer tout le signalement à chaque téléphone du secteur
function pushReport(r) {
    sectorJson.delete(r.sector);
    // Clé tirée de ce qui est public, sans construire la version publique pour un vote qui ne change rien
    const key = `${tier(r.voters.size)}|${isEnded(r)}|${r.tags.size}`;
    const t = now();
    if (key === r.pushKey && t - (r.pushedAt || 0) < MIN) return;
    r.pushKey = key;
    r.pushedAt = t;
    broadcast('report', publicReport(r), r.sector);
}

// Au plafond national, chaque secteur garde quand même quelques places
const overCap = (total, max, inSector, maxPerSector) => inSector >= maxPerSector || (total >= max && inSector >= Config.minPerSector);

function removeReport(id) {
    const r = reports.get(id);
    if (!r || !reports.delete(id)) return;
    const set = bySector.get(r.sector);
    set?.delete(r);
    if (set && !set.size) bySector.delete(r.sector);
    sectorJson.delete(r.sector);
    broadcast('remove', { id }, r.sector);
}

async function createReport(req, res) {
    const b = await readJson(req);
    if (!b || !REPORT_TYPES.has(b.type) || typeof b.voter !== 'string' || !VOTER_RE.test(b.voter)) {
        return json(res, 400, { error: 'Signalement invalide.' });
    }
    const pt = cleanPoint(b.lat, b.lng);
    if (!pt) return json(res, 400, { error: 'Ce point est hors de la zone couverte.' });

    // Anti-spam : preuve de travail liée au contenu du signalement
    if (!powOk(`report|${b.type}|${b.lat}|${b.lng}|${b.voter}`, req.headers['x-pow'])) {
        return powRefused(res);
    }

    const t = now();
    // Un signalement envoyé au retour du réseau garde son heure, dans la limite de 10 min
    let at = t;
    if (Number.isFinite(b.observedAt)) {
        if (t - b.observedAt > 10 * MIN) return json(res, 400, { error: 'Signalement trop ancien.' });
        at = Math.min(t, Math.max(b.observedAt, t - 10 * MIN));
    }

    // Même type, tout près, tout récent : c'est le même événement, on compte une confirmation (on ne
    // cherche que dans le secteur du point, pas dans toute la France)
    const sector = sectorOf(pt.lat, pt.lng);
    for (const r of bySector.get(sector) || []) {
        if (r.type !== b.type) continue;
        if (t - r.updatedAt > Config.mergeWindowMin * MIN) continue;
        if (distanceM(r, pt) > Config.mergeRadiusM) continue;
        if (r.voters.size < Config.maxVoters) r.voters.add(b.voter);
        r.gone.clear();
        r.updatedAt = Math.max(r.updatedAt, at);
        pushReport(r);
        return json(res, 200, { id: r.id, merged: true });
    }

    // Au plafond (toute la France, ou le secteur), on refuse le nouveau : jamais d'éviction, sinon un
    // flood de faux dangers dans un coin effacerait les vrais partout
    const inSector = bySector.get(sector)?.size || 0;
    if (overCap(reports.size, Config.maxReports, inSector, Config.maxReportsPerSector)) {
        return json(res, 503, { error: 'Trop de signalements en ce moment dans cette zone : réessaie dans quelques minutes.' });
    }

    const r = {
        id: newId(),
        type: b.type,
        lat: pt.lat,
        lng: pt.lng,
        sector,
        createdAt: at,
        updatedAt: at,
        voters: new Set([b.voter]),
        tags: new Map(),   // marques de cellule -> heure (ajoutées ensuite : l'id n'est connu qu'après création)
        tagged: new Set(), // votants qui ont déjà posé leur marque
        gone: new Set(),
        deleteToken: newId(),
        deleteUntil: t + 2 * MIN,
    };
    addReport(r);
    pushReport(r);
    return json(res, 201, { id: r.id, merged: false, deleteToken: r.deleteToken });
}

async function voteReport(req, res, r, kind) {
    const b = await readJson(req);
    // Annulé ou expiré pendant la lecture du corps : on ne ranime pas un signalement supprimé
    if (reports.get(r.id) !== r) return json(res, 404, { error: 'Signalement introuvable ou expiré.' });
    if (!b || typeof b.voter !== 'string' || !VOTER_RE.test(b.voter)) return json(res, 400, { error: 'Vote invalide.' });
    if (!powOk(`${kind}|${r.id}|${b.voter}`, req.headers['x-pow'])) {
        return powRefused(res);
    }

    if (kind === 'confirm') {
        // Une observation récente l'emporte sur les « ce n'est plus là » plus anciens
        if (r.voters.size < Config.maxVoters) r.voters.add(b.voter);
        if (b.tag) addTag(r, b.voter, b.tag, true);
        r.gone.clear();
        r.updatedAt = now();
        pushReport(r);
        return json(res, 200, publicReport(r));
    }

    // « Ce n'est plus là » ne fait qu'informer (voir publicReport) : le danger reste visible jusqu'à expiration
    if (r.gone.size < Config.maxVoters) r.gone.add(b.voter);
    pushReport(r);
    return json(res, 200, publicReport(r));
}

// Marque de cellule posée juste après un signalement (son id n'était pas connu avant). Pas de preuve
// de travail ici : seul un votant déjà compté, donc qui l'a déjà payée, peut poser la sienne.
async function tagReport(req, res, r) {
    const b = await readJson(req);
    // Annulé ou expiré pendant la lecture du corps : on ne ranime pas un signalement supprimé
    if (reports.get(r.id) !== r) return json(res, 404, { error: 'Signalement introuvable ou expiré.' });
    if (!addTag(r, String(b?.voter || ''), b?.tag)) return json(res, 409, { error: 'Marque refusée.' });
    pushReport(r);
    return json(res, 204);
}

function deleteReport(req, res, r) {
    // Seul l'auteur, avec son jeton, dans les 2 minutes (bouton « Annuler »)
    if (!sameSecret(req.headers['x-delete-token'], r.deleteToken) || now() > r.deleteUntil) {
        return json(res, 403, { error: 'Annulation impossible.' });
    }
    // Confirmé entre-temps par d'autres téléphones : ce n'est plus seulement le sien, il reste
    if (r.voters.size > 1) return json(res, 409, { error: 'D\'autres l\'ont confirmé : il reste affiché.' });
    removeReport(r.id);
    return json(res, 204);
}

// ---------------------------------------------------------------- demandes d'aide (medics seulement)

function publicHelp(h) {
    return { id: h.id, type: h.type, lat: h.lat, lng: h.lng, createdAt: toMinute(h.createdAt), takenAt: h.takenAt && toMinute(h.takenAt) };
}

// Le code du serveur (MEDIC_CODE), ou celui d'un collectif dont l'empreinte est dans la liste. Le
// serveur ne note jamais quel code a vu ou pris quelle demande.
function isMedic(req) {
    const given = req.headers['x-medic-code'];
    if (sameSecret(given, medicCode)) return true;
    const code = cleanCode(given);
    return MEDIC_CODE_RE.test(code) && currentMedicPrints().has(medicPrint(code));
}
const isOwner = (req, h) => sameSecret(req.headers['x-owner-token'], h.ownerToken);

async function createHelp(req, res) {
    const b = await readJson(req);
    if (!b || !HELP_TYPES.has(b.type)) return json(res, 400, { error: 'Demande invalide.' });
    const pt = cleanPoint(b.lat, b.lng);
    if (!pt) return json(res, 400, { error: 'Ce point est hors de la zone couverte.' });
    // Preuve de travail légère (une urgence ne doit pas attendre) : un flood coûte quand même
    if (!powOk(`help|${b.type}|${b.lat}|${b.lng}`, req.headers['x-pow'], Config.powBitsUrgent)) {
        return powRefused(res);
    }
    const sector = sectorOf(pt.lat, pt.lng);
    let inSector = 0;
    for (const hh of helps.values()) if (hh.sector === sector) inSector++;
    // Au plafond, on refuse : une éviction laisserait un flood supprimer les vraies demandes
    if (overCap(helps.size, Config.maxHelps, inSector, Config.maxHelpsPerSector)) {
        return json(res, 503, { error: 'Service saturé : appelle le 112 si c\'est grave.' });
    }
    const h = { id: newId(), type: b.type, lat: pt.lat, lng: pt.lng, sector, createdAt: now(), takenAt: null, ownerToken: newId() };
    helps.set(h.id, h);
    // Alerte en poche des medics du secteur, sauf si la demande a été annulée (touchée par erreur)
    setTimeout(() => { if (helps.has(h.id) && !h.takenAt) notifyMedics(h.sector); }, Config.pushDelayMs);
    return json(res, 201, { id: h.id, ownerToken: h.ownerToken });
}

// ---------------------------------------------------------------- alertes en poche (mode medic)
// Un medic qui les active confie au serveur l'adresse d'alerte de son téléphone (donnée par le service
// de notification de son navigateur) et les secteurs qu'il couvre. À chaque nouvelle demande d'aide
// dans ces secteurs, le serveur y envoie une notification VIDE : ni lieu, ni besoin, il faut ouvrir
// Vigie pour voir. Le service de notification (Google, Apple…) voit seulement que ce téléphone reçoit
// une alerte de Vigie, et quand. Rien n'est écrit : l'adresse est oubliée 12 h après la dernière
// ouverture de Vigie, ou dès que le medic coupe les alertes.
const pushSubs = new Map(); // adresse d'alerte -> { sectors, until, lastSent }

// Clé VAPID : elle signe les envois, pour que seul ce serveur puisse alerter ses abonnés. Tirée du code
// du serveur : la même à chaque redémarrage, sans fichier à écrire (le service n'écrit nulle part).
const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const vapid = (() => {
    const d = (BigInt(`0x${createHmac('sha256', medicCode).update('vigie:vapid').digest('hex')}`) % (P256_N - 1n)) + 1n;
    const priv = Buffer.from(d.toString(16).padStart(64, '0'), 'hex');
    const ecdh = createECDH('prime256v1');
    ecdh.setPrivateKey(priv);
    const pub = ecdh.getPublicKey();
    const jwk = { kty: 'EC', crv: 'P-256', d: priv.toString('base64url'), x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') };
    return { key: createPrivateKey({ key: jwk, format: 'jwk' }), publicKey: pub.toString('base64url') };
})();

// Seulement les services de notification connus : jamais une adresse quelconque donnée par un téléphone
// (sinon le serveur irait frapper où on veut, jusque sur sa propre machine)
function pushUrl(s) {
    if (typeof s !== 'string' || s.length > 1000) return null;
    let u;
    try { u = new URL(s); } catch { return null; }
    if (u.protocol !== 'https:' && !(Config.pushInsecure && u.protocol === 'http:')) return null;
    if (u.username || u.password) return null;
    const host = u.hostname.toLowerCase();
    return Config.pushHosts.some((h) => host === h || host.endsWith(`.${h}`)) ? u : null;
}

function vapidHeader(u) {
    const part = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const claims = { aud: u.origin, exp: Math.floor(now() / 1000) + 3600, sub: `mailto:${Config.contact || 'contact@vigiemap.org'}` };
    const unsigned = `${part({ typ: 'JWT', alg: 'ES256' })}.${part(claims)}`;
    const sig = sign('sha256', Buffer.from(unsigned), { key: vapid.key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
    return `vapid t=${unsigned}.${sig}, k=${vapid.publicKey}`;
}

function sendPush(endpoint) {
    const u = pushUrl(endpoint);
    if (!u) return pushSubs.delete(endpoint);
    const req = (u.protocol === 'https:' ? https : http).request(u, {
        method: 'POST',
        timeout: 10_000,
        headers: { TTL: '600', Urgency: 'high', 'Content-Length': '0', Authorization: vapidHeader(u) },
    }, (r) => {
        r.resume();
        // Abonnement mort (appli désinstallée, autorisation retirée) : oublié aussitôt
        if (r.statusCode === 404 || r.statusCode === 410) pushSubs.delete(endpoint);
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => { /* service injoignable : l'alerte est perdue, la demande reste visible dans l'appli */ });
    req.end();
}

function notifyMedics(sector) {
    const t = now();
    for (const [endpoint, s] of pushSubs) {
        if (t > s.until) { pushSubs.delete(endpoint); continue; }
        if (!s.sectors.has(sector) || t - s.lastSent < Config.pushMinGapMs) continue;
        s.lastSent = t;
        sendPush(endpoint);
    }
}

async function pushSubscribe(req, res, sectors) {
    if (!isMedic(req)) return json(res, 403, { error: 'Réservé aux medics.' });
    if (!sectors?.size) return json(res, 400, { error: 'Secteurs manquants.' });
    const b = await readJson(req, 1500);
    if (!pushUrl(b?.endpoint)) return json(res, 400, { error: 'Adresse d\'alerte refusée.' });
    const prev = pushSubs.get(b.endpoint);
    // Au plafond, on refuse les nouveaux : un flood ne fait jamais perdre ses alertes à un vrai medic
    if (!prev && pushSubs.size >= Config.maxPushSubs) return json(res, 503, { error: 'Alertes saturées : garde Vigie ouverte.' });
    pushSubs.set(b.endpoint, { sectors, until: now() + Config.pushTtlMin * MIN, lastSent: prev?.lastSent || 0 });
    return json(res, 200, { ttlMin: Config.pushTtlMin });
}

// Couper ses alertes : il suffit de connaître son adresse d'alerte (secrète), pas besoin du code medic
async function pushUnsubscribe(req, res) {
    const b = await readJson(req, 1500);
    if (typeof b?.endpoint === 'string') pushSubs.delete(b.endpoint);
    return json(res, 204);
}

// ---------------------------------------------------------------- binôme (relais de groupe, contenu chiffré)
// Le serveur n'est qu'une boîte aux lettres par groupe : il garde le dernier blob CHIFFRÉ de chaque
// membre et son horodatage, et ça expire. Il ne connaît ni les prénoms, ni les statuts, ni les positions
// (chiffrés de bout en bout avec la clé de groupe, échangée en personne). L'adresse du relais est tirée
// du secret du groupe (16 octets) : impossible à deviner, donc impossible de lire ou de remplir le relais
// d'un groupe qu'on ne connaît pas. Garde-fous anti-spam : preuve de travail légère, membres et taille bornés.

async function buddyPost(req, res, gid) {
    const b = await readJson(req, 1200);
    // Un vrai message chiffré fait moins de 300 caractères : 600, c'est de la marge, pas de la place à remplir
    if (!b || typeof b.member !== 'string' || !MEMBER_RE.test(b.member) || typeof b.blob !== 'string' || b.blob.length < 16 || b.blob.length > 600
        || typeof b.token !== 'string' || !/^[a-f0-9]{32}$/.test(b.token)) {
        return json(res, 400, { error: 'Message binôme invalide.' });
    }
    if (!powOk(`buddy|${gid}|${b.member}`, req.headers['x-pow'], Config.powBitsUrgent)) {
        return powRefused(res);
    }
    let g = buddies.get(gid);
    const isNew = !g?.has(b.member);
    // Au plafond (messages de tous les groupes confondus), on refuse les nouveaux membres : jamais
    // d'éviction, et un membre déjà présent peut toujours mettre son message à jour (une alarme passe)
    if (isNew && buddyEntries >= Config.maxBuddyEntries) return json(res, 503, { error: 'Relais saturé : réessaie dans quelques minutes.' });
    if (!g) {
        g = new Map();
        buddies.set(gid, g);
    }
    if (isNew && g.size >= Config.buddyMaxMembers) return json(res, 429, { error: 'Groupe plein.' });
    // Jeton d'écriture : le premier message d'un membre fixe l'empreinte de son jeton ; ensuite, seul
    // ce téléphone peut remplacer son message (personne ne peut effacer une alarme « interpellé·e »)
    const tok = createHash('sha256').update(b.token).digest('hex');
    const prev = g.get(b.member);
    if (prev && !sameSecret(prev.tok, tok)) return json(res, 403, { error: 'Ce membre a déjà un autre téléphone.' });
    if (!prev) buddyEntries++;
    g.set(b.member, { blob: b.blob, at: now(), tok });
    return json(res, 201, { ok: true });
}

function buddyList(gid) {
    const g = buddies.get(gid);
    // Sans l'heure de réception : le message chiffré porte déjà la sienne, lue par le binôme seulement
    return g ? [...g.entries()].map(([member, v]) => ({ member, blob: v.blob })) : [];
}

// ---------------------------------------------------------------- vent (pour savoir où part le gaz)

// Un relevé par secteur, au centre du secteur : le service météo ne voit qu'une région de 50 km
const winds = new Map(); // secteur -> { data, at }
// Un relevé de plus de 30 min n'est plus le vent d'en ce moment : mieux vaut rien qu'une flèche fausse
const WIND_MAX_AGE = 30 * MIN;
const freshWind = (w) => (w?.data && now() - w.data.at < WIND_MAX_AGE ? w.data : null);

// Seulement pour un secteur qui touche une zone couverte, et au plus 60 appels sortants par minute :
// personne ne peut faire griller le quota du service météo en demandant des secteurs au hasard
const tile2lng = (x, n) => (x / n) * 360 - 180;
const tile2lat = (y, n) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;
let windCalls = { minute: 0, n: 0, day: 0, nDay: 0 };

async function getWind(sector) {
    sector = normSector(sector);
    if (!sector) return null;
    const [sx, sy] = sector.split('.').map(Number);
    const n = 2 ** Config.sectorZoom;
    const [w0, e0, n0, s0] = [tile2lng(sx, n), tile2lng(sx + 1, n), tile2lat(sy, n), tile2lat(sy + 1, n)];
    if (!Config.zones.some(([, [w, s, e, nn]]) => e0 >= w && w0 <= e && n0 >= s && s0 <= nn)) return null;
    let w = winds.get(sector);
    if (w && now() - w.at < Config.windRefreshMin * MIN) return freshWind(w);
    // 60 appels sortants par minute, et 8 000 par jour : sous le quota gratuit d'Open-Meteo (environ 10 000),
    // sinon il refuserait le serveur jusqu'au lendemain et plus personne n'aurait le vent
    const minute = Math.floor(now() / MIN);
    const day = Math.floor(now() / 86_400_000);
    if (windCalls.minute !== minute) windCalls = { ...windCalls, minute, n: 0 };
    if (windCalls.day !== day) windCalls = { ...windCalls, day, nDay: 0 };
    if (windCalls.n >= 60 || windCalls.nDay >= 8000) return freshWind(w);
    windCalls.n++;
    windCalls.nDay++;
    if (!w) {
        if (winds.size >= 2000) winds.delete(winds.keys().next().value);
        w = { data: null, at: 0 };
        winds.set(sector, w);
    }
    w.at = now();
    try {
        const lng = tile2lng(sx + 0.5, n);
        const lat = tile2lat(sy + 0.5, n);
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(2)}&longitude=${lng.toFixed(2)}`
            + '&current=wind_speed_10m,wind_direction_10m&wind_speed_unit=kmh';
        const r = await fetch(url, { signal: AbortSignal.timeout(6000) });
        const j = await r.json();
        const d = j?.current?.wind_direction_10m;
        const v = j?.current?.wind_speed_10m;
        if (!Number.isFinite(d) || !Number.isFinite(v)) throw new Error('réponse inattendue');
        w.data = { fromDeg: d, speedKmh: Math.round(v), at: now() };
    } catch {
        // Raté (réseau, service en panne) : on garde la dernière valeur, et on réessaie dans une minute
        // au lieu de priver tout le secteur de vent pendant 10 min
        w.at = now() - (Config.windRefreshMin - 1) * MIN;
    }
    return freshWind(w);
}

// ---------------------------------------------------------------- flux temps réel (SSE)

// Un flux = les secteurs regardés (obligatoires : jamais toute la France d'un coup), dans la limite
// du plafond de connexions simultanées
// Ouvrir un flux coûte une preuve de travail légère (paramètre pow, EventSource ne permet pas d'en-tête) :
// remplir les places du serveur n'est plus gratuit.
function openStream(req, res, sectors, url) {
    if (!sectors || !sectors.size) return json(res, 400, { error: 'Secteurs manquants.' });
    // Preuve normale (pas la légère) : une place de flux est une ressource nationale, chacune doit coûter
    if (!powOk(`stream|${url.searchParams.get('s')}`, url.searchParams.get('pow'))) {
        return powRefused(res);
    }
    if (streams.size >= Config.maxStreams) return json(res, 503, { error: 'Serveur saturé : réessaie dans un instant.' });
    res.vigieLastAt = now();
    res.writeHead(200, {
        ...BASE_HEADERS,
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
    });
    res.vigieSectors = sectors;
    res.write('retry: 3000\n\n');
    res.write(`event: snapshot\ndata: ${snapshotOf(sectors)}\n\n`);
    streams.add(res);
    // Photo pas lue au bout de 5 s (flux ouvert pour rien) : coupé tout de suite, sans attendre le
    // prochain battement, pour qu'une masse de flux muets ne garde pas leurs photos en mémoire
    const unread = setTimeout(() => { if (res.writableLength > 65_536) { res.destroy(); streams.delete(res); } }, 5000);
    // Durée de vie de 20 à 30 min : une place prise doit être repayée (preuve de travail), sinon une seule
    // machine les gardait toutes pour toujours. Le téléphone se reconnecte aussitôt, sans passer
    // « hors ligne ». Limite : ça renchérit l'attaque, ça ne l'empêche pas.
    const renew = setTimeout(() => res.end('event: renouvelle\ndata: {}\n\n'), (20 + Math.random() * 10) * MIN);
    req.on('close', () => {
        clearTimeout(unread);
        clearTimeout(renew);
        streams.delete(res);
    });
}

// ---------------------------------------------------------------- routes API

async function api(req, res, url) {
    const [, , resource, id, action] = url.pathname.split('/');
    const m = req.method;
    // Une page d'un autre site ne peut pas se servir des navigateurs de ses visiteurs contre l'API
    // (flood réparti, ouverture de flux en masse) : les navigateurs annoncent l'origine de la requête
    if (req.headers['sec-fetch-site'] === 'cross-site') return json(res, 403, { error: 'Requête refusée.' });
    const sectors = sectorsOf(url);

    // « Tout effacer » sur le téléphone : demande au navigateur de vider aussi son cache et ses données
    // pour ce site (ce que le code de l'appli ne peut pas faire seul)
    if (resource === 'efface' && m === 'POST') {
        res.writeHead(204, { ...BASE_HEADERS, 'Clear-Site-Data': '"cache", "storage"' });
        return res.end();
    }

    if (resource === 'config' && m === 'GET') {
        return json(res, 200, {
            // Heure du serveur : le téléphone corrige sa propre horloge (une horloge décalée faisait
            // refuser toutes ses actions, demande d'aide comprise)
            now: now(),
            center: Config.center,
            zoom: Config.zoom,
            reportTtlMin: Config.reportTtlMin,
            // Durées promises à l'écran : l'appli les affiche telles que CE serveur les applique
            helpTtlMin: Config.helpTtlMin,
            buddyTtlMin: Config.buddyTtlMin,
            pairTtlMin: Config.pairTtlMin,
            windRefreshMin: Config.windRefreshMin,
            // Code source de cette instance (licence AGPL : à montrer à qui l'utilise), s'il est publié
            sourceUrl: Config.sourceUrl,
            contact: Config.contact,
            vapidKey: vapid.publicKey,
            pushTtlMin: Config.pushTtlMin,
            confirmThreshold: Config.confirmThreshold,
            maxCellTags: Config.maxCellTags,
            buddyWindowMin: Config.buddyWindowMin,
            powBits: Config.powBits,
            powBitsUrgent: Config.powBitsUrgent,
            powWindowMs: Config.powWindowMs,
            alertRadiusM: Config.alertRadiusM,
            tiles: tileInfo,
            sectorZoom: Config.sectorZoom,
            maxSectors: Config.maxSectors,
            demo: Config.demo,
            demoPosition: Config.demo ? Config.demoPosition : null,
            demoMedicCode: Config.demo ? medicCode : null,
        });
    }
    if (resource === 'stream' && m === 'GET') return openStream(req, res, sectors, url);
    if (resource === 'wind' && m === 'GET') return json(res, 200, (await getWind(url.searchParams.get('s'))) || { unavailable: true });

    if (resource === 'cell') {
        if (id === 'pair' && m === 'POST') return pairCell(req, res);
        if (id === 'claim' && m === 'POST') return claimCell(req, res);
    }

    if (resource === 'buddy' && GROUP_RE.test(id || '')) {
        if (m === 'POST') return buddyPost(req, res, id);
        if (m === 'GET') return json(res, 200, buddyList(id));
    }

    if (resource === 'reports') {
        // Toujours par secteurs (au plus Config.maxSectors) : jamais toute la France d'un coup
        // Lecture directe : en démo seulement (outils et tests). L'appli lit tout par le flux, qui exige une
        // preuve de travail ; sans elle, quelques requêtes sur des secteurs pleins occupaient le serveur.
        if (!id && m === 'GET') {
            if (!Config.demo) return json(res, 404, { error: 'Introuvable.' });
            if (!sectors?.size) return json(res, 400, { error: 'Secteurs manquants.' });
            res.writeHead(200, { ...BASE_HEADERS, 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
            return res.end(snapshotOf(sectors));
        }
        if (!id && m === 'POST') return createReport(req, res);
        const r = ID_RE.test(id || '') ? reports.get(id) : null;
        if (!r) return json(res, 404, { error: 'Signalement introuvable ou expiré.' });
        if (!action && m === 'DELETE') return deleteReport(req, res, r);
        if (action === 'confirm' && m === 'POST') return voteReport(req, res, r, 'confirm');
        if (action === 'gone' && m === 'POST') return voteReport(req, res, r, 'gone');
        if (action === 'tag' && m === 'POST') return tagReport(req, res, r);
    }

    if (resource === 'push' && !id) {
        if (m === 'POST') return pushSubscribe(req, res, sectors);
        if (m === 'DELETE') return pushUnsubscribe(req, res);
    }

    if (resource === 'help') {
        if (!id && m === 'POST') return createHelp(req, res);
        if (!id && m === 'GET') {
            if (!isMedic(req)) return json(res, 403, { error: 'Réservé aux medics.' });
            if (!sectors?.size) return json(res, 400, { error: 'Secteurs manquants.' });
            return json(res, 200, [...helps.values()].filter((h) => inSectors(sectors, h)).map(publicHelp));
        }
        const h = ID_RE.test(id || '') ? helps.get(id) : null;
        if (!h) return json(res, 404, { error: 'Demande introuvable ou expirée.' });
        if (!action && m === 'GET') {
            if (!isOwner(req, h)) return json(res, 403, { error: 'Accès refusé.' });
            return json(res, 200, { status: h.takenAt ? 'taken' : 'waiting' });
        }
        if (!action && m === 'DELETE') {
            if (!isOwner(req, h)) return json(res, 403, { error: 'Accès refusé.' });
            helps.delete(h.id);
            return json(res, 204);
        }
        if (action === 'take' && m === 'POST') {
            if (!isMedic(req)) return json(res, 403, { error: 'Réservé aux medics.' });
            h.takenAt = h.takenAt || now();
            return json(res, 200, publicHelp(h));
        }
    }

    return json(res, 404, { error: 'Route inconnue.' });
}

// ---------------------------------------------------------------- tuiles et fichiers

async function serveTile(res, z, x, y) {
    const zi = Number(z);
    const max = 2 ** zi;
    if (zi > 19 || Number(x) >= max || Number(y) >= max) return json(res, 404, { error: 'Tuile inconnue.' });

    // Ni cache du navigateur, ni date : les tuiles regardées trahiraient, sur un téléphone saisi, une
    // chronologie datée des lieux. Seul le hors-ligne de l'appli les garde, et pas plus de deux jours.
    const send = (buf, type = 'image/png', encoding = null) => {
        res.sendDate = false;
        res.writeHead(200, {
            ...BASE_HEADERS,
            'Content-Type': type,
            'Cache-Control': 'no-store',
            ...(encoding ? { 'Content-Encoding': encoding } : {}),
        });
        res.end(buf);
    };

    // Auto-hébergé : la tuile vient de l'archive PMTiles, aucun appel réseau. Une tuile absente de la
    // carte vectorielle (mer, hors de France) est simplement vide.
    if (tiles) {
        const t = await tiles.getTile(zi, Number(x), Number(y));
        if (t) return send(t.data, t.mime, t.encoding);
        res.writeHead(tileInfo.type === 'vector' ? 204 : 404, BASE_HEADERS);
        return res.end();
    }

    if (zi < 3) return json(res, 404, { error: 'Tuile inconnue.' });

    // Repli dev : proxy OpenStreetMap + cache disque
    const file = path.join(TILE_DIR, z, x, `${y}.png`);
    try {
        return send(await readFile(file));
    } catch {
        // Pas encore en cache : on va la chercher, une seule fois pour tout le monde
    }
    const url = Config.tileUrl.replace('{z}', z).replace('{x}', x).replace('{y}', y);
    try {
        // La politique d'usage d'OpenStreetMap demande un User-Agent qui identifie l'appli
        const up = await fetch(url, { headers: { 'User-Agent': `Vigie/${VIGIE_VERSION} (carte de manifestation)` }, signal: AbortSignal.timeout(8000) });
        if (!up.ok) throw new Error(String(up.status));
        const buf = Buffer.from(await up.arrayBuffer());
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, buf);
        send(buf);
    } catch {
        res.writeHead(502, BASE_HEADERS);
        res.end();
    }
}

// Fichiers texte compressés une fois pour toutes (brotli, sinon gzip) : sur un réseau saturé,
// chaque kilo-octet en moins compte. Recompressés seulement si le fichier change.
const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.svg', '.webmanifest', '.json']);
const packed = new Map();

// Version du cache hors ligne : une empreinte de tout public/, calculée au démarrage et écrite dans le
// service worker servi. Chaque mise en ligne d'un fichier modifié change le service worker, donc les
// téléphones reprennent toute l'appli, sans numéro de version à changer à la main (un oubli laissait des
// téléphones avec un mélange d'ancienne et de nouvelle appli).
const SW_FILE = path.join(PUBLIC_DIR, 'sw.js');
const OG_IMAGE = '/og.png'; // image d'aperçu des liens partagés (balises og: de index.html)
const APP_VERSION = (() => {
    const h = createHash('sha256');
    const walk = (dir) => {
        for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
            const f = path.join(dir, e.name);
            if (e.isDirectory()) {
                walk(f);
            } else {
                h.update(path.relative(PUBLIC_DIR, f));
                h.update(readFileSync(f));
            }
        }
    };
    walk(PUBLIC_DIR);
    return h.digest('hex').slice(0, 12);
})();
// Étiquettes de cache : tirées de la taille et de la date du fichier, mais jamais en clair (la date dirait
// quand le code a été modifié). Elles changent à chaque redémarrage : une seule revalidation de plus.
const TAG_SALT = randomBytes(16);
const etagOf = (s, extra = '') => `"${createHmac('sha256', TAG_SALT).update(`${s.size}:${s.mtimeMs}:${extra}`).digest('base64url').slice(0, 16)}"`;
const brotliAsync = promisify(brotliCompress);
const gzipAsync = promisify(gzip);

// Compression hors du fil principal, une seule fois par fichier même si 100 téléphones le demandent en
// même temps (après un redémarrage, la compression synchrone gelait le serveur plusieurs secondes)
function pack(file, s) {
    const sw = file === SW_FILE;
    // La version de l'appli entre dans l'étiquette du service worker : sinon un téléphone qui demande
    // « toujours le même ? » recevrait « oui » alors que la version écrite dedans a changé
    const tag = etagOf(s, sw ? APP_VERSION : '');
    const hit = packed.get(file);
    if (hit && hit.tag === tag) return hit.ready;
    const ready = (async () => {
        let raw = await readFile(file);
        if (sw) raw = Buffer.from(raw.toString('utf8').replace(/const VERSION = '[^']*';/, `const VERSION = 'vigie-${APP_VERSION}';`));
        const [br, gz] = await Promise.all([
            brotliAsync(raw, { params: { [zlib.BROTLI_PARAM_QUALITY]: 11 } }),
            gzipAsync(raw, { level: 9 }),
        ]);
        return { tag, raw, br, gz };
    })();
    packed.set(file, { tag, ready });
    ready.catch(() => packed.delete(file));
    return ready;
}

async function serveStatic(req, res, pathname) {
    let rel;
    try {
        rel = decodeURIComponent(pathname);
    } catch {
        return json(res, 400, { error: 'Adresse invalide.' });
    }
    if (rel === '/') rel = '/index.html';
    const file = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!file.startsWith(PUBLIC_DIR + path.sep)) return json(res, 404, { error: 'Introuvable.' });
    // Seulement les types de fichiers de l'appli : une copie de sauvegarde ou un fichier caché oublié
    // dans public/ n'est jamais servi
    if (!MIME[path.extname(file)] || path.basename(file).startsWith('.')) return json(res, 404, { error: 'Introuvable.' });
    let s;
    try {
        s = await stat(file);
        if (!s.isFile()) throw new Error('dossier');
    } catch {
        return json(res, 404, { error: 'Introuvable.' });
    }

    const ext = path.extname(file);
    const headers = {
        ...BASE_HEADERS,
        // L'aperçu des liens peut être affiché par une messagerie ou un réseau depuis son propre site
        ...(rel === OG_IMAGE ? { 'Cross-Origin-Resource-Policy': 'cross-origin' } : {}),
        'Content-Type': MIME[ext] || 'application/octet-stream',
        // Toujours revalidé, mais un fichier inchangé ne se retélécharge pas (réponse 304 vide)
        'Cache-Control': 'no-cache',
        Vary: 'Accept-Encoding',
    };

    if (!COMPRESSIBLE.has(ext)) {
        const tag = etagOf(s);
        if (req.headers['if-none-match'] === tag) {
            res.writeHead(304, { ...headers, ETag: tag });
            return res.end();
        }
        res.writeHead(200, { ...headers, ETag: tag, 'Content-Length': s.size });
        if (req.method === 'HEAD') return res.end();
        // Un fichier qui disparaît pendant l'envoi (déploiement) ne doit pas faire tomber le serveur
        return pipeline(createReadStream(file), res, () => { /* connexion fermée ou fichier disparu */ });
    }

    const p = await pack(file, s);
    if (req.headers['if-none-match'] === p.tag) {
        res.writeHead(304, { ...headers, ETag: p.tag });
        return res.end();
    }
    const accept = String(req.headers['accept-encoding'] || '');
    let body = p.raw;
    if (/\bbr\b/.test(accept)) {
        body = p.br;
        headers['Content-Encoding'] = 'br';
    } else if (/\bgzip\b/.test(accept)) {
        body = p.gz;
        headers['Content-Encoding'] = 'gzip';
    }
    res.writeHead(200, { ...headers, ETag: p.tag, 'Content-Length': body.length });
    res.end(req.method === 'HEAD' ? undefined : body);
}

// ---------------------------------------------------------------- démo

function demoVoters(n) {
    return new Set(Array.from({ length: n }, () => randomBytes(16).toString('hex')));
}

function demoReport(type, base, dLat, dLng, minutesAgo, votes) {
    const t = now() - minutesAgo * MIN;
    const lat = snap(base[0] + dLat);
    const lng = snap(base[1] + dLng);
    const r = {
        id: newId(),
        type,
        lat,
        lng,
        sector: sectorOf(lat, lng),
        createdAt: t - 2 * MIN,
        updatedAt: t,
        voters: demoVoters(votes),
        tags: new Map(),
        tagged: new Set(),
        gone: new Set(),
        deleteToken: newId(),
        deleteUntil: 0,
    };
    addReport(r);
    return r;
}

function seedDemo() {
    const me = Config.demoPosition;
    const c = Config.demoCenter;
    demoReport('charge', me, 0.0011, 0.0009, 1, 4);
    demoReport('tirs', me, -0.0013, 0.0021, 0, 1); // non confirmé
    demoReport('gaz', c, 0.0005, -0.0016, 3, 2);
    demoReport('nasse', c, -0.0031, -0.0021, 8, 5);
    demoReport('eau', c, 0.0029, 0.0031, 12, 3);
    demoReport('interp', c, -0.0009, 0.0042, 5, 3);

    const help = (type, dLat, dLng, minutesAgo, taken) => {
        const lat = snap(c[0] + dLat);
        const lng = snap(c[1] + dLng);
        const h = {
            id: newId(), type, lat, lng, sector: sectorOf(lat, lng),
            createdAt: now() - minutesAgo * MIN, takenAt: taken ? now() : null, ownerToken: newId(),
        };
        helps.set(h.id, h);
    };
    help('blesse', 0.0008, -0.0005, 2, false);
    help('gaze', -0.0018, 0.0012, 1, false);
    help('malaise', 0.0016, 0.0024, 6, true);

    // Toutes les 30 s : une confirmation ou un nouveau signalement, pour voir la carte vivre
    setInterval(() => {
        const unsure = [...reports.values()].filter((r) => r.voters.size < Config.confirmThreshold);
        if (unsure.length && Math.random() < 0.6) {
            const r = unsure[Math.floor(Math.random() * unsure.length)];
            r.voters.add(randomBytes(16).toString('hex'));
            r.updatedAt = now();
            pushReport(r);
            return;
        }
        const types = [...REPORT_TYPES];
        const type = types[Math.floor(Math.random() * types.length)];
        const r = demoReport(type, c, (Math.random() - 0.5) * 0.009, (Math.random() - 0.5) * 0.012, 0, 1);
        pushReport(r);
        if (reports.size > 12) {
            const oldest = [...reports.values()].sort((a, b) => a.updatedAt - b.updatedAt)[0];
            removeReport(oldest.id);
        }
    }, 30_000);
}

// ---------------------------------------------------------------- démarrage

// Ménage : tout ce qui a expiré disparaît, sans trace
setInterval(() => {
    const t = now();
    for (const r of reports.values()) {
        if (t - r.updatedAt > Config.reportTtlMin * MIN) removeReport(r.id);
    }
    for (const h of helps.values()) {
        if (t - h.createdAt > Config.helpTtlMin * MIN) helps.delete(h.id);
    }
    for (const [gid, g] of buddies) {
        for (const [mid, v] of g) {
            if (t - v.at > Config.buddyTtlMin * MIN && g.delete(mid)) buddyEntries--;
        }
        if (g.size === 0) buddies.delete(gid);
    }
    const nb = Math.floor(t / Config.powWindowMs);
    for (const [k, bk] of powSeen) if (bk < nb - 1) powSeen.delete(k);
    for (const [pin, v] of pairings) if (t - v.at > PAIR_TTL) pairings.delete(pin);
    for (const [endpoint, s] of pushSubs) if (t > s.until) pushSubs.delete(endpoint);
    // Vent : un secteur que personne n'a demandé depuis 30 min est oublié (sinon la liste dirait où et
    // quand Vigie a servi, jusqu'au redémarrage)
    for (const [sec, w] of winds) if (t - w.at > WIND_MAX_AGE) winds.delete(sec);
}, 20_000);

// Battement par flux : seulement si CE flux n'a rien reçu depuis 45 s (chaque battement réveille la radio
// du téléphone). C'est un vrai évènement, que le téléphone voit : sans nouvelles depuis 70 s, il sait que
// son flux est mort et se reconnecte, au lieu d'afficher « En direct » à tort.
setInterval(() => {
    const t = now();
    for (const res of streams) if (t - (res.vigieLastAt || 0) >= 45_000) sendFrame(res, 'event: ping\ndata: 0\n\n');
}, 15_000);

const handler = async (req, res) => {
    let url;
    try {
        url = new URL(req.url, 'http://vigie');
    } catch {
        res.writeHead(400, BASE_HEADERS);
        return res.end();
    }
    const { pathname } = url;
    // Une page d'un autre site ne fait pas travailler le serveur par les navigateurs de ses visiteurs
    // (tuiles en image, fichiers, API) ; ouvrir Vigie depuis un lien reste possible (navigation)
    // (Sauf l'image d'aperçu des liens partagés : faite pour être affichée par d'autres sites.) Une
    // navigation dans une iframe d'un autre site est refusée aussi : seule la page entière compte.
    const topLevel = req.headers['sec-fetch-mode'] === 'navigate' && req.headers['sec-fetch-dest'] === 'document';
    if (req.headers['sec-fetch-site'] === 'cross-site' && !topLevel && pathname !== OG_IMAGE) {
        return json(res, 403, { error: 'Requête refusée.' });
    }
    try {
        if (pathname.startsWith('/api/')) return await api(req, res, url);
        const tile = TILE_RE.exec(pathname);
        if (tile && req.method === 'GET') return await serveTile(res, ...tile.slice(1));
        if (req.method === 'GET' || req.method === 'HEAD') return await serveStatic(req, res, pathname);
        return json(res, 405, { error: 'Méthode non autorisée.' });
    } catch (e) {
        // Aucune donnée de requête dans les erreurs : seulement le message
        console.error('Erreur :', e.message);
        if (!res.headersSent) json(res, 500, { error: 'Erreur serveur.' });
    }
};

const server = tlsOptions ? https.createServer(tlsOptions, handler) : http.createServer(handler);
// Derrière Caddy : garder les connexions inactives plus longtemps que lui, sinon une requête peut partir
// sur une connexion que Node vient de fermer et revenir en erreur 502
server.keepAliveTimeout = 75_000;
server.headersTimeout = 80_000;

server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
        console.error(`Le port ${Config.port} est déjà utilisé : un autre Vigie tourne sans doute en fond. Arrête-le, ou change de port avec --port=4322.`);
        process.exit(1);
    }
    throw e;
});

if (Config.demo) seedDemo();

server.listen(Config.port, Config.host || undefined, () => {
    const scheme = tlsOptions ? 'https' : 'http';
    console.log(`Vigie : ${scheme}://localhost:${Config.port}${Config.demo ? ' (démo)' : ''}`);
    if (!tlsOptions) console.log('  http : caméra, binôme et hors-ligne ne marchent que sur localhost ; pour un téléphone, fournis un certificat (voir docs/developpement.md).');
    if (!Config.medicCode) console.log(`Code medic : ${medicCode}`);
});
