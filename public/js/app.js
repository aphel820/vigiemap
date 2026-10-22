// SPDX-License-Identifier: AGPL-3.0-or-later
// Vigie : application client (carte, signalements, alertes, aide)
// Règle d'or : la position GPS ne quitte jamais le téléphone. On envoie un point
// choisi au viseur, arrondi à environ 50 m.

import { icon, TYPES, HELP_TYPES } from './icons.js';
import { qrMatrix } from './qr.js';
import { solveSync as powSolveInline } from './pow.js';
import { FLAVORS } from '../vendor/protomaps-leaflet/flavors.js';

const L = window.L;
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const MIN = 60_000;
const GRID = 0.0005;

const KEY = {
    secret: 'vigie.secret', // ancienne clé des empreintes de vote : n'est plus écrite, effacée à l'ouverture
    intro: 'vigie.intro',
    theme: 'vigie.theme',
    medic: 'vigie.medic',
    mine: 'vigie.mine',
    queue: 'vigie.queue',
    help: 'vigie.help',
    cache: 'vigie.cache',
    config: 'vigie.config',
    cell: 'vigie.cell',
    buddy: 'vigie.buddy',
    alerts: 'vigie.alerts',
};

// Configuration de secours si le premier chargement se fait sans réseau
const DEFAULT_CONFIG = {
    center: [46.6, 2.5],
    zoom: 6,
    sectorZoom: 9,
    maxSectors: 18,
    reportTtlMin: 25,
    confirmThreshold: 3,
    buddyWindowMin: 30,
    powBits: 16,
    powWindowMs: 5 * 60_000,
    alertRadiusM: 350,
    tiles: { type: 'raster', minZoom: 0, maxZoom: 19, attribution: '© contributeurs OpenStreetMap', version: 'osm' },
    demo: false,
};

// Le stockage local peut être bloqué (navigation privée) : on ne plante jamais pour ça
let wiping = false;
const store = {
    get(k, def) {
        try {
            const v = localStorage.getItem(k);
            return v === null ? def : JSON.parse(v);
        } catch {
            return def;
        }
    },
    set(k, v) {
        if (wiping) return; // « Tout effacer » en cours : plus rien ne se réécrit
        try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* stockage indisponible */ }
    },
};

// Traces datées : ce qui a expiré sur le serveur s'efface aussi du téléphone, dès l'ouverture (une appli
// fermée ne peut rien effacer). Marge large : l'horloge du téléphone n'est pas encore recalée ici.
(function purgeStale() {
    const t = Date.now();
    const old = (at, maxMin) => !Number.isFinite(at) || t - at > maxMin * MIN;
    const mine = store.get(KEY.mine, {});
    if (mine && typeof mine === 'object') {
        store.set(KEY.mine, Object.fromEntries(Object.entries(mine).filter(([, v]) => !old(v?.until, 0))));
    }
    const q = store.get(KEY.queue, []);
    if (Array.isArray(q) && q.length) store.set(KEY.queue, q.filter((b) => !old(b?.observedAt, 30)));
    const c = store.get(KEY.cache, null);
    if (c && old(c.at, 30)) store.set(KEY.cache, null);
    const h = store.get(KEY.help, null);
    if (h && h.at !== undefined && old(h.at, 60)) store.set(KEY.help, null);
    try { localStorage.removeItem(KEY.secret); } catch { /* stockage indisponible */ }
})();

const state = {
    config: DEFAULT_CONFIG,
    reports: new Map(),
    helps: new Map(),
    pos: null,          // [lat, lng] : reste ici, n'est jamais envoyé
    posAt: 0,           // heure de la dernière position reçue
    heading: null,      // boussole, si le téléphone en a une
    live: false,
    lastSync: 0,        // heure du serveur de la dernière nouvelle (comparée à serverNow())
    wind: null,
    mine: new Map(Object.entries(store.get(KEY.mine, {}))),
    voted: new Set(),
    dismissed: new Map(),
    buzzed: new Set(),
    sheet: null,
    aimY: 0,
    medicCode: store.get(KEY.medic, null),
    myHelp: store.get(KEY.help, null),
    cell: store.get(KEY.cell, null),   // { id, key } : la cellule de confiance, tirée sur un téléphone
    buddy: store.get(KEY.buddy, null), // { groupId, seed, member, name } : le binôme
};

let map;
let tileLayer;
let reportLayer;
let helpLayer;
let meMarker = null;
const markers = new Map();
const helpMarkers = new Map();

// ------------------------------------------------------------------ géométrie et textes

const toRad = (d) => (d * Math.PI) / 180;

function distance(a, b) {
    const dLat = toRad(b[0] - a[0]);
    const dLng = toRad(b[1] - a[1]);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLng / 2) ** 2;
    return 2 * 6371000 * Math.asin(Math.sqrt(h));
}

function bearing(a, b) {
    const dLng = toRad(b[1] - a[1]);
    const y = Math.sin(dLng) * Math.cos(toRad(b[0]));
    const x = Math.cos(toRad(a[0])) * Math.sin(toRad(b[0])) - Math.sin(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.cos(dLng);
    return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

const OU = ['au nord', 'au nord-est', 'à l\'est', 'au sud-est', 'au sud', 'au sud-ouest', 'à l\'ouest', 'au nord-ouest'];
const VERS = ['vers le nord', 'vers le nord-est', 'vers l\'est', 'vers le sud-est', 'vers le sud', 'vers le sud-ouest', 'vers l\'ouest', 'vers le nord-ouest'];
const sector = (deg) => Math.round(deg / 45) % 8;
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const snap = (v) => Number((Math.round(v / GRID) * GRID).toFixed(4));

function fmtDist(m) {
    if (m < 1000) return { v: String(Math.max(10, Math.round(m / 10) * 10)), u: 'm' };
    return { v: (m / 1000).toFixed(1).replace('.', ','), u: 'km' };
}

// Les heures viennent du serveur : on les compare à l'heure du serveur, pas à celle du téléphone
function minutesSince(ts) {
    return Math.max(0, Math.floor((serverNow() - ts) / MIN));
}
const ago = (ts) => (minutesSince(ts) < 1 ? 'à l\'instant' : `il y a ${minutesSince(ts)} min`);
// Paliers du serveur : 5 veut dire « 5 à 9 », 10 « 10 ou plus »
const phones = (n) => (n >= 5 ? `${n} téléphones ou plus` : `${n} téléphones`);
const agoShort = (ts) => (minutesSince(ts) < 1 ? '< 1 min' : `${minutesSince(ts)} min`);

// Le navigateur refuse de vibrer tant qu'on n'a pas touché l'écran une première fois
function buzz(pattern) {
    if (navigator.userActivation && !navigator.userActivation.hasBeenActive) return;
    navigator.vibrate?.(pattern);
}

// Flèche orientée : relative au téléphone si on a une boussole, sinon relative au nord (comme la carte).
// Les flèches marquées data-nord restent toujours relatives au nord (celle du vent, alignée sur la carte).
function rotateArrow(el, deg) {
    if (!el.firstChild) el.innerHTML = icon('arrow');
    el.dataset.deg = String(deg);
    const useCompass = state.heading !== null && !('nord' in el.dataset);
    const rel = Math.round(useCompass ? deg - state.heading : deg);
    // Sans boussole (iPhone, beaucoup d'Android), la flèche de l'alerte suit la carte : un « N » le dit
    el.closest('.alert__compass, .windbox__compass')?.classList.toggle('is-nord', !useCompass);
    if (el.dataset.rel === String(rel)) return; // rien n'a bougé : aucun travail pour le navigateur
    el.dataset.rel = String(rel);
    el.style.transform = `rotate(${rel}deg)`;
}

// Quand la boussole bouge, on ne retouche que les flèches, pas le reste de l'écran
function turnArrows() {
    $$('.arrow[data-deg]').forEach((el) => rotateArrow(el, Number(el.dataset.deg)));
}

const visible = () => document.visibilityState === 'visible';

// ------------------------------------------------------------------ identité jetable et réseau

// Clé des empreintes de vote, tirée à chaque ouverture et jamais écrite : un téléphone saisi ne permet pas
// de retrouver ses votes dans la mémoire d'un serveur saisi lui aussi. (Rouvert, un même téléphone peut
// compter une fois de plus sur un même danger : sans gravité, chaque vote coûte une preuve de travail.)
const VOTE_SECRET = [...crypto.getRandomValues(new Uint8Array(32))].map((x) => x.toString(16).padStart(2, '0')).join('');
const secret = () => VOTE_SECRET;

// Empêche de voter deux fois sans jamais envoyer d'identifiant stable :
// l'empreinte change d'un signalement à l'autre, le serveur ne peut pas les relier.
async function voterFor(scope) {
    const msg = `${secret()}:${scope}`;
    if (crypto.subtle) {
        const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(msg));
        return [...new Uint8Array(buf)].slice(0, 16).map((x) => x.toString(16).padStart(2, '0')).join('');
    }
    // Contexte non sécurisé (http sur le réseau local) : empreinte FNV, suffisante pour un prototype
    let h1 = 0x811c9dc5;
    let h2 = 0x01000193;
    for (let i = 0; i < msg.length; i++) {
        h1 = Math.imul(h1 ^ msg.charCodeAt(i), 16777619) >>> 0;
        h2 = Math.imul(h2 ^ msg.charCodeAt(i), 2246822519) >>> 0;
    }
    return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

// ------------------------------------------------------------------ cellule de confiance (parrainage)

const toHex = (bytes) => [...bytes].map((x) => x.toString(16).padStart(2, '0')).join('');
function hexBytes(hex) {
    const out = [];
    for (let i = 0; i < hex.length; i += 2) out.push(parseInt(hex.slice(i, i + 2), 16));
    return out;
}

// Une cellule = { id, key } tirés au hasard sur le téléphone qui la crée. Pas de serveur, pas d'admin :
// elle grandit de la main à la main (QR ou code). Sa marque sur un signalement vaut
// HMAC(clé, "vigie:vu:" + id du signalement), 8 octets : liée à ce signalement (pas recopiable ailleurs),
// différente d'un signalement à l'autre (rien à relier), reconnue seulement par qui connaît la clé.
// Sans Web Crypto (http hors localhost), pas de marque : le niveau ouvert continue de marcher.
async function cellTag(reportId, cell = state.cell) {
    if (!cell || !crypto.subtle) return undefined;
    try {
        const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(cell.key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
        const sig = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(`vigie:vu:${reportId}`));
        return toHex([...new Uint8Array(sig)].slice(0, 8));
    } catch {
        return undefined;
    }
}

// Marques de MA cellule, calculées une fois par signalement : « vu par ta cellule » si le serveur la relaie
const myTags = new Map(); // id du signalement -> marque attendue
const seenByCell = (r) => Boolean(state.cell && r.tags?.length && r.tags.includes(myTags.get(r.id)));

function checkCellTag(r) {
    if (!state.cell || !r.tags?.length || myTags.has(r.id)) return;
    myTags.set(r.id, null); // calcul en cours
    const cell = state.cell;
    cellTag(r.id, cell).then((t) => {
        if (state.cell !== cell) return;
        myTags.set(r.id, t || null);
        const cur = state.reports.get(r.id);
        const m = markers.get(r.id);
        if (cur && m && seenByCell(cur)) { paint(m, markerHtml(cur)); refreshAlert(); }
    });
}

// Change de cellule : on oublie les marques de l'ancienne et on recalcule
function recheckCellTags() {
    myTags.clear();
    for (const r of state.reports.values()) {
        checkCellTag(r);
        const m = markers.get(r.id);
        if (m) paint(m, markerHtml(r));
    }
    refreshAlert();
}

// Pose la marque de ma cellule sur un signalement que je viens d'envoyer (son id n'est connu qu'après)
async function tagAfterReport(id, voter) {
    const tag = await cellTag(id);
    if (!tag) return;
    try { await api('POST', `/api/reports/${id}/tag`, { voter, tag }, {}, 8000); } catch { /* sans gravité */ }
}

function newCell() {
    const rnd = (n) => toHex(crypto.getRandomValues(new Uint8Array(n)));
    return { id: rnd(4), key: rnd(10) };
}

// Code partageable : base32 Crockford de (id 4 octets + clé 10 octets), 23 caractères, plus le type (24).
const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function b32encode(bytes) {
    let bits = 0;
    let val = 0;
    let out = '';
    for (const b of bytes) {
        val = (val << 8) | b;
        bits += 8;
        while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; }
    }
    if (bits > 0) out += B32[(val << (5 - bits)) & 31];
    return out;
}
// Lettres qu'on confond à la lecture ramenées à celles de l'alphabet, séparateurs retirés
const cleanCode = (str) => String(str).toUpperCase().replace(/I/g, '1').replace(/L/g, '1').replace(/O/g, '0').replace(/U/g, 'V').replace(/[^0-9A-Z]/g, '');
function b32decode(str) {
    const clean = cleanCode(str);
    let bits = 0;
    let val = 0;
    const out = [];
    for (const ch of clean) {
        const idx = B32.indexOf(ch);
        if (idx < 0) return null;
        val = (val << 5) | idx;
        bits += 5;
        if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; }
    }
    return out;
}
// Le type du code en dernier caractère : C pour une cellule, B pour un binôme. Un code de l'un, collé ou
// scanné dans l'écran de l'autre, est refusé : sinon un binôme recevait la clé d'une cellule, connue de
// tous ses membres (et du serveur pendant 12 h si elle a un code court), et son chiffrement tombait.
const CODE_TYPE = { cell: 'C', buddy: 'B' };
function typedBytes(code, kind) {
    const c = cleanCode(code);
    return c.length === 24 && c.endsWith(CODE_TYPE[kind]) ? b32decode(c.slice(0, -1)) : null;
}
// Le code est-il celui de l'autre écran ? (pour le dire, plutôt que « code illisible »)
const isOtherCode = (code, kind) => typedBytes(code, kind === 'cell' ? 'buddy' : 'cell') !== null;
const WRONG_CODE = {
    cell: 'C\'est un code de binôme : ouvre « Binôme » pour le rejoindre.',
    buddy: 'C\'est un code de cellule : ouvre « Ma cellule » pour la rejoindre.',
};

const cellToRaw = (cell) => `${b32encode([...hexBytes(cell.id), ...hexBytes(cell.key)])}${CODE_TYPE.cell}`; // 24 car.
const cellToCode = (cell) => cellToRaw(cell).replace(/(.{4})(?=.)/g, '$1-');            // groupé, pour l'affichage
function codeToCell(code) {
    const bytes = typedBytes(code, 'cell');
    if (!bytes || bytes.length < 14) return null;
    const id = toHex(bytes.slice(0, 4));
    const key = toHex(bytes.slice(4, 14));
    return /^[a-f0-9]{8}$/.test(id) && /^[a-f0-9]{20}$/.test(key) ? { id, key } : null;
}

// ------------------------------------------------------------------ transparence
// Journal de ce que CE téléphone envoie au serveur, en mémoire seulement (effacé à la fermeture de
// l'appli) : chacun peut vérifier lui-même qu'aucune position GPS ni identité ne part.
const sentLog = [];
function logSent(method, url, body, headers = {}) {
    sentLog.unshift({ at: Date.now(), method, url, body, headers: Object.keys(headers) });
    if (sentLog.length > 60) sentLog.pop();
    if (state.sheet === 'sheetTransp') renderTransparence();
}

// Heure du serveur : l'horloge d'un téléphone peut être décalée de plusieurs minutes, et la preuve
// anti-spam comme l'heure d'un signalement se calculent sur l'heure du serveur
let clockOffset = 0;
const setClock = (serverMs) => { clockOffset = serverMs - Date.now(); };
const serverNow = () => Date.now() + clockOffset;

