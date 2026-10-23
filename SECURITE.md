# Sécurité de Vigie

Vigie sert en manifestation : une faille peut mettre des gens en danger. Merci de la
signaler en privé, pas dans un ticket public, pour qu'elle soit corrigée avant d'être
connue de tous.

**Signaler une faille :** `contact@vigiemap.org` (adresse dédiée au projet). Décris ce
que tu as trouvé et comment le reproduire. Tu reçois une réponse,
puis un correctif publié le plus vite possible ; tu seras remercié·e si tu le souhaites.

## Ce que Vigie promet

- La position GPS exacte ne quitte jamais le téléphone. Un signalement ou une demande
  d'aide porte le point visé, arrondi à 50 m sur le téléphone ; par défaut, ce point est
  la position de la personne. L'alarme « interpellé·e » du binôme envoie aussi la position
  arrondie, chiffrée pour le binôme seulement.
- Pas de compte, de numéro ni d'email.
- Le serveur ne tient aucun journal des requêtes et ne garde aucune adresse IP. Tout est en mémoire
  et s'efface : 25 min pour un danger, 45 min pour une demande d'aide, 90 min pour le
  binôme, 12 h pour un code court de cellule, 12 h après la dernière ouverture de Vigie pour
  l'adresse d'alerte d'un medic qui a activé les alertes en poche. (Les adresses IP passent forcément en
  mémoire chez Caddy, le temps de chaque connexion ; elles ne sont ni écrites ni
  transmises à Vigie.)
- Le binôme est chiffré de bout en bout (AES-GCM, clé échangée en personne), et chaque
  message a la même longueur ; les marques de cellule ne sont lisibles que par les membres
  de la cellule.
- Ce qui est diffusé reste grossier : l'heure à la minute, et le nombre de téléphones par
  paliers (1, 2, 3, 5 et plus, 10 et plus). La clé des empreintes de vote n'est jamais
  écrite sur le téléphone.
- Le binôme : le serveur ne lit ni prénoms, ni statuts, ni positions ; il voit seulement
  combien de membres a un groupe et quand chacun donne signe.
- Les codes medic : chaque collectif tire le sien au hasard sur un téléphone (112 bits) et ne
  transmet que son empreinte (SHA-256 tronquée), qui ne permet pas de retrouver le code. Le
  serveur ne garde que ces empreintes, sans nom ni date, et ne note pas quel code a vu ou pris
  quelle demande. Un code se coupe seul, sans toucher aux autres collectifs.
- Le téléphone ne parle qu'au serveur Vigie : aucun service tiers, aucun CDN. Le serveur,
  lui, demande la météo à Open-Meteo pour le centre d'un secteur (environ 50 km), au plus
  toutes les 10 minutes : Open-Meteo voit le serveur, jamais un téléphone. Seule autre sortie,
  pour les medics qui activent les alertes en poche : le serveur envoie une alerte vide (ni lieu,
  ni besoin) au service de notification de leur navigateur, et à aucune autre adresse.

Chacun peut vérifier ce que son téléphone envoie dans Réglages, « Transparence ».

## Ce que Vigie ne protège pas

- La carte est publique : tout le monde peut la lire, police comprise. On n'y met que
  des dangers, jamais des personnes ni des plans d'action.
- L'opérateur téléphonique, et l'hébergeur du serveur, voient qu'un téléphone se connecte
  au serveur Vigie et à quelle heure (pas ce qu'il envoie, c'est chiffré). Sur requête de la
  justice, ils pourraient être obligés de le noter. Un VPN de confiance, activé avant
  d'ouvrir Vigie, le cache à l'opérateur ; Tor le cacherait à tous.
- Le serveur voit où est le téléphone, à peu près : la carte s'ouvre sur sa position, donc les
  morceaux de carte demandés montrent la zone affichée à 1 ou 2 km près, et le flux temps réel suit
  les secteurs d'environ 50 km autour de lui. Il n'en note rien (sa mémoire garde seulement, pour
  aller vite, les grandes régions de carte lues récemment), mais un serveur saisi et trafiqué
  pourrait le noter. Seul Tor cacherait l'adresse IP qui va avec.
- Un signalement est diffusé à l'instant où il arrive. Quelqu'un qui voit le trafic d'un téléphone
  (opérateur, matériel de surveillance sur place) et lit en même temps le flux public peut relier ce
  téléphone à son signalement, malgré l'heure arrondie.
- Un code court de cellule confie la clé de la cellule au serveur pendant 12 h, et toute personne
  qui a ce code peut entrer ; il ne se révoque pas. Le QR et le code long ne passent jamais par le
  serveur.
- Un serveur saisi pourrait aussi envoyer aux téléphones une version modifiée de l'appli. L'écran
  « Transparence » fait partie de l'appli : il montre ce que le téléphone envoie, mais ne peut pas
  détecter une appli trafiquée. D'où l'intérêt du code ouvert et de plusieurs serveurs indépendants.
- Les membres d'un même collectif de medics partagent un code : un serveur saisi et trafiqué
  pourrait regrouper leur activité (« ces téléphones ont le même code »), sans savoir de quel
  collectif il s'agit. Seul l'exploitant sait à quel collectif va une empreinte, par le mail qui
  la lui apporte : il le supprime une fois l'empreinte ajoutée. Changer de code de temps en temps
  empêche de suivre un collectif dans la durée.
- Un faux signalement reste possible, même « signalé par 10 téléphones » : la preuve de
  travail le rend coûteux, pas impossible pour un attaquant équipé. Seul « vu par ta
  cellule » vient de gens connus ; le réglage « Alertes : Fiables » s'y limite.
- Un téléphone saisi déverrouillé révèle ce que Vigie y garde : la cellule et le binôme
  (leurs clés, donc l'accès à leurs marques et messages, et le prénom choisi), le code medic
  s'il a été activé (en clair, sauf avec « Ne pas garder le code sur ce téléphone » : il ne vit
  alors qu'en mémoire, le temps que l'appli est ouverte), la demande d'aide en cours et son type, les signalements
  récents et ceux en attente de réseau, les derniers dangers reçus, et les morceaux de carte du jour et de la veille, voire des jours d'usage
  précédents si Vigie n'a pas été rouverte depuis (ils montrent les zones regardées).
  « Tout effacer » (appui long) vide tout cela sur ce téléphone et retire la demande d'aide
  en cours, mais pas un code court déjà créé ni le dernier message de binôme (ils
  s'effacent seuls), l'historique du navigateur, le presse-papiers (un code copié), les
  captures d'écran, ni ce que gardent les autres membres.
- Vigie ne prévient que si elle est ouverte, écran allumé : écran éteint, aucune alerte ni
  alarme de binôme n'arrive. Seule exception, les alertes en poche des medics (à activer) :
  elles passent par le service de notification du téléphone (Google sur Android, Apple sur
  iPhone), qui voit qu'une alerte de Vigie arrive sur ce téléphone, et quand, jamais où ni
  pourquoi. Sur réquisition, ce service pourrait dire quels téléphones reçoivent des alertes de
  Vigie : un medic qui ne veut pas l'exposer ne les active pas.
- Sur Android, installer Vigie avec Chrome passe par un service de Google, qui apprend que
  ce téléphone l'a installée. Firefox, ou Vigie sans l'installer, l'évitent.

## Dans le périmètre

Le code de ce dépôt : serveur (`server.js`, `pmtiles.mjs`, `config.js`), application
(`public/`), scripts et fichiers de déploiement. Tout se teste en local (`npm run demo`,
`npm test`), jamais sur le serveur en ligne : il sert à des gens en manifestation.
