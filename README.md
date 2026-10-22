# Vigie

Une carte partagée pour se protéger pendant les manifestations : **https://vigiemap.org**

On y signale un danger en deux gestes (charge, nasse, gaz, canon à eau…), on demande un secouriste
sans que personne d'autre ne le voie, et on veille sur ses proches. Sans compte, sans nom, sans
numéro, sans rien à installer depuis un store.

## Ce que fait Vigie

- **Signaler un danger** : tu vises l'endroit sur la carte, le point part arrondi à 50 m. Un danger
  s'efface 25 minutes après sa dernière confirmation. La carte est publique : on n'y met que des
  dangers, jamais des personnes.
- **Demander un secouriste** : seuls les street medics (qui ont reçu un code en personne) voient la
  demande. Le 112 reste à un geste.
- **Binôme** : tes proches voient si tu es interpellé·e ou si tu ne donnes plus signe de vie. Tout
  est chiffré entre vous.
- **Cellule de confiance** : un danger confirmé par quelqu'un que tu as fait entrer toi-même est
  marqué « vu par ta cellule ». Le réglage « Fiables » ne prévient que pour ceux-là.
- **Gazé·e ?** : les gestes à faire, et de quel côté sortir du nuage selon le vent.
- **Sans réseau** : la carte de la zone préparée et les derniers dangers reçus restent affichés ; tes
  signalements partent dès que le réseau revient.

## Ce que Vigie protège, et ce qu'elle ne protège pas

- Pas de compte. Ta position GPS exacte ne quitte jamais ton téléphone.
- Le serveur ne tient aucun journal des requêtes, ne garde aucune adresse IP, garde tout en mémoire
  et efface tout à expiration.
- « Tout effacer » (appui long dans les réglages) vide Vigie de ton téléphone.

Mais :

- Vigie ne prévient que si elle est ouverte, écran allumé : rien ne sonne dans ta poche.
- Ton opérateur mobile voit qu'un téléphone se connecte à Vigie (pas ce qu'il envoie). Un VPN de
  confiance le cache.
- N'importe qui peut poster un faux danger, même en nombre. Seule ta cellule vient de gens que tu
  connais.
- Sans réseau, rien ne passe d'un téléphone à l'autre : une appli web n'a pas accès au Bluetooth.
- Un seul serveur sert tout le monde : s'il tombe ou s'il est saisi, Vigie s'arrête. Le code étant
  ouvert, d'autres peuvent en monter un.

Le détail complet est dans [SECURITE.md](SECURITE.md). Dans l'appli, Réglages > Transparence montre
ce que ton téléphone envoie et ce que le serveur garde.

## S'en servir

1. Ouvre https://vigiemap.org, puis installe-la sur l'écran d'accueil (Réglages > Installer Vigie).
2. Avant la manif, avec du réseau : Réglages > Carte sans réseau > Préparer la zone.
3. Sur place : « Signaler » pour un danger, « Secours » pour un medic, « Binôme » pour tes proches.
   Garde l'écran allumé pour être prévenu·e.
4. Si tu risques d'être interpellé·e : « Tout effacer » (appui long dans les réglages).

**Street medics** : le code se reçoit en personne, jamais en ligne. Puis Réglages > Mode medic.

## Faire connaître Vigie

Flyers et autocollant prêts à imprimer, libres de droits : [kit/](kit/).

## Signaler une faille

En privé, à `contact@vigiemap.org`, jamais dans un ticket public : voir [SECURITE.md](SECURITE.md).

## Développer, monter son instance

Node.js 22 ou plus, et rien d'autre.

```bash
npm install
npm run demo
npm test
```

La démo tourne sur http://localhost:4321, avec de faux dangers. Pour aller plus loin :

- [docs/developpement.md](docs/developpement.md) : démo, essais sur un vrai téléphone, organisation
  des fichiers ;
- [docs/conception.md](docs/conception.md) : comment ça marche, et pourquoi ;
- [docs/deploiement.md](docs/deploiement.md) : mettre sa propre instance en ligne ;
- [CONTRIBUTING.md](CONTRIBUTING.md) : proposer une modification ;
- [CHANGELOG.md](CHANGELOG.md) : ce qui change à chaque version.

## Licence

Copyright (C) 2026 Les contributeurs de Vigie. Code libre sous licence AGPL 3.0 ou plus récente
([LICENSE](LICENSE)) : une version modifiée mise en ligne doit publier son code, et l'écran
Transparence doit y mener (variable `SOURCE_URL`, voir [docs/deploiement.md](docs/deploiement.md)).
Les flyers du dossier [kit/](kit/) sont dans le domaine public (CC0).