// Délai maximum : sur un réseau saturé, une requête sans fin bloquerait l'appli. AbortController plutôt
// qu'AbortSignal.timeout, absent sur iOS 15 : là, les requêtes partaient sans aucun délai.
async function api(method, url, body, headers = {}, timeoutMs = 10_000) {
    logSent(method, url, body, headers);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
        const res = await fetch(url, {
            method,
            headers: body ? { 'Content-Type': 'application/json', ...headers } : headers,
            body: body ? JSON.stringify(body) : undefined,
            cache: 'no-store',
            signal: ctl.signal,
            // Une suppression (annuler, fermer une demande, tout effacer) part même si l'onglet se ferme
            keepalive: method === 'DELETE',
        });
        if (!res.ok) {
            let msg = `Erreur ${res.status}`;
            try {
                const j = await res.json();
                msg = j.error || msg;
                if (Number.isFinite(j.now)) setClock(j.now); // refus de preuve : on corrige l'horloge pour la suite
            } catch { /* corps vide */ }
            const e = new Error(msg);
            e.status = res.status;
            throw e;
        }
        return res.status === 204 ? null : await res.json();
    } finally {
        clearTimeout(timer);
    }
}

// ------------------------------------------------------------------ preuve de travail (anti-spam)
// Le calcul se fait dans un worker (hors thread principal, pas de gel d'UI) ; repli en ligne si besoin.
let powWorker = null; // null = pas encore créé, false = indisponible
let powReqId = 0;
const powPending = new Map();

function powWorkerOrNull() {
    if (powWorker === null) {
        try {
            powWorker = new Worker(new URL('./pow.js', import.meta.url), { type: 'module' });
            powWorker.onmessage = (e) => { const r = powPending.get(e.data.id); if (r) { powPending.delete(e.data.id); r(e.data); } };
            // Worker en panne : les calculs en attente passent tout de suite en ligne (plus 20 s d'attente)
            powWorker.onerror = () => {
                powWorker = false;
                for (const r of powPending.values()) r(null);
                powPending.clear();
            };
        } catch { powWorker = false; }
    }
    return powWorker || null;
}

// Résout la preuve de travail pour un sujet lié au contenu. Renvoie "fenêtre.nonce", ou null (désactivée/échec).
// bits : difficulté normale par défaut ; plus légère (powBitsUrgent) pour l'aide et le binôme. Une
// solution plus difficile que demandé reste valable (assez de zéros), d'où le repli sur powBits.
async function solvePow(subject, bits = state.config.powBits || 0) {
    if (!bits) return null;
    const bucket = Math.floor(serverNow() / (state.config.powWindowMs || 300_000));
    const w = powWorkerOrNull();
    let nonce;
    if (w) {
        const id = ++powReqId;
        const data = await new Promise((resolve) => {
            powPending.set(id, resolve);
            w.postMessage({ id, subject, bits, bucket });
            setTimeout(() => { if (powPending.delete(id)) resolve(null); }, 20_000);
        });
        nonce = data ? data.nonce : (powWorker === false ? powSolveInline(subject, bits, bucket) : -1);
    } else {
        nonce = powSolveInline(subject, bits, bucket);
    }
    return nonce >= 0 ? `${bucket}.${nonce}` : null;
}

// ------------------------------------------------------------------ messages brefs

let toastTimer = 0;

function toast(text, { undo = null, ms = 4000 } = {}) {
    $('#toastText').textContent = text;
    const btn = $('#toastUndo');
    btn.classList.toggle('hidden', !undo);
    btn.onclick = undo ? () => { hideToast(); undo(); } : null;
    const bar = $('#toastBar');
    bar.style.animation = 'none';
    void bar.offsetWidth;
    bar.style.animation = `vide ${ms}ms linear forwards`;
    $('#toast').classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, ms);
}

function hideToast() {
    clearTimeout(toastTimer);
    $('#toast').classList.add('hidden');
}

// ------------------------------------------------------------------ thème

function effectiveTheme() {
    const t = store.get(KEY.theme, 'auto');
    if (t !== 'auto') return t;
    return matchMedia('(prefers-color-scheme: light)').matches ? 'soleil' : 'nuit';
}

// Carte vectorielle (la France entière, dessinée par le téléphone) ou images toutes faites (repli dev).
// La version change avec le fond de carte : ni le navigateur ni le hors-ligne ne gardent les anciennes tuiles
const tilesInfo = () => ({ ...DEFAULT_CONFIG.tiles, ...state.config.tiles });
const isVector = () => tilesInfo().type === 'vector';
const tileUrl = (z, x, y) => `/tiles/${z}/${x}/${y}.${isVector() ? 'mvt' : 'png'}?v=${tilesInfo().version}`;

