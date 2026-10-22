# Vigie : comment ça marche, et pourquoi

Les choix de conception, pour qui veut comprendre ou vérifier. Les promesses faites au public et leurs
limites sont dans [SECURITE.md](../SECURITE.md) ; ce que le téléphone envoie se lit dans l'appli,
écran Transparence.

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

## Transparence

Personne ne peut prouver à distance ce que fait un serveur. Vigie mise donc sur deux
choses vérifiables : le serveur ne reçoit presque rien (pas de GPS, pas d'identité,
des marques et des messages qu'il ne sait pas lire), et chacun peut voir ce que son
propre téléphone envoie. Réglages, « Transparence » : ce que le serveur garde et
combien de temps, puis le journal des derniers envois du téléphone (les 60 derniers, en
mémoire seulement, effacé à la fermeture ; les morceaux de carte y sont comptés). Les mêmes envois se voient dans les outils de
développement du navigateur.
