# Développer Vigie

Démo locale, tests, essais sur un vrai téléphone, organisation des fichiers. Pour proposer une
modification, voir aussi [CONTRIBUTING.md](../CONTRIBUTING.md).

## Lancer la démo

```bash
npm install
npm run demo
```

Puis ouvrir http://localhost:4321 (en vue téléphone dans les outils du navigateur).

Tests : `npm test` lance toutes les suites de `tests/` (une dizaine de secondes, chacune avec son
propre serveur) ; `node scripts/tests.mjs audit` n'en lance qu'une. Sans la carte de France, les
contrôles des tuiles sautent. Les mêmes vérifications tournent à chaque envoi (`.github/workflows`).
La démo pose de faux signalements autour de la place de la République, simule ta
position et en ajoute un toutes les 30 s. Code medic de démo : `medic-demo`.

En vrai, partout en France : télécharger la carte une fois (3,8 Go, quelques minutes),
puis démarrer sans démo. Le téléphone utilise alors son vrai GPS et la carte s'ouvre
là où il est. Personne n'a rien à préparer avant une manif.

```bash
npm run carte
npm start
```

Hors démo, Vigie refuse de démarrer sans code medic : la variable `MEDIC_CODE`, au moins 16
caractères tirés au hasard (`openssl rand -hex 12` en donne 24). En démo, le code est toujours `medic-demo`.

Montrer la démo à quelqu'un, le temps d'une session, sans serveur : un tunnel gratuit
localhost.run (adresse HTTPS au hasard, sans compte, rien à installer). Dans un premier
terminal :

```bash
node server.js --demo --host=127.0.0.1
```

Dans un second terminal, puis donner l'adresse `https://….lhr.life` qu'il affiche :

```bash
ssh -R 80:localhost:4321 nokey@localhost.run
```

Fermer le second terminal coupe l'accès. Les tunnels rapides de Cloudflare ne
conviennent pas : ils ne laissent pas passer le flux temps réel.

## Tester sur un vrai téléphone

Une PWA a besoin d'un contexte sécurisé (HTTPS, ou `localhost`) pour la caméra
(scan QR), le chiffrement du binôme, la localisation et le hors ligne. En http sur
le réseau local, la carte et les signalements marchent, mais pas le reste.

Le serveur démarre en HTTPS s'il trouve `cert/vigie.crt` et `cert/vigie.key` (ou les
variables `CERT`/`KEY`), sinon en http. Générer un certificat auto-signé couvrant
`localhost` et l'IP du PC sur le réseau local :

```bash
mkdir -p cert
openssl req -x509 -newkey rsa:2048 -nodes -days 825 \
  -keyout cert/vigie.key -out cert/vigie.crt \
  -subj "/CN=Vigie local" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1,IP:<IP-DU-PC>"
```

Puis `node server.js` démarre sur `https://`. Sur le téléphone (même Wi-Fi), ouvrir
`https://<IP-DU-PC>:4321` et accepter l'avertissement une fois (certificat
auto-signé) : l'origine devient sécurisée et tout fonctionne. Le PC en
`https://localhost:4321` demande le même clic.

Si l'IP du PC change, régénérer le certificat. Pour revenir en http simple, retirer
le dossier `cert/`. Ne jamais partager `cert/vigie.key` (clé privée). Un tunnel
HTTPS vers le port, ou un certificat de confiance (mkcert) pour supprimer
l'avertissement, restent des alternatives.

## Fichiers

- `server.js` : API, flux temps réel par secteurs (SSE), carte (archive PMTiles lue par morceaux, ou proxy), relais des marques de cellule et des codes courts, relais binôme, démo
- `pmtiles.mjs` : codec PMTiles v3 (lecteur par morceaux + écrivain)
- `scripts/carte.mjs` : télécharge la carte de France (`npm run carte`)
- `scripts/vendor.js` : copie Leaflet, protomaps-leaflet et la police, génère les styles jour et nuit de la carte
- `scripts/build-pmtiles.mjs` : empaquette un dossier de tuiles existant en archive `.pmtiles`
- `config.js` : zones couvertes (France), secteurs, durées, seuils, plafonds, chemin de la carte
- `public/index.html`, `public/app.css`, `public/js/app.js` : l'appli
- `public/js/icons.js` : pictogrammes et types de signalements
- `public/js/qr.js` : générateur de QR maison (cellule, binôme, adresse de Vigie)
- `public/js/pow.js` : SHA-256 maison + preuve de travail anti-spam (module et worker)
- `public/sw.js` : hors ligne (coque et tuiles en cache, API jamais en cache)
- `deploiement/envoyer.sh`, `deploiement/installer.sh` : mise en ligne en une commande (envoi par Tor, installation complète sur Debian 13)
- `deploiement/Caddyfile`, `deploiement/caddy-memoire.conf`, `deploiement/vigie.service` : mise en ligne (HTTPS sans journal, mémoire jamais sur disque, service système)
- `scripts/mesure.mjs` : banc de mesure sur un petit téléphone simulé (Chrome, Chromium ou Edge sans fenêtre)
- `deploiement/maj.sh` : mise à jour du code seulement (`envoyer.sh --maj`)
- `tests/`, `scripts/tests.mjs` : les suites de tests (`npm test`) ; `.github/workflows/tests.yml` : les mêmes à chaque envoi
- `docs/` : conception, mise en ligne, développement
- `kit/` : flyers et autocollant à imprimer (CC0), jamais envoyés au serveur
- `LICENSE` (AGPL 3.0), `SECURITE.md` (signaler une faille, promesses et limites), `CONTRIBUTING.md`, `CHANGELOG.md`