function applyTheme() {
    const th = effectiveTheme();
    document.documentElement.dataset.theme = th;
    $('meta[name="theme-color"]').setAttribute('content', th === 'soleil' ? '#FFFFFF' : '#16191C');
    const choice = store.get(KEY.theme, 'auto');
    $$('[data-theme-choice]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.themeChoice === choice)));
    // Carte vectorielle : un vrai style nuit, redessiné ; les images, elles, sont assombries en CSS
    if (map && isVector()) setupTiles();
}

// ------------------------------------------------------------------ carte

function initMap() {
    const c = state.config;
    map = L.map('map', {
        center: c.center,
        zoom: c.zoom,
        minZoom: 5, // la France entière tient à l'écran
        maxZoom: 18,
        zoomControl: false,
        attributionControl: true,
        zoomSnap: 1,
        fadeAnimation: false,
    });
    map.attributionControl.setPrefix(false);
    // Petits téléphones : pas de fondu des tuiles, chargement seulement quand la carte s'arrête,
    // et une seule rangée de tuiles d'avance autour de l'écran
    setupTiles();
    // Si on fait glisser la carte en visant, le viseur ne doit plus suivre le GPS
    map.on('dragstart', () => { state.aimTouched = true; });
    map.on('moveend', resubscribe); // les dangers suivent la région affichée
    reportLayer = L.layerGroup().addTo(map);
    helpLayer = L.layerGroup().addTo(map);
}

// (Re)pose le fond de carte selon la configuration et le thème : au démarrage, quand on change de thème,
// et si le serveur a changé de fond
let tileFlavor = null;
function setupTiles() {
    const t = tilesInfo();
    const vector = isVector() && Boolean(window.protomapsL);
    const flavor = vector ? (effectiveTheme() === 'nuit' ? 'dark' : 'light') : 'image';
    const key = `${t.version}:${flavor}`;
    if (tileLayer && tileFlavor === key) return;
    if (tileLayer) map.removeLayer(tileLayer);
    tileFlavor = key;
    map.getContainer().classList.toggle('carte-image', !vector);
    const f = FLAVORS[flavor];
    tileLayer = vector
        ? window.protomapsL.leafletLayer({
            url: tileUrl('{z}', '{x}', '{y}'),
            paintRules: window.protomapsL.paintRules(f),
            labelRules: window.protomapsL.labelRules(f, 'fr'),
            backgroundColor: f.background,
            maxDataZoom: t.maxZoom, // au-delà, le téléphone agrandit les données du dernier zoom
            maxZoom: 18,
            attribution: esc(t.attribution), // affichée en HTML par Leaflet : jamais de balise venue d'une archive
        })
        : L.tileLayer(tileUrl('{z}', '{x}', '{y}'), {
            maxZoom: 18,
            maxNativeZoom: Math.min(18, t.maxZoom), // au-delà du dernier zoom de l'archive, on agrandit
            attribution: esc(t.attribution), // affichée en HTML par Leaflet : jamais de balise venue d'une archive
            updateWhenIdle: true,
            updateWhenZooming: false,
            keepBuffer: 1,
        });
    tileLayer.addTo(map);
}

function markerHtml(r) {
    // Opacité par paliers de 10 % : le marqueur n'est redessiné que quand elle change vraiment
    const life = Math.min(1, Math.max(0, (serverNow() - r.updatedAt) / (state.config.reportTtlMin * MIN)));
    // « Peut-être terminé » : estompé, mais jamais retiré par des votes (ils peuvent être faux)
    const fade = (Math.round((1 - 0.55 * life) * (r.ended ? 0.7 : 1) * 10) / 10).toFixed(1);
    const cls = `mk t-${r.type} ${r.confirmed ? 'is-ok' : 'is-unsure'}${r.ended ? ' is-ended' : ''}`;
    // Nom lu par un lecteur d'écran : le type et son état, pas « ? 3 min »
    const said = `${TYPES[r.type].label}${r.confirmed ? '' : ', pas encore confirmé'}${seenByCell(r) ? ', vu par ta cellule' : ''}, il y a `;
    return `<div class="${cls}" style="--fade:${fade}">`
        + `<span class="sr">${said}</span>`
        + `<span class="mk__plate">${icon(TYPES[r.type].icon)}</span>`
        + (r.confirmed ? '' : '<span class="mk__q" aria-hidden="true">?</span>')
        + (seenByCell(r) ? `<span class="mk__ok" title="Vu par ta cellule">${icon('shield')}</span>` : '')
        + `<span class="mk__age">${agoShort(r.updatedAt)}</span></div>`;
}

const divIcon = (html) => L.divIcon({ className: 'mk-wrap', html, iconSize: [56, 76], iconAnchor: [28, 24] });

// Ne reconstruit le marqueur que si son contenu a changé
function paint(m, html) {
    if (m.vigieHtml === html) return;
    m.vigieHtml = html;
    m.setIcon(divIcon(html));
}

function upsertReport(r) {
    // Le serveur valide déjà tout ; on revérifie quand même ce qui finit dans la page (le cache local et
    // une évolution du serveur passent aussi par ici). hasOwn : « constructor » n'est pas un type.
    if (!r || !Object.hasOwn(TYPES, r.type) || !/^[a-f0-9]{16}$/.test(String(r.id)) || !finite(r.lat) || !finite(r.lng)) return;
    r.confirmations = Number(r.confirmations) || 0;
    state.reports.set(r.id, r);
    checkCellTag(r);
    const m = markers.get(r.id);
    if (m) {
        m.setLatLng([r.lat, r.lng]);
        paint(m, markerHtml(r));
        return;
    }
    const html = markerHtml(r);
    const nm = L.marker([r.lat, r.lng], { icon: divIcon(html), keyboard: true })
        .on('click', () => openDetail(r.id))
        .addTo(reportLayer);
    nm.vigieHtml = html;
    markers.set(r.id, nm);
}

function removeReport(id) {
    state.reports.delete(id);
    const m = markers.get(id);
    if (m) reportLayer.removeLayer(m);
    markers.delete(id);
    if (state.sheet === 'sheetDetail' && $('#sheetDetail').dataset.id === id) closeSheet();
}

function applySnapshot(list) {
    const ids = new Set(list.map((r) => r.id));
    for (const id of [...state.reports.keys()]) if (!ids.has(id)) removeReport(id);
    list.forEach(upsertReport);
    afterChange();
}

function afterChange() {
    state.lastSync = state.live ? serverNow() : state.lastSync;
    refreshAlert();
    persistCache();
}

let cacheTimer = 0;
function persistCache() {
    clearTimeout(cacheTimer);
    cacheTimer = setTimeout(() => store.set(KEY.cache, { at: state.lastSync, reports: [...state.reports.values()] }), 3000);
}

// Au démarrage sans réseau : on affiche les derniers signalements connus, s'ils ne sont pas périmés
function loadCache() {
    const c = store.get(KEY.cache, null);
    if (!c?.reports) return;
    state.lastSync = c.at || 0;
    const ttl = state.config.reportTtlMin * MIN;
    c.reports.filter((r) => serverNow() - r.updatedAt < ttl + MIN).forEach(upsertReport); // + 1 min : voir tick()
}

// ------------------------------------------------------------------ ma position (locale uniquement)

function setPos(ll) {
    const first = !state.pos;
    state.pos = ll;
    state.posAt = Date.now();
    if (!meMarker) {
        meMarker = L.marker(ll, {
            icon: L.divIcon({ className: 'mk-wrap', html: '<div class="me"></div>', iconSize: [24, 24], iconAnchor: [12, 12] }),
            interactive: false,
            keyboard: false,
            zIndexOffset: 1000, // toujours visible, même sous un signalement
        }).addTo(map);
    } else {
        meMarker.setLatLng(ll);
    }
    if (first) map.setView(ll, Math.max(map.getZoom(), 16), { animate: false });
    // Un point plus précis arrive pendant qu'on vise : le viseur le suit, sauf si on a déplacé la carte
    if (document.body.classList.contains('is-aiming') && !state.aimTouched) centerAimOnPos();
    refreshAlert();
    resubscribe(); // en marchant, on finit par changer de secteur
}

// GPS : c'est le premier poste de dépense de la batterie. Par défaut on se contente
// de la position Wi-Fi et antennes (économe, précise à quelques dizaines de mètres en ville),
// et on n'allume le GPS qu'une minute, quand on vise ou qu'on se recentre.
let geoWatch = null;
let geoPrecise = false;
let preciseTimer = 0;
let introSeen = false; // écran des règles lu : la position peut être demandée

// État de la position, montré seulement quand elle manque : ok, off (pas encore autorisée), denied
// (refusée dans le navigateur), lost (pas de signal), none (pas de localisation sur ce téléphone)
let geoState = 'wait';

const POS_TEXTS = {
    off: ['Position désactivée', 'Touche pour l\'activer. Elle reste sur ton téléphone.'],
    denied: ['Position refusée', 'Sans elle, pas d\'alerte quand un danger est proche. Touche pour savoir comment l\'activer.'],
    lost: ['Position introuvable', 'Pas de signal pour l\'instant. Touche pour réessayer.'],
    stale: ['Position perdue', 'Les alertes partent de ta dernière position connue. Touche pour réessayer.'],
    none: ['Pas de position sur ce téléphone', 'La carte marche, mais sans alerte de proximité.'],
};

function setGeoState(s) {
    geoState = s;
    const txt = POS_TEXTS[s];
    $('#posChip').classList.toggle('hidden', !txt);
    if (!txt) return;
    $('#posChipTitle').textContent = txt[0];
    $('#posChipSub').textContent = txt[1];
}

async function onGeoError(err) {
    // Refus ou pas de signal : la carte marche quand même, sans alerte de proximité
    if (err.code !== err.PERMISSION_DENIED) {
        if (!state.pos) setGeoState('lost');
        // Plus de signal depuis 3 min : on le dit, les alertes partent d'un point qui a pu vieillir.
        // (Seulement sur une erreur du téléphone : immobile, on peut ne recevoir aucune position sans souci.)
        else if (Date.now() - state.posAt > 3 * MIN) setGeoState('stale');
        return;
    }
    // Une fenêtre fermée sans répondre compte aussi comme un refus : on regarde si on peut redemander
    let perm = 'denied';
    try { perm = (await navigator.permissions.query({ name: 'geolocation' })).state; } catch { /* API absente */ }
    setGeoState(perm === 'prompt' ? 'off' : 'denied');
}

function onPosChip() {
    if (geoState === 'denied') {
        toast('Autorise la localisation pour ce site : sur Android, touche le cadenas à gauche de l\'adresse, puis « Autorisations ». Sur iPhone : Réglages, Safari, Position.', { ms: 8000 });
    } else if (geoState === 'none') {
        toast('Ce navigateur ne donne pas la position. Essaie avec Chrome ou Safari.', { ms: 6000 });
    } else {
        // Relance la demande (et la fenêtre d'autorisation si besoin), même pendant une minute de GPS
        // précis déjà en cours : sinon le toucher ne faisait rien
        geoPrecise = false;
        preciseFor(60_000);
    }
}

function watchPosition() {
    if (state.config.demo && state.config.demoPosition) {
        if (!state.pos) setPos(state.config.demoPosition);
        return;
    }
    if (!('geolocation' in navigator)) {
        setGeoState('none');
        return;
    }
    stopPosition();
    geoWatch = navigator.geolocation.watchPosition(
        (p) => {
            if (geoState !== 'ok') setGeoState('ok');
            setPos([p.coords.latitude, p.coords.longitude]);
        },
        onGeoError,
        geoPrecise
            ? { enableHighAccuracy: true, maximumAge: 5_000, timeout: 20_000 }
            : { enableHighAccuracy: false, maximumAge: 30_000, timeout: 60_000 },
    );
}

function stopPosition() {
    if (geoWatch !== null) navigator.geolocation.clearWatch(geoWatch);
    geoWatch = null;
}

function preciseFor(ms) {
    clearTimeout(preciseTimer);
    if (!geoPrecise) {
        geoPrecise = true;
        if (visible()) watchPosition();
    }
    preciseTimer = setTimeout(() => {
        geoPrecise = false;
        if (visible()) watchPosition();
    }, ms);
}

// Boussole : le capteur n'est allumé que s'il y a une flèche à orienter à l'écran
let headingTimer = 0;
let compassOn = false;
const COMPASS_EVENT = 'ondeviceorientationabsolute' in window ? 'deviceorientationabsolute' : 'deviceorientation';

function onOrientation(e) {
    if (COMPASS_EVENT === 'deviceorientationabsolute') {
        if (e.alpha !== null) setHeading((360 - e.alpha) % 360);
    } else if (typeof e.webkitCompassHeading === 'number') {
        setHeading(e.webkitCompassHeading);
    }
}

function setHeading(h) {
    // Moins de 4° d'écart : la main tremble, on ne redessine rien
    if (state.heading !== null && Math.abs(((h - state.heading + 540) % 360) - 180) < 4) return;
    state.heading = h;
    if (headingTimer) return;
    headingTimer = setTimeout(() => {
        headingTimer = 0;
        turnArrows();
    }, 250);
}

function syncCompass() {
    const need = visible() && (!$('#alert').classList.contains('hidden') || !$('#gasCard').classList.contains('hidden'));
    if (need === compassOn) return;
    compassOn = need;
    if (need) {
        window.addEventListener(COMPASS_EVENT, onOrientation);
    } else {
        window.removeEventListener(COMPASS_EVENT, onOrientation);
        state.heading = null;
        turnArrows();
    }
}

// ------------------------------------------------------------------ alerte de proximité

// Alertes « fiables » : seulement un danger vu par ta cellule, c'est-à-dire par des gens que tu as fait
// entrer en personne. Le nombre de téléphones ne suffit pas : un attaquant équipé en fabrique autant
// qu'il veut en une seconde. La carte, elle, montre toujours tout.
const trustedOnly = () => store.get(KEY.alerts, 'toutes') === 'fiables';
// Marques saturées : de fausses marques ont pu prendre toute la place, et celle de ta cellule n'a pas pu
// entrer. On ne peut plus rien affirmer : en « Fiables », on prévient quand même, en le disant.
const tagsFull = (r) => (r.tags?.length || 0) >= (state.config.maxCellTags || 50);

function nearestDanger() {
    let best = null;
    let count = 0;
    const strict = trustedOnly();
    for (const r of state.reports.values()) {
        // Ce que tu viens de signaler toi-même, tu le sais déjà : pas d'alerte
        if (state.mine.has(r.id)) continue;
        if (strict && !seenByCell(r) && !tagsFull(r)) continue;
        const d = distance(state.pos, [r.lat, r.lng]);
        if (d > state.config.alertRadiusM) continue;
        count++;
        // Écartée : elle revient quand tu t'en rapproches de moitié, ou si ta cellule la voit ensuite (une
        // simple confirmation n'y suffit pas). Sinon, masquée de loin, elle restait muette même à 30 m.
        const dis = state.dismissed.get(r.id);
        if (dis && d > dis.d / 2 && (dis.cell || !seenByCell(r))) continue;
        // Un signalement confirmé passe devant un non confirmé un peu plus proche, et un danger vu par ta
        // cellule devant tous les autres : une rafale de faux signalements ne le cache plus
        const score = d * (r.confirmed ? 1 : 1.8) * (seenByCell(r) ? 0.4 : 1);
        if (!best || score < best.score) best = { r, d, score };
    }
    if (best) best.others = count - 1;
    return best;
}

let alertKey = '';
let lastBuzz = 0;

function renderAlertChoice() {
    const choice = store.get(KEY.alerts, 'toutes');
    $$('[data-alert-choice]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.alertChoice === choice)));
    const notes = [];
    if (choice === 'fiables' && !state.cell) notes.push('Tu n\'as pas de cellule : en « Fiables », presque aucune alerte ne sonnera.');
    if (!navigator.vibrate) notes.push('Ce téléphone ne vibre pas pour les alertes (c\'est le cas des iPhone) : garde un œil sur l\'écran.');
    $('#alertNote').textContent = notes.join(' ');
    $('#alertNote').classList.toggle('hidden', !notes.length);
}

function refreshAlert() {
    const el = $('#alert');
    const near = state.pos ? nearestDanger() : null;
    if (!near) {
        el.classList.add('hidden');
        el.dataset.id = '';
        alertKey = '';
        $('#alertLive').dataset.said = '';
        $('#alertLive').textContent = '';
        syncCompass();
        return;
    }
    const { r, d, others } = near;
    const t = TYPES[r.type];
    const isNew = el.dataset.id !== r.id || el.classList.contains('hidden');
    const b = bearing(state.pos, [r.lat, r.lng]);

    // Rien de neuf à afficher : on ne touche pas au DOM (la flèche suit quand même)
    const key = [r.id, r.updatedAt, r.confirmations, seenByCell(r), r.ended, Math.round(d / 10), sector(b), others, minutesSince(r.updatedAt)].join('|');
    if (key === alertKey && !isNew) {
        rotateArrow($('#alertArrow'), b);
        return;
    }
    alertKey = key;

    el.className = `alert t-${r.type} ${r.confirmed ? 'is-ok' : 'is-unsure'}`;
    el.dataset.id = r.id;
    $('#alertIcon').innerHTML = icon(t.icon);
    $('#alertTitle').textContent = r.confirmed ? t.label : `${t.label} ?`;

    const lines = [
        `Vu ${ago(r.updatedAt)}`,
        r.confirmations > 1 ? `Signalé par ${phones(r.confirmations)}` : 'Un seul signalement',
    ];
    if (seenByCell(r)) lines.push('Vu par ta cellule');
    else if (tagsFull(r)) lines.push('Impossible de savoir si ta cellule l\'a vu : à vérifier');
    if (r.ended) lines.push('Peut-être fini');
    if (others > 0) lines.push(`Et ${others} autre${others > 1 ? 's' : ''} danger${others > 1 ? 's' : ''} tout près`);
    $('#alertMeta').innerHTML = lines.map((l) => `<span>${l}</span>`).join('');

    const dist = fmtDist(d);
    $('#alertDist').textContent = `${dist.v} ${dist.u}`;
    $('#alertDir').textContent = ` ${OU[sector(b)]}`;
    rotateArrow($('#alertArrow'), b);
    $('#alertMain').setAttribute('aria-label', `${t.label}, ${dist.v} ${dist.u === 'm' ? 'mètres' : 'kilomètres'} ${OU[sector(b)]}. ${lines.join('. ')}`);

    // Lu une fois par danger, et une fois de plus quand il est confirmé
    const said = `${r.id}|${r.confirmed}`;
    if ($('#alertLive').dataset.said !== said) {
        $('#alertLive').dataset.said = said;
        $('#alertLive').textContent = `${r.confirmed ? '' : 'Pas confirmé : '}${t.label}, ${dist.v} ${dist.u === 'm' ? 'mètres' : 'kilomètres'} ${OU[sector(b)]}`;
    }

    if (isNew) {
        el.classList.add('is-enter');
        setTimeout(() => el.classList.remove('is-enter'), 400);
    }

    // Vibration : une fois par signalement, et une seconde fois quand il est confirmé. Au plus une par
    // minute, sauf pour un danger vu par ta cellule : une rafale de faux signalements (posés puis annulés)
    // ne fait plus vibrer les téléphones en continu
    const buzzKey = `${r.id}:${r.confirmed}`;
    if (!state.buzzed.has(buzzKey)) {
        state.buzzed.add(buzzKey);
        if (seenByCell(r) || Date.now() - lastBuzz > MIN) {
            lastBuzz = Date.now();
            buzz(r.confirmed ? t.vibe : [150]);
        }
    }
    syncCompass();
}

// ------------------------------------------------------------------ feuilles

function openSheet(id) {
    closeSheet();
    const el = document.getElementById(id);
    const aiming = el.classList.contains('sheet--map');
    el.classList.remove('hidden');
    $('#scrim').classList.toggle('hidden', aiming);
    document.body.classList.add('has-sheet');
    document.body.classList.toggle('is-aiming', aiming);
    state.sheet = id;
    void el.offsetHeight;
    el.classList.add('is-open');
    if (aiming) {
        state.aimTouched = false;
        preciseFor(60_000); // on vise : GPS précis pendant une minute
        placeAim(el);
    }
    // Sur ordinateur, le premier bouton ; sur téléphone, la feuille elle-même (pas de clavier qui surgit,
    // mais un lecteur d'écran y entre au lieu de rester sur la carte)
    const first = el.querySelector('.tile, .btn, input');
    if (first && !matchMedia('(pointer: coarse)').matches) first.focus({ preventScroll: true });
    else el.focus({ preventScroll: true });
}

function closeSheet() {
    if (!state.sheet) return;
    stopScan(); // coupe la caméra si on fermait la feuille cellule
    const el = document.getElementById(state.sheet);
    el.classList.remove('is-open');
    el.classList.add('hidden');
    $('#scrim').classList.add('hidden');
    $('#viseur').classList.add('hidden');
    document.body.classList.remove('has-sheet', 'is-aiming');
    state.sheet = null;
}

// Le viseur se place au milieu de la carte encore visible, sur ta position si on la connaît
function placeAim(sheetEl) {
    const top = $('.topbar').getBoundingClientRect().bottom;
    const sheetTop = window.innerHeight - sheetEl.offsetHeight;
    state.aimY = Math.round(top + (sheetTop - top) / 2);
    const v = $('#viseur');
    v.style.top = `${state.aimY}px`;
    v.classList.remove('hidden');
    centerAimOnPos();
}

function centerAimOnPos() {
    if (!state.pos) return;
    const p = map.latLngToContainerPoint(state.pos);
    map.panBy([p.x - window.innerWidth / 2, p.y - state.aimY], { animate: false });
}

function aimPoint() {
    const ll = map.containerPointToLatLng([window.innerWidth / 2, state.aimY]);
    return { lat: snap(ll.lat), lng: snap(ll.lng) };
}

// Carte trop dézoomée (sans position, elle montre toute la France) : le point visé tomberait n'importe
// où. On refuse plutôt que de publier un danger ou d'envoyer un medic au hasard ; la feuille reste ouverte.
function aimTooVague() {
    if (map.getZoom() >= 14) return false;
    toast(state.pos ? 'Zoome sur l\'endroit précis, puis choisis.' : 'Position inconnue : zoome sur l\'endroit précis, puis choisis.', { ms: 6000 });
    return true;
}

function tileHtml(key, t, kind, colorClass) {
    return `<button class="tile ${colorClass}" type="button" data-${kind}="${key}">`
        + `${icon(t.icon)}<span class="tile__label">${t.label}</span><span class="tile__hint">${t.hint}</span></button>`;
}

function buildGrids() {
    const types = Object.entries(TYPES);
    $('#reportGrid').innerHTML = types.filter(([, t]) => !t.more).map(([k, t]) => tileHtml(k, t, 'report', `t-${k}`)).join('');
    $('#reportMore').innerHTML = types.filter(([, t]) => t.more).map(([k, t]) => tileHtml(k, t, 'report', `t-${k} tile--mini`)).join('');
    $('#helpGrid').innerHTML = Object.entries(HELP_TYPES).map(([k, t]) => tileHtml(k, t, 'help', 't-aide')).join('');
}

// ------------------------------------------------------------------ signaler un danger

function rememberMine(id, token) {
    state.mine.set(id, { token, tokenUntil: Date.now() + 2 * MIN, until: Date.now() + state.config.reportTtlMin * MIN });
    saveMine();
}

function saveMine() {
    const o = {};
    for (const [id, v] of state.mine) if (v.until > Date.now()) o[id] = v;
    store.set(KEY.mine, o);
}

// N'écrit dans le stockage que si un ancien signalement est vraiment à oublier
function pruneMine() {
    let changed = false;
    for (const [id, v] of state.mine) {
        if (v.until <= Date.now()) {
            state.mine.delete(id);
            changed = true;
        }
    }
    if (changed) saveMine();
}

async function sendReport(type) {
    if (aimTooVague()) return;
    const pt = aimPoint();
    closeSheet();
    const t = TYPES[type];
    // Même type, à 60 m, depuis moins de 5 min, déjà signalé par ce téléphone : c'est déjà compté. Sinon,
    // une personne qui retouche « Charge » en courant comptait pour plusieurs téléphones (règle de fusion
    // du serveur, config.js)
    const mineNear = [...state.reports.values()].some((r) => r.type === type && state.mine.has(r.id)
        && distance([pt.lat, pt.lng], [r.lat, r.lng]) <= 60 && serverNow() - r.updatedAt < 5 * MIN);
    if (mineNear) {
        toast(`${t.label} : tu l'as déjà signalé ici, c'est compté.`);
        return;
    }
    // Calcul anti-spam puis envoi : quelques secondes sur un vieux téléphone, on montre que ça part
    toast('Envoi…', { ms: 20_000 });
    const body = {
        type,
        lat: pt.lat,
        lng: pt.lng,
        // Empreinte liée au lieu aussi : deux signalements du même téléphone à deux endroits ne se relient pas
        voter: await voterFor(`${type}:${pt.lat}:${pt.lng}:${Math.floor(serverNow() / (5 * MIN))}`),
        observedAt: serverNow(),
    };
    buzz(40);
    const pow = await solvePow(`report|${type}|${pt.lat}|${pt.lng}|${body.voter}`);
    if (state.config.powBits && !pow) {
        toast('Ton téléphone n\'a pas pu valider l\'envoi. Réessaie.', { ms: 6000 });
        return;
    }
    try {
        const res = await api('POST', '/api/reports', body, pow ? { 'X-Pow': pow } : {});
        tagAfterReport(res.id, body.voter);
        if (res.merged) {
            // Déjà sur la carte : on a juste confirmé celui de quelqu'un d'autre
            state.voted.add(res.id);
            toast(`${t.label} déjà signalé·e : ta confirmation compte`);
        } else {
            rememberMine(res.id, res.deleteToken || null);
            toast(t.sent, { undo: () => undoReport(res.id), ms: 8000 });
        }
    } catch (e) {
        // Refus définitif (4xx) : on le dit. Panne ou saturation (pas de réponse, 5xx) : on réessaiera
        if (e.status && e.status < 500) {
            toast(e.message, { ms: 6000 });
            return;
        }
        queuePush(body);
        toast(e.status === 503
            ? `${t.sent}. Zone saturée : nouvel essai automatique dans un moment.`
            : `${t.sent}. Envoi dès que le réseau revient.`, { ms: 6000 });
    }
}

async function undoReport(id) {
    const mine = state.mine.get(id);
    if (!mine?.token) return;
    try {
        await api('DELETE', `/api/reports/${id}`, null, { 'X-Delete-Token': mine.token });
        state.mine.delete(id);
        saveMine();
        toast('Signalement annulé');
    } catch (e) {
        // 409 : d'autres téléphones l'ont confirmé entre-temps, il ne t'appartient plus
        toast(e.status === 409 ? e.message : 'Trop tard pour annuler. Il s\'effacera tout seul.');
    }
}

function queuePush(body) {
    const q = store.get(KEY.queue, []);
    q.push(body);
    store.set(KEY.queue, q.slice(-20));
}

// Nouvel essai de la file : 30 s après un échec, puis 1, 2 et 4 min. Chaque essai refait le calcul
// anti-spam : en zone saturée, le refaire toutes les 30 s pendant 10 min viderait la batterie pour rien.
let flushDelay = 0;
let flushAfter = 0;

async function flushQueue() {
    const q = store.get(KEY.queue, []);
    if (!q.length) return;
    store.set(KEY.queue, []);
    let sent = 0;
    let failed = 0;
    for (const body of q) {
        if (serverNow() - body.observedAt > 10 * MIN) continue;
        const pow = await solvePow(`report|${body.type}|${body.lat}|${body.lng}|${body.voter}`);
        if (state.config.powBits && !pow) { queuePush(body); failed++; continue; }
        try {
            const res = await api('POST', '/api/reports', body, pow ? { 'X-Pow': pow } : {});
            tagAfterReport(res.id, body.voter);
            rememberMine(res.id, null);
            sent++;
        } catch (e) {
            if (!e.status || e.status >= 500) { queuePush(body); failed++; }
        }
    }
    flushDelay = failed ? Math.min((flushDelay || 15_000) * 2, 4 * MIN) : 0;
    flushAfter = Date.now() + flushDelay;
    if (sent) toast(`${sent} signalement${sent > 1 ? 's' : ''} en attente envoyé${sent > 1 ? 's' : ''}`);
}

async function voteReport(id, kind) {
    try {
        const voter = await voterFor(id);
        const body = { voter };
        if (kind === 'confirm') {
            const tag = await cellTag(id);
            if (tag) body.tag = tag;
        }
        const pow = await solvePow(`${kind}|${id}|${voter}`);
        if (state.config.powBits && !pow) {
            toast('Ton téléphone n\'a pas pu valider. Réessaie.', { ms: 6000 });
            return;
        }
        await api('POST', `/api/reports/${id}/${kind}`, body, pow ? { 'X-Pow': pow } : {});
        state.voted.add(id);
        closeSheet();
        toast(kind === 'confirm' ? 'Merci, ta confirmation est comptée' : 'Noté. Si un autre téléphone le dit aussi, il s\'affichera « peut-être fini ».', { ms: 6000 });
    } catch (e) {
        toast(e.status ? e.message : 'Pas de réseau, réessaie dans un instant.');
    }
}

// Confirmer ou dire « c'est fini » : seulement sur place (sans position connue, on laisse faire)
const NEAR_VOTE_M = 400;

function openDetail(id) {
    if (document.body.classList.contains('is-aiming')) return;
    const r = state.reports.get(id);
    if (!r) return;
    const t = TYPES[r.type];
    const sheet = $('#sheetDetail');
    sheet.dataset.id = id;

    const plate = $('#detailPlate');
    plate.className = `detail__plate t-${r.type}`;
    plate.innerHTML = icon(t.icon);
    $('#detailTitle').textContent = t.label;

    let sub = `Vu ${ago(r.updatedAt)}`;
    if (state.pos) {
        const d = fmtDist(distance(state.pos, [r.lat, r.lng]));
        sub += `, à ${d.v} ${d.u} ${OU[sector(bearing(state.pos, [r.lat, r.lng]))]}`;
    }
    $('#detailSub').textContent = sub;

    const st = $('#detailState');
    st.className = `detail__state t-${r.type} ${r.confirmed ? 'is-ok' : 'is-unsure'}`;
    // Honnête : un nombre de téléphones ne prouve rien (n'importe qui peut signaler) ; seule la cellule
    // vient de gens que tu connais
    let stTxt = r.confirmations > 1 ? `Signalé par ${phones(r.confirmations)}.` : 'Un seul signalement pour l\'instant.';
    stTxt += seenByCell(r)
        ? ' Vu par ta cellule : quelqu\'un de ta cellule l\'a confirmé.'
        : ' N\'importe qui peut signaler : seul « vu par ta cellule » vient de gens que tu connais.';
    if (r.ended) stTxt += ' 2 téléphones ou plus disent que c\'est fini (n\'importe qui peut le dire).';
    st.textContent = stTxt;

    const mine = state.mine.get(id);
    const acts = $('#detailActions');
    if (mine) {
        const canUndo = mine.token && Date.now() < mine.tokenUntil;
        acts.innerHTML = '<p class="row__hint">Tu as fait ce signalement.</p>'
            + (canUndo ? '<button class="btn btn--ghost" type="button" data-act="undo">Annuler mon signalement</button>' : '');
    } else if (state.voted.has(id)) {
        acts.innerHTML = '<p class="row__hint">Tu as déjà répondu pour celui-ci.</p>';
    } else if (state.pos && distance(state.pos, [r.lat, r.lng]) > NEAR_VOTE_M) {
        // De loin, « je le vois aussi » se lisait « je le vois sur la carte » : on ne témoigne que sur place
        acts.innerHTML = `<p class="row__hint">Tu es à plus de ${NEAR_VOTE_M} m : approche-toi pour dire si c'est toujours là.</p>`;
    } else {
        acts.innerHTML = `<button class="btn btn--primary" type="button" data-act="confirm">${icon('check')}J'y suis : toujours là</button>`
            + '<button class="btn btn--ghost" type="button" data-act="gone">J\'y suis : c\'est fini</button>';
    }
    acts.onclick = (e) => {
        const act = e.target.closest('[data-act]')?.dataset.act;
        if (act === 'confirm') voteReport(id, 'confirm');
        if (act === 'gone') voteReport(id, 'gone');
        if (act === 'undo') { closeSheet(); undoReport(id); }
    };
    openSheet('sheetDetail');
}

// ------------------------------------------------------------------ demander de l'aide

async function sendHelp(type) {
    if (aimTooVague()) return;
    const pt = aimPoint();
    closeSheet();
    buzz(40);
    toast('Envoi de ta demande…', { ms: 20_000 });
    const prev = state.myHelp;
    try {
        // Preuve de travail légère (une fraction de seconde) : une urgence n'attend pas
        const pow = await solvePow(`help|${type}|${pt.lat}|${pt.lng}`, state.config.powBitsUrgent);
        const res = await api('POST', '/api/help', { type, lat: pt.lat, lng: pt.lng }, pow ? { 'X-Pow': pow } : {});
        // Nouvelle demande : l'ancienne est retirée chez les medics (elle y restait, impossible à fermer)
        if (prev) api('DELETE', `/api/help/${prev.id}`, null, { 'X-Owner-Token': prev.token }).catch(() => { /* elle expirera seule */ });
        state.myHelp = { id: res.id, token: res.ownerToken, type, status: 'waiting', at: Date.now() };
        store.set(KEY.help, state.myHelp);
        renderHelpStatus();
        pollHelp();
        // Touché par erreur (on croyait ouvrir des conseils) : 5 s pour l'annuler avant qu'un medic se déplace
        const mine = state.myHelp;
        toast('Demande envoyée aux medics.', {
            ms: 5000,
            undo: () => {
                if (state.myHelp !== mine) return;
                clearMyHelp();
                api('DELETE', `/api/help/${mine.id}`, null, { 'X-Owner-Token': mine.token }).catch(() => { /* elle expirera seule */ });
                toast('Demande annulée');
            },
        });
    } catch (e) {
        // Pas de file d'attente ici : une demande d'aide en retard tromperait les medics
        // Toujours le 112, quelle que soit la raison de l'échec
        toast(e.status
            ? `Ta demande n'est pas partie (${e.message.replace(/[.\s]+$/, '')}). Réessaie, et si c'est grave, appelle le 112.`
            : 'Pas de réseau : ta demande n\'est pas partie. Si c\'est grave, appelle le 112.', { ms: 10000 });
    }
}

function renderHelpStatus() {
    const el = $('#helpStatus');
    const h = state.myHelp;
    if (!h) {
        el.classList.add('hidden');
        return;
    }
    el.classList.remove('hidden');
    const taken = h.status === 'taken';
    // Sans réponse au bout de 5 min : on dit quoi faire plutôt que de laisser attendre
    const long = !taken && h.at && Date.now() - h.at > 5 * MIN;
    $('#helpStatusTitle').textContent = taken ? 'Un·e medic arrive' : 'Demande envoyée aux medics';
    // En attente : rappeler que ce sont des bénévoles, peut-être absents, et que le 112 reste là
    $('#helpStatusSub').textContent = taken
        ? 'Reste où tu es si tu peux.'
        : (long ? 'Toujours pas de réponse. Si ça s\'aggrave, appelle le 112.' : 'Secouristes bénévoles, s\'il y en a autour. Si c\'est grave : 112.');
}

function clearMyHelp() {
    state.myHelp = null;
    store.set(KEY.help, null);
    renderHelpStatus();
}

let helpTimer = 0;
async function pollHelp() {
    clearTimeout(helpTimer);
    const h = state.myHelp;
    if (!h) return;
    try {
        const res = await api('GET', `/api/help/${h.id}`, null, { 'X-Owner-Token': h.token });
        if (res.status !== h.status) {
            h.status = res.status;
            store.set(KEY.help, h);
            if (res.status === 'taken') buzz([200, 100, 200]);
        }
        renderHelpStatus(); // aussi pour le message des 5 min sans réponse
    } catch (e) {
        if (e.status === 404 || e.status === 403) {
            // Jamais en silence : la personne ne doit pas croire que c'est réglé
            clearMyHelp();
            toast(h.status === 'taken'
                ? 'Ta demande d\'aide est close. Si tu as encore besoin d\'aide, renvoie-la ou appelle le 112.'
                : 'Ta demande d\'aide n\'existe plus (expirée ou perdue) : renvoie-la, ou appelle le 112 si c\'est grave.', { ms: 8000 });
            return;
        }
    }
    // Toutes les 15 s, et seulement écran allumé : chaque requête réveille la radio du téléphone
    if (visible()) helpTimer = setTimeout(pollHelp, 15_000);
}

let helpClosing = null; // fermeture d'une demande d'aide en attente (les 5 s pour annuler)

async function closeMyHelp() {
    const h = state.myHelp;
    if (!h) return;
    clearMyHelp();
    // Touché par erreur : 5 s pour revenir en arrière avant qu'elle soit retirée chez les medics. Si l'appli
    // passe en arrière-plan entre-temps (téléphone verrouillé), elle part tout de suite (voir onVisibility).
    const send = () => {
        clearTimeout(timer);
        helpClosing = null;
        api('DELETE', `/api/help/${h.id}`, null, { 'X-Owner-Token': h.token }).catch(() => { /* elle expirera seule */ });
    };
    const timer = setTimeout(send, 5000);
    helpClosing = send;
    toast('Demande fermée', {
        ms: 5000,
        undo: () => {
            clearTimeout(timer);
            helpClosing = null;
            state.myHelp = h;
            store.set(KEY.help, h);
            renderHelpStatus();
            pollHelp();
        },
    });
}

// ------------------------------------------------------------------ mode medic

function helpHtml(h) {
    return `<div class="mk is-help t-aide ${h.takenAt ? 'is-taken' : ''}">`
        + `<span class="mk__plate">${icon(HELP_TYPES[h.type].icon)}</span>`
        + `<span class="mk__age">${h.takenAt ? 'pris' : agoShort(h.createdAt)}</span></div>`;
}

function applyHelps(list) {
    const ids = new Set(list.map((h) => h.id));
    for (const [id, m] of helpMarkers) {
        if (!ids.has(id)) {
            helpLayer.removeLayer(m);
            helpMarkers.delete(id);
            state.helps.delete(id);
        }
    }
    for (const h of list) {
        if (!HELP_TYPES[h.type]) continue;
        state.helps.set(h.id, h);
        const m = helpMarkers.get(h.id);
        if (m) {
            paint(m, helpHtml(h));
        } else {
            const html = helpHtml(h);
            const nm = L.marker([h.lat, h.lng], { icon: divIcon(html), zIndexOffset: 500 })
                .on('click', () => openHelpDetail(h.id))
                .addTo(helpLayer);
            nm.vigieHtml = html;
            helpMarkers.set(h.id, nm);
        }
    }
    const waiting = list.filter((h) => !h.takenAt).length;
    $('#medicBarTitle').textContent = waiting
        ? `${waiting} demande${waiting > 1 ? 's' : ''} en attente`
        : 'Aucune demande en attente';
}

let medicTimer = 0;
async function medicLoop() {
    clearTimeout(medicTimer);
    if (!state.medicCode) return;
    try {
        applyHelps(await api('GET', `/api/help?s=${wantedSectors()}`, null, { 'X-Medic-Code': state.medicCode }));
    } catch (e) {
        if (e.status === 403) {
            stopMedic();
            toast('Code medic refusé : mode medic coupé.');
            return;
        }
    }
    if (visible()) medicTimer = setTimeout(medicLoop, 15_000);
}

async function startMedic(code) {
    try {
        applyHelps(await api('GET', `/api/help?s=${wantedSectors()}`, null, { 'X-Medic-Code': code }));
    } catch (e) {
        $('#medicHint').textContent = e.status === 403 ? 'Code refusé. Vérifie-le auprès de ton collectif.' : 'Pas de réseau, réessaie.';
        return;
    }
    state.medicCode = code;
    store.set(KEY.medic, code);
    renderMedicUi();
    medicLoop();
    closeSheet();
    toast('Mode medic activé');
}

function stopMedic() {
    clearTimeout(medicTimer);
    state.medicCode = null;
    store.set(KEY.medic, null);
    applyHelps([]);
    renderMedicUi();
}

function renderMedicUi() {
    const on = Boolean(state.medicCode);
    $('#medicBar').classList.toggle('hidden', !on);
    $('#medicForm').classList.toggle('hidden', on);
    $('#medicOff').classList.toggle('hidden', !on);
    $('#medicHint').textContent = on
        ? 'Les demandes d\'aide s\'affichent en carrés verts. Une demande peut être un piège : n\'y va jamais seul·e, regarde avant d\'approcher, et méfie-toi d\'une demande isolée loin du cortège.'
        : 'Pour les street medics : affiche les demandes d\'aide.'
            + (state.config.demoMedicCode ? ` Démo : le code est ${state.config.demoMedicCode}.` : '');
}

function openHelpDetail(id) {
    if (document.body.classList.contains('is-aiming')) return;
    const h = state.helps.get(id);
    if (!h) return;
    const t = HELP_TYPES[h.type];
    $('#sheetDetail').dataset.id = id;
    const plate = $('#detailPlate');
    plate.className = 'detail__plate is-square t-aide';
    plate.innerHTML = icon(t.icon);
    $('#detailTitle').textContent = t.label;
    let sub = `Demandé ${ago(h.createdAt)}`;
    if (state.pos) {
        const d = fmtDist(distance(state.pos, [h.lat, h.lng]));
        sub += `, à ${d.v} ${d.u} ${OU[sector(bearing(state.pos, [h.lat, h.lng]))]}`;
    }
    $('#detailSub').textContent = sub;
    const st = $('#detailState');
    st.className = `detail__state t-aide ${h.takenAt ? 'is-ok' : 'is-unsure'}`;
    st.textContent = h.takenAt ? 'Déjà pris en charge par un·e medic.' : 'Personne ne s\'en occupe encore.';
    const acts = $('#detailActions');
    acts.innerHTML = h.takenAt ? '' : `<button class="btn btn--aide" type="button" data-act="take">${icon('check')}Je m'en occupe</button>`;
    acts.onclick = async (e) => {
        if (!e.target.closest('[data-act="take"]')) return;
        try {
            await api('POST', `/api/help/${id}/take`, null, { 'X-Medic-Code': state.medicCode });
            closeSheet();
            toast('C\'est noté : la personne sait qu\'un·e medic arrive');
            medicLoop();
        } catch (err) {
            toast(err.status ? err.message : 'Pas de réseau, réessaie.');
        }
    };
    openSheet('sheetDetail');
}

// ------------------------------------------------------------------ cellule de confiance (interface)

let scanStream = null;
let scanTimer = 0;
let scanGen = 0;
let detector = null;

function renderCellRow() {
    $('#cellBtnLabel').textContent = state.cell ? 'Ma cellule' : 'Rejoindre une cellule';
    renderAlertChoice();
}

const CELL_SUB = {
    cellHome: '',
    cellJoin: 'Scanne le QR d\'un membre, ou tape son code.',
    cellShare: 'Fais entrer quelqu\'un dans ta cellule.',
};

function showCellView(name) {
    ['cellHome', 'cellJoin', 'cellShare'].forEach((v) => $(`#${v}`).classList.toggle('hidden', v !== name));
    $('#cellBack').classList.toggle('hidden', name === 'cellHome');
    $('#cellSub').textContent = CELL_SUB[name];
    if (name !== 'cellJoin') stopScan();
    if (name === 'cellHome') renderCellHome();
    else if (name === 'cellJoin') startCellJoin();
    else if (name === 'cellShare') renderShare();
}

function openCell() {
    showCellView('cellHome');
    openSheet('sheetCell');
}

function renderCellHome() {
    const has = Boolean(state.cell);
    $('#cellNone').classList.toggle('hidden', has);
    $('#cellMember').classList.toggle('hidden', !has);
    if (!has) return;
    $('#cellState').textContent = 'Tu fais partie d\'une cellule. Quand un de ses membres confirme un danger, tu le vois marqué « vu par ta cellule ».';
}

// --- scan caméra générique (BarcodeDetector natif) + repli code tapé, partagé cellule / binôme
let scanCfg = null;
let scanCanvas = null;
let scanPaused = null; // scan arrêté par la mise en veille, à relancer au retour
async function startScan(cfg) {
    // cfg : { scan, video, hint, view, onText }
    stopScan();
    const gen = scanGen; // change à chaque arrêt : un démarrage dépassé le voit après chaque attente
    scanCfg = cfg;
    const scan = $(cfg.scan);
    const hint = $(cfg.hint);
    if (!window.isSecureContext) {
        scan.classList.add('hidden');
        hint.textContent = 'Le scan par caméra a besoin d\'une connexion sécurisée (HTTPS, ou localhost). En http, tape le code ci-dessous.';
        return;
    }
    if (!('BarcodeDetector' in window) || !navigator.mediaDevices?.getUserMedia) {
        scan.classList.add('hidden');
        hint.textContent = 'Ton téléphone ne sait pas scanner ici (souvent l\'iPhone). Tape le code ci-dessous.';
        return;
    }
    try {
        const formats = await BarcodeDetector.getSupportedFormats();
        if (!formats.includes('qr_code')) {
            scan.classList.add('hidden');
            hint.textContent = 'Ton téléphone ne décode pas les QR ici. Utilise le code court ou le code tapé.';
            return;
        }
        detector = detector || new BarcodeDetector({ formats: ['qr_code'] });
        const media = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        // Feuille fermée pendant la demande d'autorisation : la caméra arrivée trop tard est coupée aussitôt
        // (sinon elle restait allumée sans rien à l'écran)
        if (gen !== scanGen) { media.getTracks().forEach((t) => t.stop()); return; }
        scanStream = media;
        const video = $(cfg.video);
        video.srcObject = scanStream;
        await video.play();
        if (gen !== scanGen) return;
        scan.classList.remove('hidden');
        hint.textContent = 'Vise le QR de la personne.';
        scanTimer = setTimeout(scanTick, 400);
    } catch {
        stopScan();
        scan.classList.add('hidden');
        hint.textContent = 'Caméra indisponible ou refusée. Tape le code ci-dessous.';
    }
}

async function scanTick() {
    const cfg = scanCfg;
    // Jamais de boucle active hors de la vue : feuille fermée, autre vue ou écran éteint l'arrêtent
    if (!scanStream || !cfg || $(cfg.view).classList.contains('hidden') || !visible()) {
        if (scanStream && visible()) stopScan(); // vue fermée : la caméra s'éteint au lieu de rester allumée
        return;
    }
    try {
        const video = $(cfg.video);
        if (video.videoWidth > 0) {
            // On détecte sur une capture canvas de la frame : plus fiable que sur le <video> sur Android
            scanCanvas = scanCanvas || document.createElement('canvas');
            scanCanvas.width = video.videoWidth;
            scanCanvas.height = video.videoHeight;
            scanCanvas.getContext('2d').drawImage(video, 0, 0);
            const codes = await detector.detect(scanCanvas);
            if (codes.length) { const t = codes[0].rawValue; stopScan(); cfg.onText(t); return; }
        }
    } catch { /* image pas prête */ }
    scanTimer = setTimeout(scanTick, 350); // ~3 lectures/s : réactif et sobre pour la batterie
}

function stopScan() {
    scanGen++;
    clearTimeout(scanTimer);
    scanTimer = 0;
    if (scanStream) {
        scanStream.getTracks().forEach((t) => t.stop());
        scanStream = null;
    }
    if (scanCfg) { const v = $(scanCfg.video); if (v) v.srcObject = null; }
    scanCfg = null;
}

function startCellJoin() {
    $('#cellJoinMsg').textContent = '';
    $('#cellCodeInput').value = '';
    startScan({
        scan: '#cellScan', video: '#cellVideo', hint: '#cellScanHint', view: '#cellJoin',
        onText: (t) => {
            const cell = codeToCell(t);
            if (cell) onJoined(cell);
            else { startCellJoin(); $('#cellJoinMsg').textContent = isOtherCode(t, 'cell') ? WRONG_CODE.cell : 'Code illisible, réessaie ou tape-le.'; }
        },
    });
}

async function joinByCode() {
    const raw = $('#cellCodeInput').value.trim();
    const cleaned = raw.toUpperCase().replace(/[^0-9A-Z]/g, '');
    // Court : c'est un code court, résolu par le serveur
    if (cleaned.length > 0 && cleaned.length <= 12) {
        try {
            const pow = await solvePow(`claim|${normCode(raw)}`);
            const res = await api('POST', '/api/cell/claim', { pin: raw }, pow ? { 'X-Pow': pow } : {});
            if (!/^[a-f0-9]{8}$/.test(String(res?.id)) || !/^[a-f0-9]{20}$/.test(String(res?.key))) throw new Error('réponse inattendue');
            onJoined({ id: res.id, key: res.key });
        } catch (e) {
            $('#cellJoinMsg').textContent = e.status === 404 ? 'Code court inconnu ou expiré.' : 'Pas de réseau pour le code court.';
        }
        return;
    }
    const cell = codeToCell(raw);
    if (!cell) {
        $('#cellJoinMsg').textContent = isOtherCode(raw, 'cell') ? WRONG_CODE.cell : 'Code non reconnu. Vérifie-le auprès de la personne.';
        return;
    }
    onJoined(cell);
}

// Code court : la cellule est confiée au serveur 12 h, pour qui ne peut pas scanner
async function showPin() {
    if (!state.cell) return;
    const out = $('#cellPinOut');
    out.classList.remove('hidden');
    out.textContent = 'Génération…';
    try {
        const pow = await solvePow(`pair|${state.cell.id}`);
        const res = await api('POST', '/api/cell/pair', state.cell, pow ? { 'X-Pow': pow } : {});
        const left = res.ttlMs >= 3_600_000 ? `environ ${Math.round(res.ttlMs / 3_600_000)} h` : `${Math.max(1, Math.round(res.ttlMs / MIN))} min`;
        out.textContent = `Code court : ${res.pin.replace(/(.{4})(?=.)/, '$1-')} (réutilisable, valable encore ${left}). `
            + 'Pendant ce temps, le serveur garde la clé de ta cellule, et toute personne qui a ce code peut entrer : ne le dis qu\'à des gens que tu connais.';
    } catch (e) {
        out.textContent = e.status ? (e.status === 503 ? e.message : 'Code court refusé.') : 'Pas de réseau.';
    }
}

// Même normalisation que le serveur (confusions de saisie, tirets, minuscules) : la preuve de travail
// porte sur le code tel que le serveur le lira
const normCode = (s) => String(s || '').toUpperCase()
    .replace(/I/g, '1').replace(/L/g, '1').replace(/O/g, '0').replace(/U/g, 'V')
    .replace(/[^0-9A-Z]/g, '');

function onJoined(cell) {
    stopScan();
    joinCell(cell);
    showCellView('cellHome');
    toast('Tu as rejoint une cellule');
}

// Créer sa cellule : un geste, sans code ni serveur, puis on la montre pour la faire scanner
function createCell() {
    joinCell(newCell());
    showCellView('cellShare');
    toast('Ta cellule est créée : fais-la scanner par des gens de confiance');
}

// --- partager : QR + code
function renderShare() {
    if (!state.cell) {
        showCellView('cellHome');
        return;
    }
    $('#cellCodeText').textContent = cellToCode(state.cell);
    const out = $('#cellPinOut');
    out.classList.add('hidden');
    out.textContent = '';
    drawQr($('#cellQr'), cellToRaw(state.cell));
}

// QR toujours noir sur blanc (contraste pour les scanners), quel que soit le thème, entouré de la zone
// de silence de 4 modules blancs exigée par la norme : sans elle, sur fond sombre, la détection échoue.
function drawQr(canvas, text) {
    const m = qrMatrix(text);
    const n = m.length;
    const quiet = 4;
    const total = n + quiet * 2;
    const scale = Math.max(2, Math.floor(330 / total));
    const px = total * scale;
    canvas.width = px;
    canvas.height = px;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, px, px);
    ctx.fillStyle = '#0E1012';
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (m[y][x]) ctx.fillRect((x + quiet) * scale, (y + quiet) * scale, scale, scale);
}

async function copyCode() {
    const code = cellToCode(state.cell);
    try {
        if (!navigator.clipboard?.writeText) throw new Error('indisponible');
        await navigator.clipboard.writeText(code);
        toast('Code copié');
    } catch {
        // Repli : on sélectionne le texte, à copier à la main
        const el = $('#cellCodeText');
        const range = document.createRange();
        range.selectNodeContents(el);
        const sel = getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        toast('Sélectionne et copie le code affiché');
    }
}

// --- entrer dans une cellule / quitter
function joinCell(cell) {
    state.cell = cell;
    store.set(KEY.cell, cell);
    renderCellRow();
    recheckCellTags();
}

function leaveCell() {
    state.cell = null;
    store.set(KEY.cell, null);
    renderCellRow();
    recheckCellTags();
    showCellView('cellHome');
    toast('Tu as quitté la cellule');
}

// ------------------------------------------------------------------ binôme (groupe chiffré de bout en bout)

let buddyTimer = 0;
const buddyAlarmed = new Set();
const buddyMarkers = new Map(); // membre -> marqueur Leaflet d'un binôme interpellé (le prénom peut être en double)
// Membre -> dernier message lu, en mémoire de la page seulement : un redémarrage du serveur (ou les 90 min
// du relais) n'efface plus en silence une alarme « interpellé·e » ou un silence
const buddySeen = new Map();
const buddyArrestAt = new Map(); // membre -> heure de sa dernière alarme : un « je vais bien » ensuite ne l'efface pas en silence
const rnd = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((x) => x.toString(16).padStart(2, '0')).join('');
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Le serveur ne relaie que des blobs chiffrés avec la clé de groupe (échangée en personne). Un blob
// qui ne déchiffre pas (spam) est jeté. AES-GCM assure confidentialité ET intégrité.
// Clé AES-128 dérivée du secret de groupe (10 octets). Le secret reste court à partager ; la clé
// n'a que ses 80 bits d'entropie, ce qui reste largement hors de portée d'une recherche exhaustive. Le serveur ne voit jamais ni le secret ni la clé (tout se dérive sur le téléphone).
async function buddyAesKey(seedHex) {
    const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(hexBytes(seedHex)));
    return crypto.subtle.importKey('raw', digest.slice(0, 16), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

// Adresse du relais = SHA-256("vigie:relais:" + secret), 16 octets : seul qui connaît le secret la
// connaît, impossible de la deviner pour lire ou remplir le relais d'un autre groupe
const relays = new Map();
async function buddyRelay(seedHex) {
    if (!relays.has(seedHex)) {
        const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`vigie:relais:${seedHex}`));
        relays.set(seedHex, toHex([...new Uint8Array(d)].slice(0, 16)));
    }
    return relays.get(seedHex);
}

