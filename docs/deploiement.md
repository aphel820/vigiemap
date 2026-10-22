# Mettre Vigie en ligne

Pour monter sa propre instance. Une instance qui modifie le code doit le publier (licence AGPL) et
mettre son adresse dans la variable `SOURCE_URL`, pour que l'écran Transparence y mène.

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
