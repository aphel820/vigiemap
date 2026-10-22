// Aperçu des liens : balises de la page et image servie aux autres sites
import http from 'node:http';
let fails = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} : ${m}`); if (!c) fails++; };
process.env.DEMO = '1'; process.env.CERT = 'nope'; process.env.KEY = 'nope';
process.argv.push('--port=4502');
await import(new URL('../server.js', import.meta.url));
await new Promise((r) => setTimeout(r, 400));
const get = (path, headers = {}) => new Promise((resolve) => {
    http.get(`http://localhost:4502${path}`, { headers }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
});
// Un robot d'aperçu : aucun en-tête Sec-Fetch
const page = (await get('/', { 'User-Agent': 'facebookexternalhit/1.1' })).body.toString();
const meta = (p) => (page.match(new RegExp(`<meta (?:property|name)="${p}" content="([^"]*)"`)) || [])[1];
ok(/<title>Vigie<\/title>/.test(page), 'titre d\'onglet resté court : « Vigie »');
ok(meta('og:title') === 'Vigie : la carte des dangers en manif', `og:title : ${meta('og:title')}`);
ok(meta('og:image') === 'https://vigiemap.org/og.png', 'og:image en adresse complète');
ok(meta('twitter:card') === 'summary_large_image', 'grande image sur les réseaux');
ok((meta('description') || '').length > 50 && (meta('og:description') || '').length > 50, 'descriptions présentes');
const img = await get('/og.png', { 'User-Agent': 'facebookexternalhit/1.1' });
ok(img.status === 200 && img.headers['content-type'] === 'image/png' && img.body.readUInt32BE(16) === 1200 && img.body.readUInt32BE(20) === 630, 'image servie au robot : PNG 1200x630');
// Une messagerie web qui affiche l'image depuis son propre site
const cross = await get('/og.png', { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'no-cors', 'Sec-Fetch-Dest': 'image' });
ok(cross.status === 200 && cross.headers['cross-origin-resource-policy'] === 'cross-origin', 'image affichable par un autre site (CORP cross-origin)');
// Le reste reste fermé aux autres sites
const icon = await get('/icon-192.png', { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'no-cors', 'Sec-Fetch-Dest': 'image' });
ok(icon.status === 403, 'autres fichiers toujours refusés aux autres sites');
const own = await get('/icon-192.png');
ok(own.headers['cross-origin-resource-policy'] === 'same-origin', 'autres fichiers toujours en CORP same-origin');
// Lien vers le code source (licence AGPL) : par défaut, le code de Vigie
const conf = JSON.parse((await get('/api/config')).body.toString());
ok(conf.sourceUrl === 'https://github.com/aphel820/vigiemap', `lien vers le code source par défaut : ${conf.sourceUrl}`);

console.log(fails ? `\n${fails} ÉCHEC(S)` : '\nTOUT PASSE');
process.exit(fails ? 1 : 0);