// Chaque message est lié à son relais et à son membre (données associées AES-GCM) : impossible de le
// recopier sous un autre membre ou dans un autre groupe
const buddyAad = (relay, member) => new TextEncoder().encode(`${relay}:${member}`);

async function buddyEncrypt(payload, b = state.buddy) {
    if (!b || !crypto.subtle) return null;
    try {
        const key = await buddyAesKey(b.seed);
        const relay = await buddyRelay(b.seed);
        const iv = crypto.getRandomValues(new Uint8Array(12));
        // Complété par des espaces jusqu'à 256 octets : la longueur chiffrée ne trahit ni « interpellé·e »
        // ni la longueur du prénom (JSON.parse ignore les espaces de fin)
        const raw = new TextEncoder().encode(JSON.stringify(payload));
        const plain = new Uint8Array(Math.max(256, raw.length)).fill(32);
        plain.set(raw);
        const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: buddyAad(relay, b.member) }, key, plain));
        const out = new Uint8Array(iv.length + ct.length);
        out.set(iv);
        out.set(ct, iv.length);
        return btoa(String.fromCharCode(...out));
    } catch {
        return null;
    }
}
async function buddyDecrypt(blob, seedHex, member) {
    try {
        const raw = Uint8Array.from(atob(blob), (c) => c.charCodeAt(0));
        const key = await buddyAesKey(seedHex);
        const relay = await buddyRelay(seedHex);
        const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.slice(0, 12), additionalData: buddyAad(relay, member) }, key, raw.slice(12));
        return JSON.parse(new TextDecoder().decode(pt));
    } catch {
        return null;
    }
}

