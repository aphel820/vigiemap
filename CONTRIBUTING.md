# Contribuer à Vigie

Vigie sert en manifestation : une erreur peut mettre des gens en danger. D'où quelques règles
simples.

- **Une faille de sécurité ne se signale jamais dans un ticket public** : voir `SECURITE.md`.
- **Le plus simple d'abord.** Pas de framework, pas de bundler, pas de dépendance côté serveur.
  Une fonctionnalité qui demande un compte, une identité ou un service tiers n'entrera pas.
- **Rien ne s'écrit sur le serveur** : pas de journal, pas d'adresse IP, tout en mémoire et tout
  expire. Une modification qui garde plus longtemps une information doit le dire, et l'écran
  Transparence comme `SECURITE.md` doivent suivre.
- **Chaque promesse faite à l'écran doit être vraie dans le code.** Si tu changes ce que le
  téléphone envoie ou ce que le serveur garde, mets à jour Transparence, `SECURITE.md` et le
  README dans la même proposition.
- **Batterie et petits téléphones** : rien ne tourne écran éteint, pas de GPS précis sans geste de
  la personne. Mesure avec `node scripts/mesure.mjs` si tu touches au chargement ou au repos.
- **Textes en français clair**, sans jargon, écriture inclusive avec le point médian (« interpellé·e »),
  pas de tiret cadratin.

Pour tester : `npm install`, puis `npm run demo` et ouvre http://localhost:4321 (voir le README
pour un téléphone sur le Wi-Fi). Avant de proposer : `npm test` doit passer, et ajoute un contrôle
dans `tests/` pour ce que tu corriges ou ajoutes côté serveur. Vérifie aussi le parcours concerné
dans le navigateur, sur un petit écran (360x640).
