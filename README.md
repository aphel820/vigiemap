# Vigie (prototype)

Carte partagée pour se protéger pendant les manifestations : on signale un danger
en deux gestes, on demande un medic sans que personne d'autre ne le voie.

Prérequis : Node.js 22 ou plus (24 conseillé), et rien d'autre. Le serveur n'a aucune
dépendance ; l'appli en a quatre (carte, police), copiées à l'installation.

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

## Ce qui guide le design

- **Utilisable en courant, gazé·e, d'une main.** Cibles de 56 px minimum, texte de
  18 px minimum, police Atkinson Hyperlegible (dessinée pour les malvoyants),
  boutons vitaux en bas sous le pouce, zoom par boutons (pincer est impossible
  d'une main).
- **Deux gestes pour signaler.** « Signaler », puis le type. Le point envoyé est le
  viseur, posé d'office sur ta position. Une erreur s'annule pendant 8 s.
- **La couleur ne sert qu'à dire un danger.** Une couleur par type, toujours avec
  son pictogramme. Le reste de l'interface est neutre. Jaune de signalisation
  temporaire pour l'action.
- **Confirmé ou pas, ça se voit.** Plaque pleine = au moins 3 personnes l'ont vu.
  Pointillés et « ? » = une seule source. Les marqueurs pâlissent en vieillissant.
- **Alerte de proximité** à 350 m : distance, direction (boussole si le téléphone en
  a une), fraîcheur, vibration différente selon le danger.
- **Gestes graves = maintenir appuyé** (tout effacer, prévenir son binôme) : un
  appui accidentel en courant ne déclenche rien.
- **Deux affichages** : nuit (bitume) et plein soleil (blanc, traits noirs épais).
- **Écran « Gazé·e »** en noir sur jaune : 4 gestes, et la direction où le vent
  pousse le gaz.

## Ce qui protège les gens

- La position GPS exacte ne quitte jamais le téléphone. On envoie le point visé, arrondi à
  50 m (par défaut la position de la personne, qu'elle déplace pour viser le danger).
- Pas de compte, pas de numéro, pas d'email.
- Les votes sont dédoublonnés par une empreinte qui change à chaque signalement :
  le serveur ne peut pas relier deux signalements au même téléphone. La clé de ces
  empreintes n'est jamais écrite sur le téléphone (elle change à chaque ouverture).
- Ce qui est diffusé reste grossier : l'heure à la minute et le nombre de téléphones par
  paliers (1, 2, 3, 5 et plus, 10 et plus), pour ne pas suivre la foule vote par vote. Un
  signalement part pourtant à l'instant : qui voit le réseau d'un téléphone et lit le flux
  peut relier les deux (voir SECURITE.md).
- Les demandes d'aide ne sortent que vers les medics (code requis).
- Le serveur ne tient aucun journal des requêtes, ne garde aucune IP, garde tout en mémoire et
  efface tout à expiration (25 min pour un danger, 45 min pour une demande).
- Le téléphone ne parle qu'au serveur Vigie : carte et météo passent par lui, aucun
  CDN.
- **Secteurs** : le téléphone ne reçoit que les dangers de la région qu'il regarde
  (carrés d'environ 50 km autour de sa position et de la carte affichée). Le serveur
  apprend donc cette région, ce que les morceaux de carte demandés lui disent déjà,
  mais jamais la position GPS. La météo est prise au centre du secteur, auprès
  d'Open-Meteo (données sous licence CC BY 4.0, créditées dans l'écran « Gazé·e »).
- « Tout effacer » vide ce que Vigie garde sur le téléphone : cellule, binôme, code
  medic, signalements, carte en cache. Pas l'historique du navigateur, le presse-papiers
  ni les captures d'écran.

## Cellules de confiance

Un faux compte est gratuit : un seul téléphone peut s'inventer autant d'identités qu'il
veut et faire passer un faux danger pour « confirmé ». Sans personne qui fasse foi,
aucun badge « vérifié » commun à tout le monde ne résiste à ça : n'importe qui pourrait
fabriquer de fausses cellules. La confiance se calcule donc **sur chaque téléphone**,
à partir des gens qu'on a rencontrés. Pas d'admin, pas d'organisateur, pas de code :
tout le monde est au même niveau, et n'importe qui peut faire tourner son serveur.

- **Une cellule, c'est ton groupe de gens de confiance.** N'importe qui en crée une en
  un geste (« Créer ma cellule ») : une clé tirée au hasard sur le téléphone. On la
  fait grandir en la faisant scanner (QR ou code) par des gens qu'on connaît, qui
  peuvent à leur tour la faire scanner. Ça marche sans réseau.
- **« Vu par ta cellule ».** Quand un membre confirme ou signale un danger, son
  téléphone joint une marque : HMAC(clé de la cellule, id du signalement). Seuls les
  membres savent la reconnaître : chez eux, le danger porte un bouclier « vu par ta
  cellule ». Les autres ne voient qu'une suite de caractères.
- **Un faux compte n'y entre pas** sans qu'un membre lui fasse scanner la cellule.
  Ce qu'il fabrique ailleurs (cent fausses cellules) ne s'affiche chez personne. La
  limite : une cellule vaut la confiance de chacun de ses membres, d'où la consigne de
  ne la faire scanner qu'à des gens qu'on connaît.

Côté vie privée, **le serveur ne connaît pas les cellules** (sauf code court, voir plus haut). Il
relaie les marques sans pouvoir les lire. Une marque change d'un signalement à
l'autre, donc rien ne relie deux confirmations de la même cellule. Elle est aussi liée
à son signalement : recopiée sur un autre, elle ne correspond plus à rien.

Trois façons de rejoindre une cellule : scanner le QR (hors ligne), taper le code
complet (24 caractères, hors ligne ; le dernier dit si c'est une cellule ou un binôme,
pour qu'on ne confonde jamais les deux), ou taper un **code court** (8 caractères,
réutilisable et valable environ 12 h). Le code court est la seule exception : le
téléphone confie la cellule au serveur pendant ce temps. Le serveur pourrait donc
reconnaître ses marques tant que le code vit. Le binôme, lui, n'a pas de code court,
pour garder son chiffrement de bout en bout.

Scanner un QR demande la caméra (le flux ne quitte jamais le téléphone) et un contexte
sécurisé (HTTPS, ou `localhost`). Le QR est généré sur le téléphone, sans bibliothèque
tierce (`public/js/qr.js`).

## Binôme

Prévenir ses proches si on est interpellé·e, ou si on ne donne plus signe de vie. Le
serveur ne lit rien ; il voit seulement combien de membres a un groupe et quand chacun
donne signe. Les proches le voient quand ils ouvrent Vigie : écran éteint, rien n'arrive.

- On forme un **binôme** (quelques personnes) en s'échangeant un QR ou un code en
  personne, une fois. Tout le monde partage une clé de groupe, et chacun choisit un
  prénom (local) vu par les autres.
- **Signe de vie manuel** : « Je vais bien » dit à ton binôme que tu vas bien pour
  les 30 prochaines minutes ; passé ce délai sans nouveau signe, les autres te
  voient « en silence ». C'est volontairement manuel : rien ne tourne en fond, donc
  rien ne part quand l'appli est fermée. Une alerte automatique depuis la poche
  imposerait des notifications push (serveurs Google ou Apple), le même choix de
  confidentialité que pour les signalements.
- **Alarme interpellation** : « Je suis interpellé·e » (maintenir 2 s) pousse tout
  de suite l'alerte et ta dernière position connue à ton binôme. Chacun voit une
  bannière rouge, et un marqueur rouge au prénom de la personne apparaît sur la carte
  à l'endroit partagé.
- **Chiffré de bout en bout** : prénoms, statuts et position sont chiffrés avec la
  clé de groupe (AES-GCM). Le serveur n'est qu'une boîte aux lettres : il relaie des
  blobs qu'il ne peut pas lire, sous des identifiants de membre aléatoires, et tout
  expire. Un message qui ne déchiffre pas (spam) est ignoré.

## Batterie et petits téléphones

Ce qui coûte le plus, dans l'ordre : le GPS, la radio (chaque échange réseau la
réveille plusieurs secondes), l'écran, le processeur. D'où :

- **GPS économe par défaut** (position Wi-Fi et antennes, quelques dizaines de mètres
  en ville). Le GPS précis ne s'allume qu'une minute, quand on vise ou qu'on se
  recentre.
- **Écran éteint ou appli en arrière-plan : tout s'arrête** (flux temps réel, GPS,
  boussole, minuteries). Au retour, la carte se remet à jour d'un coup.
  Conséquence assumée : pas d'alerte téléphone dans la poche. Il faudrait des
  notifications push, qui passent par les serveurs de Google ou d'Apple : c'est un
  choix de confidentialité à trancher avant de l'ajouter.