// Un message déchiffré n'est accepté que s'il a exactement la forme attendue : un téléphone de
// membre saisi ne doit pas pouvoir injecter autre chose (texte piégé, position bidon qui bloquerait l'appli)
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
function validBuddy(p) {
    if (!p || typeof p !== 'object' || typeof p.name !== 'string' || !finite(p.ts)) return null;
    if (p.status !== 'ok' && p.status !== 'arrested' && p.status !== 'parti') return null;
    if (p.until !== undefined && !finite(p.until)) return null;
    // Horodatages plausibles : un message daté du futur bloquerait les suivants (anti-rejeu)
    if (p.ts > serverNow() + 5 * MIN || (p.until !== undefined && p.until > p.ts + 3 * 60 * MIN)) return null;
    let pos;
    if (p.pos !== undefined) {
        if (!Array.isArray(p.pos) || p.pos.length !== 2 || !finite(p.pos[0]) || !finite(p.pos[1])) return null;
        if (Math.abs(p.pos[0]) > 90 || Math.abs(p.pos[1]) > 180) return null;
        pos = [p.pos[0], p.pos[1]];
    }
    return { name: p.name.slice(0, 24), status: p.status, until: p.until, pos, ts: p.ts };
}
const buddyLastTs = new Map(); // membre -> dernier horodatage vu : un vieux message rejoué est ignoré

// Code partageable : base32 de (groupId 4 octets + secret 10 octets) + type « B » = 24 caractères
const buddyToRaw = (b) => `${b32encode([...hexBytes(b.groupId), ...hexBytes(b.seed)])}${CODE_TYPE.buddy}`;
const buddyToCode = (b) => buddyToRaw(b).replace(/(.{4})(?=.)/g, '$1-');
function codeToBuddy(code) {
    const bytes = typedBytes(code, 'buddy');
    if (!bytes || bytes.length < 14) return null;
    const groupId = toHex(bytes.slice(0, 4));
    const seed = toHex(bytes.slice(4, 14));
    return /^[a-f0-9]{8}$/.test(groupId) && /^[a-f0-9]{20}$/.test(seed) ? { groupId, seed } : null;
}

const BUDDY_SUB = { buddyHome: '', buddyJoin: 'Scanne le QR d\'un binôme, ou tape son code.', buddyShare: 'Ajoute quelqu\'un à ton binôme.' };

