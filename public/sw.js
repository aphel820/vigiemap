// SPDX-License-Identifier: AGPL-3.0-or-later
// Vigie : service worker (hors ligne)
// Coque de l'appli et tuiles en cache. L'API n'est jamais mise en cache.

const VERSION = 'vigie-dev'; // remplacée par le serveur (empreinte de public/), voir server.js
const SHELL = `${VERSION}-shell`;
// Tuiles : un cache par jour, et seulement aujourd'hui et hier sont gardés. Les plus anciens s'effacent
// quand Vigie est rouverte (un service worker ne tourne pas appli fermée) : sur un téléphone saisi sans
// que Vigie ait été rouverte, les morceaux de carte des derniers jours d'usage sont encore là.
// (« Préparer la zone » se fait la veille au plus tôt.)
// Jour local (pas UTC) : sinon le cache changeait à 1 h ou 2 h du matin, en pleine soirée de manif
const localDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
// « Hier » par le calendrier, pas « il y a 24 h » : les jours de changement d'heure en durent 23 ou 25
const tilesCache = (daysAgo = 0) => {
    const d = new Date();
    d.setDate(d.getDate() - daysAgo);
    return `vigie-tiles-${localDay(d)}`;
};
const keptTiles = () => [tilesCache(0), tilesCache(1)];
const SHELL_FILES = [
    '/',
    '/index.html',
    '/app.css',
    '/js/app.js',
    '/js/icons.js',
    '/js/qr.js',
    '/js/pow.js',
    '/js/codes.js',
    '/js/vent.js',
    '/vendor/leaflet/leaflet.js',
    '/vendor/leaflet/leaflet.css',
    '/vendor/protomaps-leaflet/protomaps-leaflet.js',
    '/vendor/protomaps-leaflet/flavors.js',
    '/vendor/fonts/atkinson-400.woff2',
    '/vendor/fonts/atkinson-700.woff2',
    '/manifest.webmanifest',
    '/icon.svg',
    '/icon-192.png',
];

self.addEventListener('install', (e) => {
    e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
    e.waitUntil(
        caches.keys()
            .then((keys) => Promise.all(keys
                .filter((k) => (k.endsWith('-shell') && k !== SHELL) || (k.startsWith('vigie-tiles') && !keptTiles().includes(k)))
                .map((k) => caches.delete(k))))
            .then(() => self.clients.claim()),
    );
});

self.addEventListener('fetch', (e) => {
    const req = e.request;
    if (req.method !== 'GET') return;
    const url = new URL(req.url);
    if (url.origin !== self.location.origin) return;
    if (url.pathname.startsWith('/api/')) return; // toujours le réseau, jamais de données périmées
    if (url.pathname.startsWith('/tiles/')) {
        e.respondWith(tile(req));
        return;
    }
    e.respondWith(shell(e, url));
});

// Tuiles : le cache d'abord (aujourd'hui, puis hier). Une rue ne bouge pas pendant une manif.
let cleanedDay = '';
async function tile(req) {
    const today = tilesCache(0);
    if (cleanedDay !== today) {
        cleanedDay = today;
        for (const k of await caches.keys()) if (k.startsWith('vigie-tiles') && !keptTiles().includes(k)) await caches.delete(k);
    }
    const cache = await caches.open(today);
    const hit = (await cache.match(req)) || (await caches.match(req, { cacheName: tilesCache(1) }));
    if (hit) return hit;
    try {
        const res = await fetch(req);
        if (res.ok) cache.put(req, res.clone());
        return res;
    } catch {
        return new Response('', { status: 504 });
    }
}

// Coque : on répond tout de suite avec le cache (réseau saturé = appli quand même instantanée),
// et on met à jour en arrière-plan pour la prochaine ouverture.
async function shell(e, url) {
    const cache = await caches.open(SHELL);
    const key = e.request.mode === 'navigate' ? '/index.html' : url.pathname;
    const hit = await cache.match(key);
    const net = fetch(e.request)
        .then((res) => {
            // Une navigation ne remplace la page de l'appli que par du HTML : ouvrir un lien vers une
            // image ou un autre fichier ne doit jamais prendre sa place au lancement suivant
            const html = (res.headers.get('content-type') || '').startsWith('text/html');
            if (res.ok && (e.request.mode !== 'navigate' || html)) cache.put(key, res.clone());
            return res;
        })
        .catch(() => null);
    if (hit) {
        e.waitUntil(net);
        return hit;
    }
    return (await net) || new Response('Hors ligne', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}

// Alerte en poche (mode medic) : l'envoi ne contient rien, la notification non plus (ni lieu, ni besoin).
// Il faut ouvrir Vigie pour voir la demande. Une seule notification à la fois : la suivante la remplace.
self.addEventListener('push', (e) => {
    // « Dans ta région » : l'inscription couvre les secteurs autour du medic, jusqu'à 50 km environ
    e.waitUntil(self.registration.showNotification('Vigie : demande d\'aide dans ta région', {
        body: 'Ouvre Vigie pour la voir.',
        tag: 'vigie-aide',
        renotify: true,
        icon: '/icon-192.png',
    }));
});

self.addEventListener('notificationclick', (e) => {
    e.notification.close();
    e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true })
        .then((list) => (list.length ? list[0].focus() : self.clients.openWindow('/'))));
});