- **Boussole allumée seulement** quand une flèche est à l'écran (alerte, écran gaz).
- **Moins de réveils radio** : battement du serveur toutes les 50 s (et aucun si un
  signalement vient de passer), suivi d'une demande d'aide toutes les 15 s,
  reconnexion de plus en plus espacée (3 s, 6 s… 1 min) quand le réseau tombe.
- **Fichiers compressés** (brotli) et jamais retéléchargés s'ils n'ont pas changé.
  Après la première visite, l'appli s'ouvre depuis le téléphone, sans réseau.
- **Carte allégée** : pas de fondu des tuiles, chargement quand la carte s'arrête,
  marqueurs redessinés seulement quand ils changent.
- **Affichage Nuit** : économise l'écran sur les téléphones à écran OLED.

Mesure : `node scripts/mesure.mjs http://localhost:4321/` (navigateur Chromium sans fenêtre,
écran 360x640, processeur 4 fois plus lent, 4G dégradée).

Mesuré avant et après ces réglages :

| | Avant | Après |
|---|---|---|
| Premier lancement : carte affichée | 3,8 s | 2,7 s |
| Premier lancement : données reçues | 664 Ko | 486 Ko (dont ~390 Ko de tuiles) |
| Fichiers de l'appli transférés | 290 Ko | 97 Ko |
| Lancements suivants : carte affichée | 0,47 s | 0,28 s |
| Écran allumé, au repos : réveils radio par minute | 5 | 2 (les signalements reçus) |
| Avec une demande d'aide en attente | 10 | 5 |
| Écran éteint : réveils radio par minute | 5 | 0 |
| Écran éteint : processeur par minute | 206 ms | 45 ms (le navigateur seul) |