function showBuddyView(name) {
    ['buddyHome', 'buddyJoin', 'buddyShare'].forEach((v) => $(`#${v}`).classList.toggle('hidden', v !== name));
    $('#buddyBack').classList.toggle('hidden', name === 'buddyHome');
    $('#buddySub').textContent = BUDDY_SUB[name];
    if (name !== 'buddyJoin') stopScan();
    if (name === 'buddyHome') renderBuddyHome();
    else if (name === 'buddyJoin') startBuddyJoin();
    else if (name === 'buddyShare') renderBuddyShare();
}

function openBuddy() {
    showBuddyView('buddyHome');
    openSheet('sheetBuddy');
}

function renderBuddyHome() {
    const has = Boolean(state.buddy);
    $('#buddyNone').classList.toggle('hidden', has);
    $('#buddyMember').classList.toggle('hidden', !has);
    if (!has) return;
    $('#buddyNameInput').value = state.buddy.name || '';
    buddyPoll();
}

function createBuddy() {
    state.buddy = { groupId: rnd(4), seed: rnd(10), member: rnd(8), token: rnd(16), name: state.buddy?.name || '' };
    store.set(KEY.buddy, state.buddy);
    showBuddyView('buddyShare');
    toast('Binôme créé : partage-le à tes proches');
}

function startBuddyJoin() {
    $('#buddyJoinMsg').textContent = '';
    $('#buddyCodeInput').value = '';
    startScan({
        scan: '#buddyScan', video: '#buddyVideo', hint: '#buddyScanHint', view: '#buddyJoin',
        onText: (t) => {
            const g = codeToBuddy(t);
            if (g) onBuddyJoined(g);
            else { startBuddyJoin(); $('#buddyJoinMsg').textContent = isOtherCode(t, 'buddy') ? WRONG_CODE.buddy : 'Code illisible, réessaie ou tape-le.'; }
        },
    });
}
function joinBuddyByCode() {
    const code = $('#buddyCodeInput').value;
    const g = codeToBuddy(code);
    if (!g) {
        $('#buddyJoinMsg').textContent = isOtherCode(code, 'buddy') ? WRONG_CODE.buddy : 'Code non reconnu. Vérifie-le auprès de la personne.';
        return;
    }
    onBuddyJoined(g);
}
function onBuddyJoined(g) {
    stopScan();
    // Même binôme scanné à nouveau : on garde le même membre, sinon l'ancien resterait chez les autres
    // comme un fantôme qui finit en « ne répond plus »
    const same = state.buddy && state.buddy.seed === g.seed;
    state.buddy = { groupId: g.groupId, seed: g.seed, member: same ? state.buddy.member : rnd(8), token: same ? state.buddy.token : rnd(16), name: state.buddy?.name || '' };
    store.set(KEY.buddy, state.buddy);
    buddyAlarmed.clear();
    buddyLastTs.clear();
    buddySeen.clear();
    buddyArrestAt.clear();
    showBuddyView('buddyHome');
    toast('Binôme rejoint : choisis un prénom');
}

function renderBuddyShare() {
    if (!state.buddy) {
        showBuddyView('buddyHome');
        return;
    }
    $('#buddyCodeText').textContent = buddyToCode(state.buddy);
    drawQr($('#buddyQr'), buddyToRaw(state.buddy));
}

function saveBuddyName() {
    if (!state.buddy) return;
    state.buddy.name = $('#buddyNameInput').value.trim().slice(0, 24);
    store.set(KEY.buddy, state.buddy);
}

async function buddyPush(payload, b = state.buddy) {
    const blob = await buddyEncrypt(payload, b);
    if (!blob) return 'chiffrement impossible sur ce navigateur';
    try {
        const relay = await buddyRelay(b.seed);
        // Preuve de travail légère : une alarme ne doit pas attendre
        const pow = await solvePow(`buddy|${relay}|${b.member}`, state.config.powBitsUrgent);
        // Jeton d'écriture, propre à ce téléphone : personne d'autre ne peut remplacer son message
        if (!b.token) { b.token = rnd(16); store.set(KEY.buddy, b); }
        await api('POST', `/api/buddy/${relay}`, { member: b.member, blob, token: b.token }, pow ? { 'X-Pow': pow } : {});
        return null;
    } catch (e) {
        // La vraie raison : un refus du serveur (groupe plein, autre téléphone) ne partira jamais, même en
        // réessayant ; seule l'absence de réponse est un problème de réseau
        return e.status ? e.message.replace(/[.\s]+$/, '') : 'pas de réseau';
    }
}

async function buddyAlive() {
    if (!state.buddy) return;
    if (!window.isSecureContext) { toast('Le binôme a besoin d\'une connexion sécurisée (HTTPS, ou localhost). En http, rien ne part.', { ms: 7000 }); return; }
    saveBuddyName();
    if (!state.buddy.name) {
        toast('Choisis d\'abord un prénom pour ton binôme.', { ms: 5000 });
        $('#buddyNameInput').focus?.();
        return;
    }
    const win = state.config.buddyWindowMin;
    // Heure du serveur : un téléphone en avance ou en retard ne fait plus jeter ses messages ni sonner de fausse alarme
    const t = serverNow();
    const err = await buddyPush({ name: state.buddy.name, status: 'ok', until: t + win * MIN, ts: t });
    toast(err ? `Signe de vie non parti (${err}).` : `Signe de vie envoyé (ok pour ${win} min)`, { ms: 5000 });
    buddyPoll();
}

async function buddyArrest() {
    if (!state.buddy) return;
    if (!window.isSecureContext) { toast('Le binôme a besoin d\'une connexion sécurisée (HTTPS, ou localhost). En http, l\'alarme ne part pas.', { ms: 8000 }); return; }
    saveBuddyName();
    const payload = { name: state.buddy.name || '?', status: 'arrested', ts: serverNow() };
    if (state.pos) payload.pos = [snap(state.pos[0]), snap(state.pos[1])]; // dernière position, arrondie ~50 m
    const err = await buddyPush(payload);
    closeSheet();
    toast(err ? `Alarme non partie (${err}). Réessaie.` : 'Ton binôme est prévenu : interpellation.', { ms: 9000 });
}

function leaveBuddy() {
    // Prévenir les proches qu'on part : sinon, 30 min plus tard, ils recevaient « X ne répond plus »
    const b = state.buddy;
    if (b?.name) buddyPush({ name: b.name, status: 'parti', ts: serverNow() }, b);
    state.buddy = null;
    store.set(KEY.buddy, null);
    buddyAlarmed.clear();
    buddyLastTs.clear();
    buddySeen.clear();
    buddyArrestAt.clear();
    clearTimeout(buddyTimer);
    renderBuddyMarkers([]);
    renderBuddyAlert([]);
    showBuddyView('buddyHome');
    toast('Tu as quitté le binôme');
}

async function copyBuddyCode() {
    const code = buddyToCode(state.buddy);
    try {
        if (!navigator.clipboard?.writeText) throw new Error('indisponible');
        await navigator.clipboard.writeText(code);
        toast('Code copié');
    } catch {
        const el = $('#buddyCodeText');
        const range = document.createRange();
        range.selectNodeContents(el);
        const sel = getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        toast('Sélectionne et copie le code affiché');
    }
}

// Interroge le relais (écran allumé seulement), déchiffre les blobs des autres, met à jour la liste
// et la bannière d'alarme, et vibre sur toute nouvelle interpellation ou silence.
async function buddyPoll() {
    clearTimeout(buddyTimer);
    const b = state.buddy;
    if (!b) {
        renderBuddyAlert([]);
        return;
    }
    try {
        let others = [];
        try {
            const relay = await buddyRelay(b.seed);
            const list = await api('GET', `/api/buddy/${relay}`, null, {}, 8000);
            for (const e of Array.isArray(list) ? list : []) {
                if (e.member === b.member || typeof e.blob !== 'string') continue;
                const p = validBuddy(await buddyDecrypt(e.blob, b.seed, e.member));
                if (!p || p.ts < (buddyLastTs.get(e.member) || 0)) continue; // illisible, mal formé ou rejoué
                buddyLastTs.set(e.member, p.ts);
                if (p.status === 'parti') { buddySeen.delete(e.member); continue; } // a quitté le binôme
                if (p.status === 'arrested') buddyArrestAt.set(e.member, p.ts);
                buddySeen.set(e.member, { ...p, member: e.member });
            }
            // Ce que le relais ne renvoie plus (redémarrage du serveur, 90 min sans nouvelles) reste affiché
            // tel qu'on l'a vu en dernier, pendant 6 h au plus
            for (const [m, p] of buddySeen) {
                if (serverNow() - p.ts > 6 * 60 * MIN) buddySeen.delete(m);
                else others.push(p);
            }
        } catch {
            // réseau : on garde l'affichage courant, mais on continue à réessayer
            others = null;
        }
        // « Quitter le binôme » pendant la requête : on n'affiche rien de l'ancien groupe
        if (state.buddy !== b) return;
        if (others) {
            renderBuddyList(others);
            renderBuddyAlert(others);
            renderBuddyMarkers(others);
            const now = serverNow();
            for (const o of others) {
                const overdue = o.status !== 'arrested' && o.until && now > o.until;
                // Une vieille alarme resservie par le relais (appli rouverte) s'affiche avec son heure, mais
                // ne fait plus vibrer comme si elle venait d'arriver
                if ((o.status === 'arrested' && now - o.ts < 30 * MIN) || overdue) {
                    const k = `${o.member}:${o.status === 'arrested' ? 'arr' : 'late'}:${o.ts}`;
                    if (!buddyAlarmed.has(k)) {
                        buddyAlarmed.add(k);
                        buzz([400, 150, 400, 150, 400]);
                    }
                }
            }
        }
    } finally {
        // Quoi qu'il arrive à l'affichage, la surveillance continue
        if (visible() && state.buddy && state.buddy === b) buddyTimer = setTimeout(buddyPoll, 15_000);
    }
}

function buddyStatus(o, now) {
    // Toujours avec son heure : une alarme ancienne ne doit jamais passer pour une alarme d'à l'instant
    if (o.status === 'arrested') return { cls: 'is-arrest', ic: 'warn', txt: `Interpellé·e ${ago(o.ts)}.${o.pos ? ' Position partagée.' : ''}` };
    if (o.until && now > o.until) return { cls: 'is-late', ic: 'timer', txt: `Silence depuis ${agoShort(o.until)}` };
    const left = o.until ? Math.max(0, Math.round((o.until - now) / MIN)) : null;
    // Un « je vais bien » après une alarme ne l'efface pas en silence (téléphone saisi déverrouillé ?)
    const arr = buddyArrestAt.get(o.member);
    const before = arr && arr < o.ts ? `Interpellé·e ${ago(arr)}, puis : vu` : 'Vu';
    return { cls: 'is-ok', ic: 'check', txt: `${before} ${ago(o.ts)}${left !== null ? `, ok encore ${left} min` : ''}` };
}

function renderBuddyList(others) {
    const ul = $('#buddyList');
    if (!others.length) {
        ul.innerHTML = window.isSecureContext
            ? '<li class="buddy--empty">Personne n\'a encore donné signe. Partage le binôme pour ajouter tes proches.</li>'
            : '<li class="buddy--empty">Le binôme a besoin d\'une connexion sécurisée (HTTPS, ou localhost). En http sur le réseau local, il ne fonctionne pas.</li>';
        return;
    }
    const now = serverNow();
    ul.innerHTML = others.map((o) => {
        const s = buddyStatus(o, now);
        // o.pos vient de validBuddy : deux nombres finis, rien d'autre ne peut entrer dans le HTML
        const loc = (o.status === 'arrested' && o.pos)
            ? `<button class="buddy__loc" type="button" data-lat="${Number(o.pos[0])}" data-lng="${Number(o.pos[1])}">Sur la carte</button>` : '';
        return `<li class="buddy ${s.cls}"><span class="buddy__ic">${icon(s.ic)}</span>`
            + `<span class="buddy__txt"><strong>${esc(o.name)}</strong><span>${esc(s.txt)}</span></span>${loc}</li>`;
    }).join('');
}

function renderBuddyAlert(others) {
    const el = $('#buddyAlert');
    const now = serverNow();
    const arrested = others.filter((o) => o.status === 'arrested');
    const late = others.filter((o) => o.status !== 'arrested' && o.until && now > o.until);
    const urgent = arrested[0] || late[0];
    if (!urgent) {
        el.classList.add('hidden');
        return;
    }
    el.classList.remove('hidden');
    const isArr = Boolean(arrested[0]);
    el.classList.toggle('is-arrest', isArr);
    $('#buddyAlertTitle').textContent = isArr ? `${urgent.name} interpellé·e ${ago(urgent.ts)}` : `${urgent.name} ne répond plus`;
    const extra = arrested.length + late.length - 1;
    $('#buddyAlertSub').textContent = extra > 0
        ? `Et ${extra} autre${extra > 1 ? 's' : ''} dans ton binôme`
        : (isArr && urgent.pos ? 'Position partagée : ouvre pour la voir' : 'Ouvre le binôme');
}

// Pose un marqueur sur la carte pour chaque binôme interpellé qui a partagé sa position
function renderBuddyMarkers(others) {
    if (!helpLayer) return;
    const active = new Set();
    for (const o of others) {
        if (o.status !== 'arrested' || !Array.isArray(o.pos)) continue;
        active.add(o.member);
        const html = `<div class="mk is-buddy"><span class="mk__plate">${icon('users')}</span><span class="mk__age">${esc(o.name)}</span></div>`;
        const m = buddyMarkers.get(o.member);
        if (m) { m.setLatLng(o.pos); paint(m, html); } else {
            const nm = L.marker(o.pos, { icon: divIcon(html), zIndexOffset: 1500 })
                .on('click', (e) => map.setView(e.target.getLatLng(), Math.max(map.getZoom(), 16)))
                .addTo(helpLayer);
            nm.vigieHtml = html;
            buddyMarkers.set(o.member, nm);
        }
    }
    for (const [member, m] of buddyMarkers) if (!active.has(member)) { helpLayer.removeLayer(m); buddyMarkers.delete(member); }
}

// ------------------------------------------------------------------ vent

// Le vent change lentement : une mise à jour toutes les 10 min, écran allumé seulement
let windAt = 0;
async function loadWind() {
    windAt = Date.now();
    try {
        const c = state.pos || (map ? [map.getCenter().lat, map.getCenter().lng] : state.config.center);
        const w = await api('GET', `/api/wind?s=${sectorKey(c[0], c[1])}`);
        state.wind = w && !w.unavailable ? w : null;
    } catch {
        // On garde la dernière valeur
    }
    renderWind();
}

function renderWind() {
    const w = state.wind;
    $('#windBtn').classList.toggle('hidden', !w);
    $('#gasWind').classList.toggle('hidden', !w);
    if (!w) return;
    // Une seule flèche, sur l'écran « Gazé·e » : où marcher pour sortir du nuage, face au vent (étape 1),
    // donc d'où vient le vent. Le bandeau du haut n'en a plus : sa flèche (où va le gaz) pointait à l'opposé.
    rotateArrow($('#gasWindArrow'), w.fromDeg);
    $('#windText').textContent = `${w.speedKmh} km/h`;
    $('#gasWindText').textContent = `${cap(VERS[sector(w.fromDeg)])}, face au vent (${w.speedKmh} km/h)`;
    $('#windBtn').setAttribute('aria-label', `Vent ${w.speedKmh} km/h. Ouvrir les gestes en cas de gaz.`);
}

// ------------------------------------------------------------------ connexion temps réel

function setLive(live) {
    state.live = live;
    if (live) state.lastSync = serverNow();
    renderNet();
}

function renderNet() {
    const el = $('#net');
    if (state.live) {
        el.dataset.state = 'live';
        $('#netText').textContent = 'En direct';
        return;
    }
    el.dataset.state = state.lastSync ? 'off' : 'wait';
    $('#netText').textContent = state.lastSync ? `Hors ligne · ${agoShort(state.lastSync)}` : 'Connexion…';
}

