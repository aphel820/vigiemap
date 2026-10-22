// SPDX-License-Identifier: AGPL-3.0-or-later
// Vigie : configuration du serveur

// Lit un argument de la forme --nom=valeur
const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];

// Entier lu dans l'environnement, borné ; une valeur invalide arrête tout plutôt que de couper
// une protection sans le dire (POW_BITS="" désactivait la preuve de travail)
function intEnv(name, def, min, max) {
    const raw = process.env[name];
    if (raw === undefined) return def;
    const v = raw.trim() === '' ? NaN : Number(raw); // Number('') vaudrait 0 : la protection sautait
    if (!Number.isInteger(v) || v < min || v > max) throw new Error(`${name} doit être un entier entre ${min} et ${max} (reçu « ${raw} »).`);
    return v;
}

export const Config = {
    port: Number(arg('port')) || Number(process.env.PORT) || 4321,
    // Adresse d'écoute : en ligne derrière Caddy, HOST=127.0.0.1 (seul Caddy parle au serveur).
    // Par défaut toutes les adresses, pour tester depuis un téléphone sur le Wi-Fi. Aussi en argument
    // (--host=127.0.0.1), pour une démo derrière un tunnel quel que soit le terminal.
    host: process.env.HOST || arg('host') || null,
    demo: process.env.DEMO === '1' || process.argv.includes('--demo'),

    // HTTPS : chemins du certificat et de la clé. Fournis (variables CERT/KEY) ou présents sous
    // cert/vigie.crt + cert/vigie.key, le serveur démarre en https. C'est requis pour la caméra
    // (scan QR), le binôme (chiffrement) et le hors-ligne depuis un téléphone (le contexte doit être
    // sécurisé). Sinon, http : tout marche sur localhost, mais pas depuis un autre appareil.
    tlsCert: process.env.CERT || null,
    tlsKey: process.env.KEY || null,

    // Zone couverte : la France entière. Chaque cadre vaut [ouest, sud, est, nord] en degrés ; un
    // signalement hors de ces cadres est refusé, et `npm run carte` télécharge la carte des mêmes cadres.
    zones: [
        ['Métropole', [-5.2, 42.3, 8.3, 51.1]],
        ['Corse', [8.5, 41.3, 9.6, 43.05]],
        ['Guadeloupe', [-61.9, 15.8, -61.0, 16.6]],
        ['Martinique', [-61.3, 14.35, -60.8, 14.9]],
        ['Guyane', [-54.7, 2.1, -51.5, 5.9]],
        ['La Réunion', [55.2, -21.4, 55.85, -20.85]],
        ['Mayotte', [44.95, -13.05, 45.35, -12.6]],
    ],
    // Vue de départ tant que le téléphone ne connaît pas sa position : la France entière
    center: [46.6, 2.5],
    zoom: 6,

    // Secteurs : carrés d'environ 50 km (tuiles de zoom 9). Un téléphone ne reçoit que les dangers des
    // secteurs qu'il regarde (au plus maxSectors) : à l'échelle du pays, tout envoyer à tous noierait le réseau.
    sectorZoom: 9,
    maxSectors: 18,

    reportTtlMin: 25,     // un signalement disparaît 25 min après la dernière fois qu'il a été vu
    helpTtlMin: 45,       // une demande d'aide non réglée disparaît au bout de 45 min

    // Binôme : signe de vie manuel et relais de groupe (chiffré de bout en bout, le serveur ne lit rien)
    buddyWindowMin: 30,   // durée d'un « je vais bien » avant d'être considéré en retard
    buddyTtlMin: 90,      // un membre silencieux disparaît du relais au bout de ce délai
    buddyMaxMembers: 16,  // garde-fou anti-spam : membres distincts par groupe
    mergeRadiusM: 60,     // même type, même carré de 50 m ou carré voisin, moins de 5 min : on fusionne (jamais la rue d'à côté)
    mergeWindowMin: 5,
    confirmThreshold: 3,  // téléphones distincts pour passer en « confirmé »
    goneThreshold: 2,     // « ce n'est plus là » (au moins autant que de confirmations) pour afficher « peut-être terminé » ;
                          // un danger n'est jamais effacé par des votes, il expire
    alertRadiusM: 350,    // rayon des alertes de proximité (calculé sur le téléphone)

    // Cellules de confiance : le serveur relaie les marques de cellule de chaque signalement, sans
    // savoir à qui elles sont. Plafond à part, plus haut que celui des votants : de faux votants qui
    // remplissent un signalement n'empêchent pas les vrais membres d'y poser leur marque.
    // 50 cellules distinctes par danger suffisent : au-delà, ce serait un remplissage.
    maxCellTags: 50,

    // Code court de partage d'une cellule : valable 12 h à partir de sa création, jamais prolongé.
    pairTtlMin: 720,
    // Codes courts en cours : ~150 o chacun, 100 000 = ~15 Mo. À 5 000, quelques milliers de demandes
    // bloquaient le partage par code court dans toute la France pendant 12 h.
    maxPairings: 100_000,

    // Adresse publique du code source : la licence AGPL demande de la montrer à qui utilise le service,
    // Transparence en fait un lien. Par défaut, le code de Vigie ; une instance qui le modifie met
    // SOURCE_URL vers son propre code. SOURCE_URL vide : pas de lien.
    sourceUrl: ((u) => (/^https:\/\/[^\s"<>]+$/.test(u) ? u : null))(process.env.SOURCE_URL ?? 'https://github.com/aphel820/vigiemap'),
    // Code des street medics : obligatoire hors démo (variable MEDIC_CODE, au moins 16 caractères tirés au hasard).
    // Pas de limite d'essais : elle permettrait à n'importe qui de bloquer les vrais medics ; c'est la
    // longueur du code qui le rend impossible à deviner.
    medicCode: process.env.MEDIC_CODE || null,

    // Anti-spam sans IP : preuve de travail (hashcash). Le téléphone doit trouver un nonce tel que
    // SHA-256(sujet|fenêtre|nonce) commence par powBits zéros : coûteux à produire, trivial à vérifier.
    // Signalements, votes, codes courts : powBits. Demande d'aide et binôme : powBitsUrgent, bien plus
    // léger (une fraction de seconde sur un vieux téléphone), pour ne jamais retarder une urgence.
    // powWindowMs borne la validité d'un puzzle (la fenêtre précédente est acceptée aussi).
    powBits: intEnv('POW_BITS', 16, 0, 26),
    powBitsUrgent: intEnv('POW_BITS_URGENT', 12, 0, 22),
    powWindowMs: 5 * 60_000,

    // Plafonds mémoire (filet anti-flood, sans IP). Au plafond, on REFUSE les nouveaux : jamais
    // d'éviction, sinon un flood effacerait les vraies données (et les vraies demandes d'aide).
    // Calés sur un petit serveur (1 Go de mémoire, Caddy compris) : Vigie doit tenir dans 450 Mo au
    // pire cas (MemoryMax de deploiement/vigie.service). Un plafond trop haut ne protège de rien :
    // le processus tombe avant de refuser, et une chute efface tout pour toute la France.
    //   signalements : ~19 Ko au pire (30 votants, 30 « plus là », 50 marques) x (5 000 + 10 garantis
    //   par secteur) = ~180 Mo ; flux : ~21 Ko x 3 000 = ~63 Mo ; anti-rejeu : ~140 o x 200 000 = ~28 Mo ;
    //   binôme : ~0,8 Ko x 20 000 = ~16 Mo ; aides : ~0,4 Ko x 50 000 = ~20 Mo ; Node lui-même : ~70 Mo ;
    //   répertoires de la carte (pmtiles.mjs) : ~0,13 Mo x 200 feuilles = ~26 Mo ; codes courts : ~15 Mo.
    //   Total ~415 Mo.
    maxReports: 5000,
    maxReportsPerSector: 500,
    maxVoters: 30,        // votants (et « plus là ») par signalement
    maxHelps: 50000,
    maxHelpsPerSector: 3000,
    // Garanti à chaque secteur même quand le plafond national est atteint : une inondation de faux
    // signalements ou de fausses demandes à Paris ne bloque pas une vraie demande à Marseille
    minPerSector: 10,
    maxBuddyEntries: 20000, // messages dans le relais binôme, tous groupes confondus
    // Téléphones en direct en même temps. Sur 1 Go, Caddy (chiffrement HTTPS, ~130 Ko par flux) en
    // limite le nombre bien avant Vigie : environ 3 000. Sur un serveur plus gros, le monter avec la
    // variable MAX_STREAMS (dans /etc/vigie/vigie.env).
    maxStreams: intEnv('MAX_STREAMS', 3000, 100, 100000),
    maxPowSeen: 200_000,

    // Tuiles servies par notre serveur : le fournisseur de cartes ne voit jamais les téléphones.
    // Auto-hébergement : la carte de France (vectorielle, `npm run carte`) dans tiles.pmtiles à la racine,
    // ou l'archive donnée par la variable PMTILES ; le téléphone la dessine lui-même. Sans archive, repli
    // sur le proxy OpenStreetMap (pratique en dev ; à ne pas garder en vrai, leur politique d'usage
    // interdit le téléchargement massif).
    pmtilesPath: process.env.PMTILES || null,
    mapAttribution: '© contributeurs OpenStreetMap, Protomaps',
    tileUrl: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    windRefreshMin: 10,

    // Démo : faux signalements autour de la place de la République, et position simulée du téléphone
    demoCenter: [48.8675, 2.3637],
    demoPosition: [48.8666, 2.3652],
};