Limites de la mesure : c'est une émulation sur ordinateur, pas un vrai téléphone ; le GPS
et la boussole n'y existent pas, leur gain n'est donc pas chiffré. Le reste du
poids au premier lancement, ce sont les tuiles de carte : « Préparer la zone » avant
la manif évite de les télécharger sur place.

Remesuré avec la carte de France dessinée par le téléphone (même
banc) : carte affichée en 4,9 s au premier lancement (673 Ko reçus) et 1,2 s aux
suivants, contre 2,7 s et 0,28 s avec des images toutes faites. C'est le prix du
dessin par le téléphone ; au repos, rien ne change (44 ms de calcul par minute écran
allumé, 31 ms et aucun réveil radio écran éteint).

## Carte de France

Une seule adresse pour tout le pays : la carte couvre la France entière (métropole,
Corse, Guadeloupe, Martinique, Guyane, La Réunion, Mayotte), et le serveur accepte les
signalements dans ces mêmes zones (`zones` dans `config.js`). Rien à fabriquer en
amont, ville par ville : le téléphone dessine la carte lui-même, à partir des données
OpenStreetMap que lui envoie le serveur.

```bash
npm run carte            # télécharge la carte de France dans tiles.pmtiles
npm run carte -- --taille  # mesure seulement ce qu'il faudrait télécharger
```