// Flux temps réel. Réseau perdu : on réessaie de plus en plus lentement (3 s, 6 s, 12 s… 1 min)
// au lieu de marteler toutes les 3 s, ce qui viderait la batterie à chercher une antenne saturée.
let stream = null;
let retryMs = 3000;
let retryTimer = 0;

// Secteurs suivis : autour de ma position (3 x 3, pour les alertes de proximité), plus ce que montre la
// carte ; vue trop large (toute la France), seulement autour du centre de la carte.
const sectorKey = (lat, lng) => tileXY(lat, lng, state.config.sectorZoom || 9).join('.');
function wantedSectors() {
    const z = state.config.sectorZoom || 9;
    const set = new Set();
    const around = (lat, lng) => {
        const [x, y] = tileXY(lat, lng, z);
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) set.add(`${x + dx}.${y + dy}`);
    };
    if (state.pos) around(...state.pos);
    if (map) {
        const b = map.getBounds();
        const [x0, y0] = tileXY(b.getNorth(), b.getWest(), z);
        const [x1, y1] = tileXY(b.getSouth(), b.getEast(), z);
        if ((x1 - x0 + 1) * (y1 - y0 + 1) <= 9) {
            for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) set.add(`${x}.${y}`);
        } else {
            const c = map.getCenter();
            around(c.lat, c.lng);
        }
    }
    return [...set].sort().slice(0, state.config.maxSectors || 18).join(',');
}

// La carte a bougé (ou moi) : on change d'abonnement seulement si les secteurs ont changé
let streamSectors = '';
let resubTimer = 0;
function resubscribe() {
    clearTimeout(resubTimer);
    resubTimer = setTimeout(() => {
        if (!stream || wantedSectors() === streamSectors) return;
        disconnect();
        connect();
        loadWind();
        if (state.medicCode) medicLoop();
    }, 600);
}

let streamAt = 0;        // dernier message reçu sur le flux (évènement ou battement)
let connecting = false;

async function connect() {
    if (stream || connecting || !visible()) return;
    connecting = true;
    clearTimeout(retryTimer);
    try {
        const sectors = wantedSectors();
        // Preuve normale pour ouvrir le flux (EventSource n'a pas d'en-tête : elle passe dans l'adresse)
        const pow = await solvePow(`stream|${sectors}`);
        if (stream || !visible()) return;
        streamSectors = sectors;
        const url = `/api/stream?s=${sectors}${pow ? `&pow=${pow}` : ''}`;
        logSent('GET', url, null);
        streamAt = Date.now();
        stream = new EventSource(url);
        stream.addEventListener('snapshot', (e) => {
            streamAt = Date.now();
            retryMs = 3000;
            setLive(true);
            applySnapshot(JSON.parse(e.data));
            flushQueue();
        });
        stream.addEventListener('report', (e) => {
            streamAt = Date.now();
            upsertReport(JSON.parse(e.data));
            afterChange();
        });
        stream.addEventListener('remove', (e) => {
            streamAt = Date.now();
            removeReport(JSON.parse(e.data).id);
            afterChange();
        });
        stream.addEventListener('ping', () => { streamAt = Date.now(); });
        // Le serveur renouvelle chaque flux toutes les 20 à 30 min : on en rouvre un tout de suite, sans
        // passer « hors ligne » (la photo du nouveau flux remet tout à jour)
        stream.addEventListener('renouvelle', () => {
            stream.close();
            stream = null;
            connect();
        });
        stream.addEventListener('error', () => {
            disconnect();
            if (!visible()) return;
            // Délai tiré au hasard autour de la valeur prévue : après une coupure du serveur, des milliers
            // de téléphones ne reviennent pas tous à la même seconde
            retryTimer = setTimeout(connect, retryMs * (0.5 + Math.random()));
            retryMs = Math.min(retryMs * 2, 60_000);
        });
    } finally {
        connecting = false;
    }
}

// Sans rien recevoir depuis 70 s (le serveur bat toutes les 45 s), le flux est mort : on le relance
function watchStream() {
    if (stream && Date.now() - streamAt > 70_000) {
        disconnect();
        connect();
    }
}

function disconnect() {
    clearTimeout(retryTimer);
    if (stream) stream.close();
    stream = null;
    if (state.live) setLive(false);
}

// Toutes les 30 s : âges à jour, ménage hors ligne, état du réseau
function tick() {
    watchStream();
    // Signalements en attente (envoi raté alors que le flux restait ouvert) : nouvel essai sans attendre
    // la prochaine reconnexion, espacé après chaque échec (voir flushQueue). La file vide avant
    // d'envoyer : pas de double envoi.
    if (state.live && Date.now() >= flushAfter && store.get(KEY.queue, []).length) flushQueue();
    if (state.live) state.lastSync = serverNow();
    const ttl = state.config.reportTtlMin * MIN;
    for (const r of [...state.reports.values()]) {
        // + 1 min : le serveur diffuse l'heure arrondie à la minute inférieure. Sans cette marge, un danger
        // disparaissait jusqu'à 1 min avant le serveur, puis revenait à la reconnexion suivante.
        if (serverNow() - r.updatedAt > ttl + MIN) removeReport(r.id);
        else if (markers.has(r.id)) paint(markers.get(r.id), markerHtml(r));
    }
    for (const h of state.helps.values()) {
        if (helpMarkers.has(h.id)) paint(helpMarkers.get(h.id), helpHtml(h));
    }
    pruneMine();
    refreshAlert();
    renderNet();
    if (Date.now() - windAt > 10 * MIN) loadWind();
}

let tickTimer = 0;

function startLoops() {
    clearInterval(tickTimer);
    tickTimer = setInterval(tick, 30_000);
    if (state.medicCode) medicLoop();
    if (state.myHelp) pollHelp();
    if (state.buddy) buddyPoll();
}

function stopLoops() {
    clearInterval(tickTimer);
    clearTimeout(medicTimer);
    clearTimeout(helpTimer);
    clearTimeout(buddyTimer);
}

// Écran éteint ou appli en arrière-plan : plus de réseau, plus de GPS, plus de capteur, plus de minuterie.
// Au retour, tout repart et la carte se remet à jour d'un coup.
function onVisibility() {
    if (visible()) {
        retryMs = 3000;
        connect();
        if (introSeen) watchPosition();
        startLoops();
        tick();
        // Scan coupé par la mise en veille : la caméra repart si sa feuille est toujours ouverte
        const s = scanPaused;
        scanPaused = null;
        if (s && state.sheet && document.getElementById(state.sheet).contains($(s.view)) && !$(s.view).classList.contains('hidden')) startScan(s);
    } else {
        helpClosing?.(); // « Réglé » touché juste avant de verrouiller : la fermeture part maintenant
        disconnect();
        stopPosition();
        stopLoops();
        scanPaused = scanCfg;
        stopScan();
    }
    syncCompass();
}

// ------------------------------------------------------------------ carte sans réseau

function tileXY(lat, lng, z) {
    const n = 2 ** z;
    const x = Math.floor(((lng + 180) / 360) * n);
    const y = Math.floor(((1 - Math.log(Math.tan(toRad(lat)) + 1 / Math.cos(toRad(lat))) / Math.PI) / 2) * n);
    return [x, y];
}

async function prepareZone() {
    const btn = $('#zoneBtn');
    const hint = $('#zoneHint');
    // La zone se prend autour du centre de la carte : dézoomée (sans position, toute la France), ce n'est
    // pas la manif ; et sans service worker actif, rien ne serait gardé pour le hors ligne
    if (map.getZoom() < 13) {
        hint.textContent = 'Ferme les réglages, zoome sur le lieu de la manif, puis recommence.';
        return;
    }
    if (!navigator.serviceWorker?.controller) {
        hint.textContent = 'Le hors ligne n\'est pas encore prêt sur ce téléphone : recharge Vigie avec du réseau, puis recommence.';
        return;
    }
    const c = map.getCenter();
    const km = 1.5;
    const dLat = km / 111.32;
    const dLng = km / (111.32 * Math.cos(toRad(c.lat)));
    const urls = [];
    // Carte vectorielle : les données s'arrêtent au zoom maximal de la carte (le téléphone agrandit au-delà), et le zoom
    // affiché z lit les données du zoom z - 1 ; images : zooms 13 à 17
    const [z0, z1] = isVector() ? [12, tilesInfo().maxZoom] : [13, 17];
    for (let z = z0; z <= z1; z++) {
        const [x0, y0] = tileXY(c.lat + dLat, c.lng - dLng, z);
        const [x1, y1] = tileXY(c.lat - dLat, c.lng + dLng, z);
        for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) urls.push(tileUrl(z, x, y));
    }
    const total = urls.length;
    // Une seule ligne dans le journal Transparence pour toute la zone (des centaines de morceaux)
    logSent('GET', '/tiles/zone', { morceaux: total });
    let done = 0;
    let failed = 0;
    btn.disabled = true;
    const worker = async () => {
        while (urls.length) {
            const u = urls.pop();
            try {
                if (!(await fetch(u)).ok) failed++;
            } catch {
                failed++;
            }
            done++;
            hint.textContent = `Téléchargement : ${done} sur ${total} morceaux de carte.`;
        }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
    btn.disabled = false;
    hint.textContent = failed
        ? `Terminé, mais ${failed} morceaux manquent. Recommence avec du réseau.`
        : 'Zone prête : la carte s\'affiche même sans réseau.';
}

// Le téléphone d'abord (c'est l'urgence : sur un réseau saturé, attendre le serveur laissait tout en
// place), puis le serveur, sans l'attendre plus de 2 s
async function wipeAll() {
    // Une demande d'aide en cours est retirée chez les medics d'abord (keepalive : elle part même si la
    // page se recharge) ; sinon elle y restait 45 min, avec son type et son point
    const h = state.myHelp;
    if (h) api('DELETE', `/api/help/${h.id}`, null, { 'X-Owner-Token': h.token }).catch(() => { /* elle expirera seule */ });
    wiping = true;
    try { localStorage.clear(); } catch { /* rien à effacer */ }
    try { sessionStorage.clear(); } catch { /* rien à effacer */ }
    try {
        for (const k of await caches.keys()) await caches.delete(k);
    } catch { /* pas de cache */ }
    try {
        for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister();
    } catch { /* pas de service worker */ }
    // Le navigateur vide aussi son propre cache HTTP (en-tête Clear-Site-Data) ; sans réseau, tant pis
    await Promise.race([
        fetch('/api/efface', { method: 'POST', cache: 'no-store' }).catch(() => { /* hors ligne */ }),
        new Promise((r) => setTimeout(r, 2000)),
    ]);
    location.reload();
}

// ------------------------------------------------------------------ faire connaître Vigie

const appUrl = () => `${location.origin}/`;

// Le menu de partage du téléphone : la personne choisit l'appli, Vigie ne charge rien d'un réseau social
async function shareApp() {
    if (navigator.share) {
        try {
            await navigator.share({
                title: 'Vigie',
                text: 'Vigie : une carte partagée pour se protéger en manif. Sans compte, sans traceur.',
                url: appUrl(),
            });
            return;
        } catch (e) {
            if (e.name === 'AbortError') return; // partage annulé par la personne
        }
    }
    copyAppUrl();
}

async function copyAppUrl() {
    try {
        if (!navigator.clipboard?.writeText) throw new Error('indisponible');
        await navigator.clipboard.writeText(appUrl());
        toast('Lien copié : colle-le où tu veux.');
    } catch {
        // Dernier recours : le lien s'affiche, à recopier ou à faire scanner
        openShareQr();
        toast('Recopie l\'adresse affichée, ou fais scanner le QR.');
    }
}

function openShareQr() {
    // Le QR maison ne code que les majuscules (mode alphanumérique) ; l'adresse s'écrit aussi bien en
    // majuscules (HTTPS://VIGIEMAP.ORG/), et en minuscules elle donnait un QR illisible
    drawQr($('#shareQr'), appUrl().toUpperCase());
    $('#shareUrl').textContent = appUrl().replace(/^https?:\/\//, '').replace(/\/$/, '');
    openSheet('sheetShare');
}

// ------------------------------------------------------------------ écran « Transparence »

function sentLabel(method, url) {
    const p = url.split('?')[0];
    if (p === '/api/config') return 'Réglages du serveur';
    if (p === '/api/stream') return 'Connexion temps réel (secteurs d\'environ 50 km autour de ta position)';
    if (p === '/api/wind') return 'Météo du secteur';
    if (p === '/api/reports' && method === 'POST') return 'Signalement';
    if (p.endsWith('/confirm')) return 'Confirmation';
    if (p.endsWith('/gone')) return '« Ce n\'est plus là »';
    if (p.endsWith('/tag')) return 'Marque de ta cellule (illisible pour le serveur)';
    if (p.startsWith('/api/reports/') && method === 'DELETE') return 'Annulation de ton signalement';
    if (p === '/api/help' && method === 'POST') return 'Demande d\'aide';
    if (p === '/api/help') return 'Demandes d\'aide (mode medic)';
    if (p.startsWith('/api/help/')) return 'Suivi de ta demande d\'aide';
    if (p.startsWith('/api/buddy/')) return method === 'POST' ? 'Binôme : message chiffré' : 'Binôme : relevé des messages chiffrés';
    if (p === '/api/cell/pair') return 'Code court : ta cellule confiée au serveur 12 h';
    if (p === '/api/cell/claim') return 'Code court : rejoindre une cellule';
    if (p === '/tiles/zone') return 'Carte sans réseau : morceaux d\'environ 3 km autour du centre de la carte';
    return `${method} ${p}`;
}

const HEADER_NAMES = {
    'X-Pow': 'preuve anti-spam (un petit calcul fait par ton téléphone)', 'X-Medic-Code': 'code medic', 'X-Owner-Token': 'jeton de ta demande',
    'X-Delete-Token': 'jeton d\'annulation', 'Content-Type': null,
};

// Contenu lisible d'un envoi : les longues suites (empreintes, clés, messages chiffrés) sont raccourcies
function sentDetail(e) {
    const short = (v) => (typeof v === 'string' && v.length > 24 ? `${v.slice(0, 10)}… (${v.length} car.)` : v);
    const body = e.body ? JSON.stringify(Object.fromEntries(Object.entries(e.body).map(([k, v]) => [k, short(v)]))) : '';
    const query = e.url.includes('?') ? `?${e.url.split('?')[1]}` : '';
    const heads = e.headers.map((h) => HEADER_NAMES[h] === undefined ? h : HEADER_NAMES[h]).filter(Boolean);
    return [query, body, heads.length ? `+ ${heads.join(', ')}` : ''].filter(Boolean).join('\n') || '(rien d\'autre)';
}

function renderTransparence() {
    const tiles = performance.getEntriesByType('resource').filter((r) => r.name.includes('/tiles/')).length;
    $('#transpTiles').textContent = `Carte : ${tiles} morceau${tiles > 1 ? 'x' : ''} affiché${tiles > 1 ? 's' : ''}, y compris ceux déjà gardés sur ce téléphone, qui ne repartent pas. `
        + 'Ceux demandés au serveur lui montrent la zone affichée, souvent là où tu es, à 1 ou 2 km près.';
    const list = $('#transpLog');
    list.replaceChildren(...sentLog.map((e) => {
        const li = document.createElement('li');
        const head = document.createElement('strong');
        head.textContent = `${new Date(e.at).toLocaleTimeString('fr-FR')} · ${sentLabel(e.method, e.url)}`;
        const code = document.createElement('code');
        code.textContent = sentDetail(e);
        li.append(head, code);
        return li;
    }));
    $('#transpEmpty').classList.toggle('hidden', sentLog.length > 0);
}

// ------------------------------------------------------------------ maintenir pour confirmer

function bindHold(btn, onDone) {
    const ms = Number(btn.dataset.hold) || 1500;
    let start = 0;
    let raf = 0;
    const stop = () => {
        cancelAnimationFrame(raf);
        btn.style.setProperty('--p', 0);
    };
    const step = (t) => {
        const p = Math.min(1, (t - start) / ms);
        btn.style.setProperty('--p', p);
        if (p >= 1) {
            stop();
            buzz(80);
            onDone();
        } else {
            raf = requestAnimationFrame(step);
        }
    };
    btn.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        start = performance.now();
        raf = requestAnimationFrame(step);
    });
    ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => btn.addEventListener(ev, stop));
    btn.addEventListener('contextmenu', (e) => e.preventDefault());
    // Clavier et contacteurs : Entrée ou Espace maintenu remplit la jauge comme un doigt posé
    btn.addEventListener('keydown', (e) => {
        if ((e.key !== 'Enter' && e.key !== ' ') || e.repeat) return;
        e.preventDefault();
        start = performance.now();
        raf = requestAnimationFrame(step);
    });
    btn.addEventListener('keyup', (e) => { if (e.key === 'Enter' || e.key === ' ') stop(); });
    btn.addEventListener('blur', stop);
}

