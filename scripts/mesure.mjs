// SPDX-License-Identifier: AGPL-3.0-or-later
// Banc de mesure de Vigie : chargement sur un petit téléphone et coût au repos.
// Lance un navigateur Chromium (Chrome, Chromium ou Edge) sans fenêtre et le pilote par le protocole
// DevTools (Node 22 ou plus, aucune dépendance). Autre navigateur : variable NAVIGATEUR=/chemin/vers/lui.
// Usage : node scripts/mesure.mjs [adresse] [secondes de repos]

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const APP = process.argv[2] || 'http://localhost:4321/';
const ORIGIN = new URL(APP).origin;
const IDLE_S = Number(process.argv[3]) || 60;
// Premier navigateur trouvé aux emplacements habituels (Linux, macOS, Windows)
const NAV = process.env.NAVIGATEUR || [
    '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/usr/bin/microsoft-edge',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((p) => existsSync(p));
if (!NAV) {
    console.error('Aucun navigateur Chromium trouvé : indique-le avec NAVIGATEUR=/chemin/vers/chrome');
    process.exit(1);
}
const DEBUG_PORT = 9400 + Math.floor(Math.random() * 500);

// Petit téléphone : écran 360x640, processeur 4 fois plus lent, 4G dégradée (profil mobile de Lighthouse)
const PHONE = { width: 360, height: 640, deviceScaleFactor: 2, mobile: true };
const NET = { offline: false, latency: 150, downloadThroughput: 1.6e6 / 8, uploadThroughput: 750e3 / 8 };
const CPU = 4;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Repère le moment où les marqueurs puis les tuiles apparaissent, sans toucher au code de l'appli
const PROBE = `(() => {
    const check = () => {
        if (!window.__mk && document.querySelector('.mk')) window.__mk = performance.now();
        if (!window.__tiles && document.querySelectorAll('.leaflet-tile-loaded').length >= 6) window.__tiles = performance.now();
        if (window.__mk && window.__tiles) obs.disconnect();
    };
    const obs = new MutationObserver(check);
    obs.observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
})();`;

async function launch() {
    const dir = mkdtempSync(path.join(tmpdir(), 'vigie-mesure-'));
    const proc = spawn(NAV, [
        '--headless=new', `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${dir}`,
        '--no-first-run', '--no-default-browser-check', '--disable-extensions', 'about:blank',
    ], { stdio: 'ignore' });
    for (let i = 0; i < 75; i++) {
        try {
            const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
            const page = list.find((t) => t.type === 'page');
            if (page) return { proc, dir, ws: page.webSocketDebuggerUrl };
        } catch { /* le navigateur démarre encore */ }
        await sleep(200);
    }
    throw new Error('Le navigateur ne répond pas');
}

function connect(url) {
    const ws = new WebSocket(url);
    let next = 0;
    const pending = new Map();
    const listeners = new Map();
    ws.addEventListener('message', (e) => {
        const msg = JSON.parse(e.data);
        if (msg.id && pending.has(msg.id)) {
            const { resolve, reject } = pending.get(msg.id);
            pending.delete(msg.id);
            if (msg.error) reject(new Error(msg.error.message));
            else resolve(msg.result);
        } else if (msg.method) {
            for (const fn of listeners.get(msg.method) || []) fn(msg.params);
        }
    });
    return new Promise((ok) => ws.addEventListener('open', () => ok({
        send: (method, params = {}) => new Promise((resolve, reject) => {
            const id = ++next;
            pending.set(id, { resolve, reject });
            ws.send(JSON.stringify({ id, method, params }));
        }),
        on: (method, fn) => {
            if (!listeners.has(method)) listeners.set(method, []);
            listeners.get(method).push(fn);
        },
        close: () => ws.close(),
    })));
}

// ------------------------------------------------------------------ comptage réseau

const net = { requests: 0, bytes: 0, sseChunks: 0, sseIds: new Set(), urls: [] };
const resetNet = () => {
    net.requests = 0;
    net.bytes = 0;
    net.sseChunks = 0;
    net.urls = [];
};

async function evaluate(c, expression) {
    const { result } = await c.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    return result.value;
}

async function metrics(c) {
    const { metrics: list } = await c.send('Performance.getMetrics');
    return Object.fromEntries(list.map((m) => [m.name, m.value]));
}

// ------------------------------------------------------------------ scénarios

async function load(c, { navigate = true } = {}) {
    resetNet();
    if (navigate) await c.send('Page.navigate', { url: APP });
    else await c.send('Page.reload', {});
    let r = {};
    for (let i = 0; i < 400; i++) {
        await sleep(100);
        try {
            r = JSON.parse(await evaluate(c, `JSON.stringify({
                marqueurs: window.__mk || null,
                tuiles: window.__tiles || null,
                fcp: performance.getEntriesByName('first-contentful-paint')[0]?.startTime || null,
            })`));
            if (r.marqueurs && r.tuiles) break;
        } catch { /* la page change */ }
    }
    await sleep(2000);
    const round = (v) => (v === null ? null : Math.round(v));
    return {
        premierAffichageMs: round(r.fcp),
        marqueursMs: round(r.marqueurs),
        carteMs: round(r.tuiles),
        requetes: net.requests,
        koTransferes: Math.round(net.bytes / 1024),
    };
}

async function idle(c, seconds) {
    const m0 = await metrics(c);
    resetNet();
    await sleep(seconds * 1000);
    const m1 = await metrics(c);
    const perMin = 60 / seconds;
    return {
        cpuMsParMin: Math.round((m1.TaskDuration - m0.TaskDuration) * 1000 * perMin),
        scriptMsParMin: Math.round((m1.ScriptDuration - m0.ScriptDuration) * 1000 * perMin),
        recalculsStyleParMin: Math.round((m1.RecalcStyleCount - m0.RecalcStyleCount) * perMin),
        reveilsReseauParMin: Math.round((net.requests + net.sseChunks) * perMin),
        detail: [...new Set(net.urls)],
    };
}

async function main() {
    const { proc, dir, ws } = await launch();
    const c = await connect(ws);
    try {
        c.on('Network.requestWillBeSent', (p) => {
            net.requests++;
            net.urls.push(p.request.url.replace(ORIGIN, '').replace(/\/tiles\/.*/, '/tiles/…'));
            if (p.type === 'EventSource') net.sseIds.add(p.requestId);
        });
        c.on('Network.loadingFinished', (p) => { net.bytes += p.encodedDataLength; });
        c.on('Network.dataReceived', (p) => { if (net.sseIds.has(p.requestId)) net.sseChunks++; });

        await c.send('Page.enable');
        await c.send('Network.enable');
        await c.send('Runtime.enable');
        await c.send('Performance.enable');
        await c.send('Emulation.setDeviceMetricsOverride', PHONE);
        await c.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
        await c.send('Page.addScriptToEvaluateOnNewDocument', { source: PROBE });

        // Tour de chauffe : remplit le cache de tuiles du serveur, puis on repart d'un téléphone vierge
        await load(c);
        await c.send('Storage.clearDataForOrigin', { origin: ORIGIN, storageTypes: 'all' });
        await c.send('Network.clearBrowserCache');
        await c.send('Page.navigate', { url: 'about:blank' });
        await sleep(500);

        await c.send('Network.emulateNetworkConditions', NET);
        await c.send('Emulation.setCPUThrottlingRate', { rate: CPU });

        const premier = await load(c);
        const second = await load(c, { navigate: false });
        const repos = await idle(c, IDLE_S);

        // Demande d'aide en attente : la personne attend un medic, l'appli surveille la réponse
        const h = await (await fetch(`${ORIGIN}/api/help`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'blesse', lat: 48.8667, lng: 2.3651 }),
        })).json();
        await evaluate(c, `localStorage.setItem('vigie.help', ${JSON.stringify(JSON.stringify({ id: h.id, token: h.ownerToken, type: 'blesse', status: 'waiting' }))}); 'ok'`);
        await load(c, { navigate: false });
        const reposAide = await idle(c, IDLE_S);
        await evaluate(c, "localStorage.removeItem('vigie.help'); 'ok'");
        await load(c, { navigate: false });

        // Écran éteint ou appli en arrière-plan (simulé : on annonce la page cachée)
        await evaluate(c, `Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
            Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
            document.dispatchEvent(new Event('visibilitychange')); 'ok'`);
        const cache = await idle(c, IDLE_S);

        const out = { app: APP, telephone: '360x640, CPU x4, 4G dégradée', premier, second, repos, reposAide, cache };
        console.log(JSON.stringify(out, null, 2));
    } finally {
        c.close();
        proc.kill();
        await sleep(500);
        try { rmSync(dir, { recursive: true, force: true }); } catch { /* le navigateur tient encore le dossier */ }
    }
}

main().catch((e) => {
    console.error('Mesure impossible :', e.message);
    process.exit(1);
});