Le script `scripts/carte.mjs` prend la construction quotidienne de Protomaps (un
extrait d'OpenStreetMap, faite pour ça) et n'en garde que les zones, avec l'outil
officiel `pmtiles` (téléchargé une fois dans `cache/outils`, empreinte vérifiée). Le
serveur sert la carte au démarrage suivant, en la lisant par morceaux : le fichier ne
tient pas en mémoire et n'a pas besoin d'y tenir. À refaire seulement pour rafraîchir
les données (une fois par mois suffit largement) ; l'ancienne carte est gardée en
`tiles.pmtiles.bak`.

- **Poids** : 3,8 Go sur le serveur (environ 411 000 tuiles). Les
  données s'arrêtent au zoom 14 et le téléphone agrandit lui-même au-delà : comparé à
  l'écran au zoom maximal, mêmes rues et mêmes noms qu'avec le zoom 15, qui pèse 8 Go
  (`npm run carte -- --zoom=15` pour le prendre quand même). Le téléphone ne reçoit que
  les morceaux qu'il affiche.
- **Dessin** : `protomaps-leaflet`, branché dans Leaflet (les marqueurs ne changent
  pas), sans WebGL ni police à télécharger. Noms en français, sans icônes de
  commerces : sur la carte, seuls les dangers doivent attirer l'œil.
- **Jour et nuit** : deux vrais styles (pas un filtre), avec des noms de rue bien plus
  contrastés que ceux de Protomaps (environ 7:1), générés à l'installation par
  `scripts/vendor.js`.
- **Zooms** : les données vont jusqu'au zoom 14 (15 avec `--zoom=15`) ; au-delà, le téléphone agrandit.
- **Pas de vieilles tuiles** : l'adresse des tuiles porte une version qui change avec
  la carte ; navigateur et hors-ligne prennent la nouvelle tout seuls.
- **Mention** : « © contributeurs OpenStreetMap, Protomaps » en bas de la carte
  (obligatoire, licence ODbL).

Sans `tiles.pmtiles`, le serveur retombe sur le proxy OpenStreetMap (images), pratique
en dev mais à ne pas garder en vrai : leur politique interdit le téléchargement
massif. `scripts/build-pmtiles.mjs` empaquette encore un dossier de tuiles images
existant, si besoin.

## Anti-spam sans IP

Le serveur ne garde aucune IP, donc pas de limite par adresse. Pour qu'un flood
coûte quelque chose, poster un signalement ou une confirmation demande une petite
preuve de travail : le téléphone doit trouver un nombre tel que
`SHA-256(contenu | fenêtre | nombre)` commence par assez de zéros. Coûteux à produire
(des dizaines de milliers de hachages), vérifié par le serveur en un seul hachage. La
preuve est liée au contenu, donc chaque signalement distinct demande son propre
calcul ; elle ne sert qu'une fois (anti-rejeu) et n'est valable que quelques minutes.

Le calcul tourne dans un worker, sans geler l'écran. Demander un medic et le binôme
n'ont qu'une preuve bien plus légère (`POW_BITS_URGENT`, 12 par défaut : un dixième
de seconde), pour ne jamais retarder une urgence. La difficulté normale se règle avec
`POW_BITS` (16 par défaut). Des plafonds mémoire bornent le nombre de signalements,
demandes d'aide, binômes et connexions, par secteur et pour tout le pays ; au plafond,
le serveur refuse les nouveaux plutôt que d'effacer les anciens, pour qu'un flood ne
puisse jamais faire disparaître les vraies données.

C'est un plancher, pas un mur : un attaquant équipé peut toujours calculer, mais le
spam trivial devient coûteux, sans IP ni identité.

**Contre l'intox** (un faux danger pour pousser la foule vers une nasse, ou une vraie
nasse qu'on fait disparaître) :
- « ce n'est plus là » n'efface jamais un danger : il l'estompe et affiche « peut-être
  terminé » (avec au moins autant de votes que de confirmations). Seule l'expiration
  le retire ; de faux votes ne font donc pas disparaître une vraie nasse ;
- le réglage « Alertes : Fiables » ne fait vibrer le téléphone que pour un danger vu
  par ta cellule. Le nombre de téléphones ne compte pas : un attaquant équipé en
  fabrique autant qu'il veut. Tout reste visible sur la carte, qui dit honnêtement
  « signalé par N téléphones » plutôt que « confirmé ».

## Mettre en ligne (accessible à tout le monde)

Une seule adresse en HTTPS, pour toute la France. Ce qu'il faut : un petit serveur
Linux loué (1 à 2 processeurs, 1 à 4 Go de mémoire, 15 Go de disque au moins, dont 3,8 Go pour la carte),
un nom de domaine, et une heure. Les fichiers prêts à l'emploi sont dans `deploiement/`.

**En une commande, sur un serveur Debian 13 neuf** (clé SSH déjà donnée à l'hébergeur, domaine
qui pointe vers le serveur) : depuis un terminal bash (Linux, macOS, ou Git Bash sous Windows),
Tor Browser ouvert, dans le dossier de Vigie :

```bash
bash deploiement/envoyer.sh ADRESSE_IP_DU_SERVEUR mon-domaine.org
```

Le dernier commit part par Tor (jamais le dossier de travail : une modification non commitée
est refusée), puis `deploiement/installer.sh` fait sur le serveur toutes les étapes
ci-dessous : mises à jour, pare-feu (SSH, HTTP, HTTPS seulement), journaux du système en mémoire,
SSH par clé seulement, mises à jour de sécurité automatiques, Node.js 24, Caddy, Vigie, carte,
code medic (créé sans être affiché), service, HTTPS. Relancer la même commande met Vigie à jour
(la carte et le code medic sont gardés).

À la toute première connexion, ssh affiche l'empreinte de la clé du serveur et la retient : par Tor,
elle pourrait venir d'un relais malveillant. Compare-la une fois à celle que donne la console de
l'hébergeur (`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`) ; ensuite ssh refuse toute autre clé.

Pour une simple mise à jour du code, sans toucher au système ni à la carte (20 secondes environ) :

```bash
bash deploiement/envoyer.sh --maj ADRESSE_IP_DU_SERVEUR
```

Elle affiche combien de connexions sont ouvertes et demande confirmation avant de redémarrer :
Vigie garde tout en mémoire, donc un redémarrage efface les dangers et les demandes d'aide en
cours. À éviter pendant une manifestation. L'historique Git n'est jamais envoyé au serveur. Essayé sur
un Debian 13 neuf (conteneur) : installation complète, puis page, API et flux temps réel derrière
Caddy, sans aucun journal.

Le détail, pour le faire à la main :

1. **Le serveur.** Debian ou Ubuntu, chez un hébergeur choisi avec soin : il saura qui
   loue la machine et recevra les éventuelles demandes de la police. Un hébergeur
   associatif ou hors de France, qui ne garde pas de journaux, réagit moins vite à
   une demande de coupure.
2. **Le nom de domaine.** Faire pointer `vigie.exemple.fr` (enregistrements A et AAAA)
   vers l'adresse du serveur.
3. **Installer Node.js 22 ou plus, et Caddy** (le serveur web qui fournit le HTTPS).
4. **Installer Vigie** dans `/opt/vigie`, sous un utilisateur dédié, puis télécharger
   la carte :
   ```bash
   sudo useradd --system --home /opt/vigie vigie
   sudo chown -R vigie: /opt/vigie
   cd /opt/vigie && sudo -u vigie npm ci --omit=dev && sudo -u vigie npm run carte
   ```
   `npm ci` installe exactement les versions de `package-lock.json`, empreintes vérifiées.
5. **Le service.** Créer le code medic dans un fichier lisible par root seulement (il
   ne s'affiche pas à l'écran), copier `deploiement/vigie.service` dans
   `/etc/systemd/system/`, puis démarrer :
   ```bash
   sudo install -d -m 700 /etc/vigie
   sudo sh -c 'umask 077; echo "MEDIC_CODE=$(openssl rand -hex 12)" > /etc/vigie/vigie.env'
   sudo systemctl daemon-reload && sudo systemctl enable --now vigie
   ```
   Pour le transmettre aux équipes medic, de vive voix ou par messagerie chiffrée :
   `sudo cat /etc/vigie/vigie.env`.
   Le serveur n'écoute que la machine elle-même (`HOST=127.0.0.1`), ne garde rien sur
   disque (ni swap, ni image mémoire) et n'a que les droits nécessaires.
6. **Le HTTPS.** Mettre le domaine dans `deploiement/Caddyfile`, le copier dans
   `/etc/caddy/Caddyfile`, et `deploiement/caddy-memoire.conf` dans
   `/etc/systemd/system/caddy.service.d/vigie.conf`, puis :
   ```bash
   sudo caddy validate --config /etc/caddy/Caddyfile
   sudo systemctl daemon-reload && sudo systemctl restart caddy
   ```
   Le certificat arrive tout seul. Le Caddyfile coupe tous les journaux de Caddy, même
   d'erreur (sinon chaque erreur noterait l'adresse IP), et impose le HTTPS (HSTS) ; le
   second fichier empêche la mémoire de Caddy de finir sur le disque.