// ------------------------------------------------------------------ écrans pleins

function showCard(id) {
    $(`#${id}`).classList.remove('hidden');
    syncCompass();
}

function hideCard(id) {
    $(`#${id}`).classList.add('hidden');
    syncCompass();
}

// ------------------------------------------------------------------ installer sur l'écran d'accueil

// Chrome et Edge (Android surtout) proposent l'installation d'un geste ; Safari jamais, d'où le guide
let installPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    installPrompt = e;
});
window.addEventListener('appinstalled', () => {
    installPrompt = null;
    renderInstall();
});

const isInstalled = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
// iPad récent : il se présente comme un Mac, mais tactile
const isIos = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

function renderInstall() {
    const done = isInstalled();
    $('#installBtn').classList.toggle('hidden', done);
    $('#introInstall').classList.toggle('hidden', done);
    if (done) $('#installHint').textContent = 'Vigie est installée sur ce téléphone.';
    // iPhone : l'icône installée a son propre stockage, rien de ce qui est fait dans Safari ne la suit
    $$('.ios-first').forEach((el) => el.classList.toggle('hidden', done || !isIos()));
}

function showInstallOs(os) {
    $('#installIos').classList.toggle('hidden', os !== 'ios');
    $('#installAndroid').classList.toggle('hidden', os !== 'android');
    $$('#installSeg [data-os]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.os === os)));
}

function openInstall() {
    showInstallOs(isIos() ? 'ios' : 'android');
    $('#installNow').classList.toggle('hidden', !installPrompt);
    openSheet('sheetInstall');
}

async function installNow() {
    if (!installPrompt) return;
    const prompt = installPrompt;
    installPrompt = null; // une seule proposition possible par chargement de page
    $('#installNow').classList.add('hidden');
    prompt.prompt();
    if ((await prompt.userChoice).outcome === 'accepted') {
        closeSheet();
        toast('Vigie est installée : retrouve-la sur ton écran d\'accueil.', { ms: 6000 });
    }
}

function showIntro() {
    const demo = $('#introDemo');
    demo.classList.toggle('hidden', !state.config.demo);
    demo.textContent = 'Démo : faux signalements autour de la place de la République, position simulée.';
    showCard('intro');
}

// ------------------------------------------------------------------ branchements

function bindUi() {
    $$('[data-icon]').forEach((el) => { el.innerHTML = icon(el.dataset.icon); });

    $('#reportBtn').addEventListener('click', () => openSheet('sheetReport'));
    $('#helpBtn').addEventListener('click', () => openSheet('sheetHelp'));
    $('#menuBtn').addEventListener('click', () => openSheet('sheetMenu'));
    $('#buddyBtn').addEventListener('click', openBuddy);
    $('#gasBtn').addEventListener('click', () => showCard('gasCard'));
    $('#windBtn').addEventListener('click', () => showCard('gasCard'));

    $('#reportGrid').addEventListener('click', (e) => {
        const b = e.target.closest('[data-report]');
        if (b) sendReport(b.dataset.report);
    });
    $('#reportMore').addEventListener('click', (e) => {
        const b = e.target.closest('[data-report]');
        if (b) sendReport(b.dataset.report);
    });
    $('#helpGrid').addEventListener('click', (e) => {
        const b = e.target.closest('[data-help]');
        if (b) sendHelp(b.dataset.help);
    });

    $$('.sheet [data-close]').forEach((b) => b.addEventListener('click', closeSheet));
    $('#scrim').addEventListener('click', closeSheet);
    $('#gasCard [data-close]').addEventListener('click', () => hideCard('gasCard'));
    $('#gasHelp').addEventListener('click', () => {
        hideCard('gasCard');
        openSheet('sheetHelp');
    });
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        closeSheet();
        hideCard('gasCard');
    });

    $('#alertMain').addEventListener('click', () => {
        const r = state.reports.get($('#alert').dataset.id);
        if (!r) return;
        map.setView([r.lat, r.lng], Math.max(map.getZoom(), 16));
        openDetail(r.id);
    });
    $('#alertClose').addEventListener('click', () => {
        const r = state.reports.get($('#alert').dataset.id);
        if (r && state.pos) state.dismissed.set(r.id, { cell: seenByCell(r), d: distance(state.pos, [r.lat, r.lng]) });
        refreshAlert();
    });

    $('#helpDone').addEventListener('click', closeMyHelp);
    $('#medicBar').addEventListener('click', () => {
        const pts = [...state.helps.values()].map((h) => [h.lat, h.lng]);
        if (!pts.length) return;
        // Cadre les demandes dans la partie de carte que les bandeaux et le dock ne cachent pas
        const top = $('.stack').getBoundingClientRect().bottom + 30;
        map.fitBounds(pts, { paddingTopLeft: [50, top], paddingBottomRight: [80, 140], maxZoom: 17 });
    });

    $('#zoomIn').addEventListener('click', () => map.zoomIn());
    $('#zoomOut').addEventListener('click', () => map.zoomOut());
    $('#locateBtn').addEventListener('click', async () => {
        // iPhone : la boussole demande une autorisation, à donner sur un geste
        if (typeof window.DeviceOrientationEvent?.requestPermission === 'function') {
            try { await DeviceOrientationEvent.requestPermission(); } catch { /* refusé */ }
        }
        preciseFor(60_000);
        if (state.pos) map.setView(state.pos, Math.max(map.getZoom(), 16));
        else toast('Position inconnue : autorise la localisation pour les alertes de proximité.', { ms: 6000 });
    });
    $('#posChip').addEventListener('click', onPosChip);
    // Autorisation changée dans les réglages du navigateur pendant que Vigie est ouverte
    navigator.permissions?.query({ name: 'geolocation' }).then((p) => {
        p.addEventListener('change', () => {
            if (p.state === 'granted' && introSeen) watchPosition();
            else if (p.state === 'denied') setGeoState('denied');
        });
    }).catch(() => { /* API absente : le bandeau suit les erreurs de position */ });

    $('#themeSeg').addEventListener('click', (e) => {
        const b = e.target.closest('[data-theme-choice]');
        if (!b) return;
        store.set(KEY.theme, b.dataset.themeChoice);
        applyTheme();
    });
    matchMedia('(prefers-color-scheme: light)').addEventListener('change', applyTheme);

    renderAlertChoice();
    $('#alertSeg').addEventListener('click', (e) => {
        const b = e.target.closest('[data-alert-choice]');
        if (!b) return;
        store.set(KEY.alerts, b.dataset.alertChoice);
        renderAlertChoice();
        refreshAlert();
    });

    $('#zoneBtn').addEventListener('click', prepareZone);
    renderInstall();
    $('#installBtn').addEventListener('click', openInstall);
    $('#installNow').addEventListener('click', installNow);
    $('#installSeg').addEventListener('click', (e) => {
        const b = e.target.closest('[data-os]');
        if (b) showInstallOs(b.dataset.os);
    });
    $('#introInstall').addEventListener('click', () => {
        store.set(KEY.intro, true);
        hideCard('intro');
        // Comme « C'est parti » : sinon la carte restait sans position ni alerte, sans rien le dire
        introSeen = true;
        watchPosition();
        openInstall();
    });
    $('#medicForm').addEventListener('submit', (e) => {
        e.preventDefault();
        const code = $('#medicInput').value.trim();
        if (code) startMedic(code);
    });
    $('#medicOff').addEventListener('click', () => {
        stopMedic();
        toast('Mode medic coupé');
    });

    $('#cellBtn').addEventListener('click', openCell);
    $('#cellBack').addEventListener('click', () => showCellView('cellHome'));
    $('#cellJoinBtn').addEventListener('click', () => showCellView('cellJoin'));
    $('#cellCreateBtn').addEventListener('click', createCell);
    $('#cellShareBtn').addEventListener('click', () => showCellView('cellShare'));
    $('#cellLeaveBtn').addEventListener('click', leaveCell);
    $('#cellCopyBtn').addEventListener('click', copyCode);
    $('#cellPinBtn').addEventListener('click', showPin);
    $('#cellCodeForm').addEventListener('submit', (e) => { e.preventDefault(); joinByCode(); });

    $('#transpBtn').addEventListener('click', () => {
        renderTransparence();
        openSheet('sheetTransp');
    });

    $('#shareBtn').addEventListener('click', shareApp);
    $('#shareQrBtn').addEventListener('click', openShareQr);
    $('#shareCopyBtn').addEventListener('click', copyAppUrl);

    $('#rulesBtn').addEventListener('click', () => {
        closeSheet();
        showIntro();
    });
    $('#introGo').addEventListener('click', () => {
        store.set(KEY.intro, true);
        hideCard('intro');
        introSeen = true;
        watchPosition();
    });

    bindHold($('#wipeBtn'), wipeAll);

    bindHold($('#arrestBtn'), buddyArrest);
    $('#aliveBtn').addEventListener('click', buddyAlive);
    $('#buddyBack').addEventListener('click', () => showBuddyView('buddyHome'));
    $('#buddyCreateBtn').addEventListener('click', createBuddy);
    $('#buddyJoinBtn').addEventListener('click', () => showBuddyView('buddyJoin'));
    $('#buddyShareBtn').addEventListener('click', () => showBuddyView('buddyShare'));
    $('#buddyLeaveBtn').addEventListener('click', leaveBuddy);
    $('#buddyCopyBtn').addEventListener('click', copyBuddyCode);
    $('#buddyCodeForm').addEventListener('submit', (e) => { e.preventDefault(); joinBuddyByCode(); });
    $('#buddyNameInput').addEventListener('change', saveBuddyName);
    $('#buddyAlert').addEventListener('click', openBuddy);
    $('#buddyList').addEventListener('click', (e) => {
        const btn = e.target.closest('.buddy__loc');
        if (!btn) return;
        closeSheet();
        map.setView([Number(btn.dataset.lat), Number(btn.dataset.lng)], Math.max(map.getZoom(), 16));
    });

    // Un message recouvre « Gazé·e ? », « Binôme » ou la position : un toucher le ferme
    $('#toast').addEventListener('click', (e) => { if (!e.target.closest('#toastUndo')) hideToast(); });

    // Le réseau revient : on se reconnecte tout de suite, sans attendre la fin du délai d'attente. L'horloge
    // a pu dériver pendant la coupure : on la recale d'abord, sinon la preuve du flux serait refusée.
    window.addEventListener('online', () => {
        retryMs = 3000;
        refreshConfig(4000).catch(() => { /* le flux réessaiera de lui-même */ }).finally(connect);
        loadWind();
    });
    document.addEventListener('visibilitychange', onVisibility);
}

// Durées promises à l'écran (Transparence, règles), tirées de la configuration de CE serveur : une
// instance réglée autrement n'affiche jamais une promesse fausse. Et le lien vers son code source.
function renderCfg() {
    const c = state.config;
    const v = {
        reportTtlMin: c.reportTtlMin, helpTtlMin: c.helpTtlMin, buddyTtlMin: c.buddyTtlMin,
        pairTtlH: Number.isFinite(c.pairTtlMin) ? Math.round(c.pairTtlMin / 60) : undefined, windRefreshMin: c.windRefreshMin,
    };
    $$('[data-cfg]').forEach((el) => { if (Number.isFinite(v[el.dataset.cfg])) el.textContent = String(v[el.dataset.cfg]); });
    const src = typeof c.sourceUrl === 'string' && /^https:\/\/[^\s"<>]+$/.test(c.sourceUrl) ? c.sourceUrl : null;
    $('#srcLater').classList.toggle('hidden', Boolean(src));
    $('#srcNow').classList.toggle('hidden', !src);
    if (src) $('#srcLink').href = src;
}

// Configuration du serveur, appliquée tout de suite (difficulté anti-spam relevée pendant une attaque,
// nouvelle carte, fin de la démo), pas seulement au prochain lancement
async function refreshConfig(timeoutMs = 8000) {
    const c = await api('GET', '/api/config', null, {}, timeoutMs);
    // L'heure du serveur sert à recaler l'horloge, jamais gardée : sur un téléphone saisi, elle dirait
    // à la seconde près la dernière fois que Vigie a été ouverte avec du réseau
    const keep = { ...c };
    delete keep.now;
    store.set(KEY.config, keep);
    if (Number.isFinite(c.now)) setClock(c.now);
    const old = state.config;
    state.config = { ...DEFAULT_CONFIG, ...c };
    if (map && c.tiles?.version !== old.tiles?.version) setupTiles();
    if (old.demo && !state.config.demo) { state.pos = null; if (introSeen) watchPosition(); }
    renderCfg();
}

async function init() {
    applyTheme();
    // Le compteur de carte de Transparence lit cette liste : par défaut, le navigateur s'arrête à 250
    performance.setResourceTimingBufferSize?.(5000);
    // Déjà venu : on démarre avec la configuration enregistrée, sans attendre le réseau,
    // et on la rafraîchit en arrière-plan pour la prochaine ouverture
    const saved = store.get(KEY.config, null);
    if (saved) {
        state.config = { ...DEFAULT_CONFIG, ...saved };
        refreshConfig().catch(() => { /* plus tard */ });
    } else {
        try {
            await refreshConfig(6000);
        } catch {
            // Tout premier lancement sur un réseau saturé : sans config, la carte resterait vide toute la
            // session. On réessaie toutes les 15 s jusqu'à l'avoir.
            state.config = DEFAULT_CONFIG;
            const retry = () => refreshConfig().catch(() => setTimeout(retry, 15_000));
            setTimeout(retry, 15_000);
        }
    }

    bindUi();
    buildGrids();
    initMap();
    loadCache();
    renderNet();
    renderMedicUi();
    renderHelpStatus();
    renderCellRow();
    renderCfg();

    // D'abord : si la position est déjà là, le flux s'abonne directement aux bons secteurs. Au premier
    // lancement, la demande attend l'écran des règles, qui explique pourquoi et ce qu'on en fait.
    introSeen = store.get(KEY.intro, false);
    if (introSeen) watchPosition();
    connect();
    loadWind();
    startLoops();
    if (!introSeen) showIntro();

    // Le hors ligne s'installe une fois la carte affichée, pour ne pas lui voler de bande passante
    if ('serviceWorker' in navigator && window.isSecureContext) {
        const register = () => navigator.serviceWorker.register('/sw.js').then((reg) => {
            // Appli restée ouverte des jours : le navigateur ne cherche une nouvelle version qu'en ouvrant
            // une page. On la cherche au retour au premier plan, au plus une fois par heure.
            let checked = Date.now();
            document.addEventListener('visibilitychange', () => {
                if (!visible() || Date.now() - checked < 60 * MIN) return;
                checked = Date.now();
                reg.update().catch(() => { /* hors ligne */ });
            });
        }).catch(() => { /* hors ligne indisponible */ });
        if (document.readyState === 'complete') register();
        else window.addEventListener('load', register, { once: true });
    }
}

init();