7. **Le pare-feu.** N'ouvrir que les ports 80 et 443 (et SSH pour soi).
8. **Diffuser.** Partager l'adresse, par lien ou par QR code. Sur le téléphone, « Ajouter
   à l'écran d'accueil » l'installe comme une appli, sans passer par un store.
9. **Entretenir.** Une fois par mois : `sudo -u vigie npm run carte`, puis
   `sudo systemctl restart vigie`. Pour mettre à jour Vigie : recopier les fichiers,
   `sudo -u vigie npm ci --omit=dev`, redémarrer. Le serveur calcule tout seul la
   version du cache hors ligne (une empreinte de `public/`), et le téléphone reçoit la
   nouvelle version à l'ouverture suivante.

   **Retour arrière** : chaque mise à jour garde la version précédente (sans la carte ni
   les modules) dans `/root/vigie-precedent.tgz`. Pour y revenir :
   ```bash
   tar -xzf /root/vigie-precedent.tgz -C /opt && chown -R vigie:vigie /opt/vigie && systemctl restart vigie
   ```
   (Si `package-lock.json` avait changé entre les deux versions, lancer aussi
   `cd /opt/vigie && runuser -u vigie -- env HOME=/opt/vigie npm ci --omit=dev`.)

   **Savoir que le site est tombé** : rien sur le serveur ne peut prévenir s'il est
   lui-même coupé. Le plus simple : un service gratuit de surveillance externe (par
   exemple UptimeRobot ou Healthchecks.io), ouvert avec la boîte mail du projet, qui
   appelle `https://ton-domaine/api/config` toutes les 5 minutes et envoie un mail s'il
   ne répond plus. Il ne voit que l'adresse publique du site.

   Node et Caddy se mettent à jour tout seuls (sécurité). Une nouvelle version de Node
   ne s'applique qu'au prochain redémarrage de Vigie, c'est-à-dire à la prochaine mise à
   jour avec `envoyer.sh`.

Mesuré sur un ordinateur : 10 000 téléphones connectés en même temps
tiennent sur un seul processus (280 Mo de mémoire), chaque danger arrive sur les
téléphones en moins de 50 ms, et la carte part à 4 600 morceaux par seconde. Mais sur
un serveur de 1 Go, c'est Caddy (le chiffrement HTTPS) qui limite : Vigie accepte au plus
3 000 téléphones en direct en même temps, et refuse les suivants plutôt que de tomber. Sur
un serveur plus gros, monter la limite avec `MAX_STREAMS=…` dans `/etc/vigie/vigie.env`.
Les plafonds de `config.js` sont calculés pour que Vigie tienne dans 450 Mo au pire cas. Publier le
code (Codeberg, GitHub) permet à d'autres collectifs d'ouvrir un serveur de secours
avec la même procédure.

## Pas encore fait (et nécessaire avant un vrai usage)

1. **Tester l'iPhone** : pas de scan de QR dans une PWA, tout y passe par le code tapé.
2. **Signe de vie en arrière-plan** pour le binôme : aujourd'hui « Je vais bien »
   est manuel et rien ne part quand l'appli est fermée. Le faire en fond imposerait
   des notifications push (serveurs Google ou Apple), à trancher. À cadrer aussi :
   révoquer un membre d'un binôme dont la clé a fuité.
3. **Relais sans réseau** (Bluetooth ou Meshtastic) : demande une appli native,
   iOS n'ouvre pas le Bluetooth aux PWA.
4. **Anti-spam plus fort** : la preuve de travail (en place, voir plus haut) est un
   plancher, qu'un attaquant équipé franchit. Sans autorité centrale, il n'y a pas de
   mur possible ; c'est pour ça que la confiance se lit dans sa propre cellule.
5. **Héberger le serveur national** : un seul serveur pour tout le pays devient une
   cible (saturation, demande de saisie). À choisir avec soin, avec un accès Tor
   (adresse .onion) ; publier le code permet à d'autres d'en monter un en secours.

## Transparence

Personne ne peut prouver à distance ce que fait un serveur. Vigie mise donc sur deux
choses vérifiables : le serveur ne reçoit presque rien (pas de GPS, pas d'identité,
des marques et des messages qu'il ne sait pas lire), et chacun peut voir ce que son
propre téléphone envoie. Réglages, « Transparence » : ce que le serveur garde et
combien de temps, puis le journal en direct de chaque envoi du téléphone (en mémoire
seulement, effacé à la fermeture). Les mêmes envois se voient dans les outils de
développement du navigateur.

## Licence et sécurité

Copyright (C) 2026 Les contributeurs de Vigie. Code libre sous licence AGPL 3.0 ou plus
récente (`LICENSE`) : toute personne qui fait tourner une version modifiée de Vigie doit en
publier le code. L'écran Transparence fait un lien vers le code : par défaut celui de
https://github.com/aphel820/vigiemap ; une instance qui le modifie met sa propre adresse dans la
variable `SOURCE_URL` (dans `/etc/vigie/vigie.env`).

Une faille se signale en privé, voir `SECURITE.md`. Pour proposer une amélioration, voir
`CONTRIBUTING.md` ; les changements de chaque version sont dans `CHANGELOG.md`.

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
- `LICENSE` (AGPL 3.0), `SECURITE.md` (signaler une faille, promesses et limites)
