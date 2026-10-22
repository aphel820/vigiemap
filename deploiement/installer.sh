#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Vigie : installation complète sur un serveur Debian 13 neuf, en root.
#   bash installer.sh vigiemap.org [/root/vigie.tgz]
# Dans l'ordre : mises à jour, pare-feu, journaux en mémoire, SSH par clé seulement, Node.js 24,
# Caddy, Vigie dans /opt/vigie, carte de France (3,8 Go), code medic, service système, HTTPS.
# Relançable sans risque pour mettre à jour le code : la carte et le code medic déjà en place sont gardés.
set -euo pipefail

DOMAINE="${1:-}"
ARCHIVE="${2:-/root/vigie.tgz}"
[ "$(id -u)" = 0 ] || { echo "À lancer en root."; exit 1; }
[[ "$DOMAINE" =~ ^[a-z0-9.-]+\.[a-z]{2,}$ ]] || { echo "Usage : bash installer.sh vigiemap.org [archive]"; exit 1; }
[ -f "$ARCHIVE" ] || { echo "Archive introuvable : $ARCHIVE"; exit 1; }
. /etc/os-release
# Prévu et essayé pour Debian 13 seulement : ailleurs, refus sauf FORCER=1 (à tes risques)
if [ "$ID" != debian ] || [ "${VERSION_ID:-}" != 13 ]; then
    [ "${FORCER:-0}" = 1 ] || { echo "Prévu pour Debian 13, trouvé $PRETTY_NAME. Relance avec FORCER=1 pour passer outre."; exit 1; }
    echo "Attention : prévu pour Debian 13, trouvé $PRETTY_NAME (FORCER=1)."
fi
# Le vrai port SSH, pour ne jamais s'enfermer dehors avec le pare-feu
SSH_PORTS="$(sshd -T 2>/dev/null | awk '/^port /{printf "%s%s", sep, $2; sep=", "}')"
SSH_PORTS="${SSH_PORTS:-22}"

# Un seul accord, en clair, avant de toucher à la machine (sauf sans terminal : installation automatisée)
if [ -t 0 ]; then
    echo "Ce script va, sur cette machine :"
    echo "  - mettre à jour tout le système ;"
    echo "  - REMPLACER le pare-feu : seuls SSH (port $SSH_PORTS), HTTP et HTTPS resteront ouverts ;"
    echo "  - garder les journaux système en mémoire seulement (retire rsyslog et les journaux sur disque) ;"
    echo "  - interdire la connexion SSH par mot de passe (si root a une clé SSH) ;"
    echo "  - installer Node.js et Caddy, puis installer ou mettre à jour Vigie (carte et code medic gardés)."
    echo "Prévu pour un serveur dédié à Vigie."
    read -r -p "Continuer ? (o/N) " REPONSE
    [ "$REPONSE" = o ] || [ "$REPONSE" = O ] || { echo "Rien n'a été modifié."; exit 1; }
fi

etape() { echo; echo "==> $*"; }
export DEBIAN_FRONTEND=noninteractive
# Garder les fichiers de configuration existants sans poser de question
APT=(apt-get -y -q -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold)

etape "Mises à jour du système"
apt-get update -q
"${APT[@]}" full-upgrade
"${APT[@]}" install ca-certificates curl gnupg nftables unattended-upgrades tar

etape "Pare-feu : seulement SSH (port $SSH_PORTS), HTTP et HTTPS en entrée"
cat > /etc/nftables.conf <<EOF
#!/usr/sbin/nft -f
flush ruleset
table inet filtre {
    chain entree {
        type filter hook input priority 0; policy drop;
        iif lo accept
        ct state established,related accept
        ct state invalid drop
        meta l4proto { icmp, ipv6-icmp } accept
        udp sport 67 udp dport 68 accept
        udp dport 546 accept
        tcp dport { $SSH_PORTS, 80, 443 } accept
        udp dport 443 accept
    }
    chain transit {
        type filter hook forward priority 0; policy drop;
    }
}
EOF
nft -c -f /etc/nftables.conf
systemctl enable nftables
systemctl restart nftables

etape "Pare-feu : place pour 10 000 connexions suivies"
# Sous 1 Go de mémoire, le noyau limite sa table de connexions à ~7 400 entrées : chaque téléphone en
# direct en prend deux (vers Caddy, puis de Caddy vers Vigie), donc les nouveaux arrivants étaient refusés
# vers 3 700 téléphones, sans trace. Module chargé au démarrage, sinon le réglage ne s'applique pas.
echo nf_conntrack > /etc/modules-load.d/vigie.conf
modprobe nf_conntrack 2>/dev/null || true # déjà chargé par les règles ct du pare-feu, en principe
printf 'net.netfilter.nf_conntrack_max = 65536\n' > /etc/sysctl.d/90-vigie.conf
sysctl -q -p /etc/sysctl.d/90-vigie.conf 2>/dev/null \
    || echo "Attention : table de connexions non agrandie (noyau sans conntrack ?). Limite vers 3 700 téléphones."

etape "Journaux système en mémoire seulement : rien n'est écrit sur le disque"
mkdir -p /etc/systemd/journald.conf.d
printf '[Journal]\nStorage=volatile\nRuntimeMaxUse=50M\n' > /etc/systemd/journald.conf.d/vigie.conf
if dpkg -s rsyslog >/dev/null 2>&1; then "${APT[@]}" purge rsyslog; fi
rm -rf /var/log/journal
systemctl restart systemd-journald

etape "Connexion SSH par clé seulement"
if [ -s /root/.ssh/authorized_keys ]; then
    mkdir -p /etc/ssh/sshd_config.d
    # « 00- » : sshd garde la PREMIÈRE valeur lue, et lit ces fichiers par ordre alphabétique. Nommé
    # « vigie.conf », le nôtre passait après celui de l'hébergeur (50-cloud-init.conf…), qui pouvait
    # remettre les mots de passe.
    rm -f /etc/ssh/sshd_config.d/vigie.conf
    printf 'PasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin prohibit-password\n' > /etc/ssh/sshd_config.d/00-vigie.conf
    sshd -t
    systemctl reload ssh
else
    echo "Aucune clé SSH pour root : mots de passe laissés actifs. Ajoute ta clé, puis relance ce script."
fi

etape "Mises à jour de sécurité automatiques"
printf 'APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";\n' > /etc/apt/apt.conf.d/20auto-upgrades
# Par défaut, seuls les paquets Debian se mettent à jour : Node et Caddy, les deux logiciels exposés à
# Internet, viennent d'autres dépôts. On les ajoute, en gardant toujours notre configuration (Caddyfile).
# Node mis à jour ne s'applique qu'au prochain redémarrage de Vigie (une mise à jour avec envoyer.sh).
printf 'Unattended-Upgrade::Origins-Pattern:: "site=deb.nodesource.com";\nUnattended-Upgrade::Origins-Pattern:: "site=dl.cloudsmith.io";\nDpkg::Options:: "--force-confold";\n' > /etc/apt/apt.conf.d/51vigie

# Clés des dépôts de Node et de Caddy épinglées : une clé remplacée en route, ou chez l'hébergeur du
# dépôt, est refusée avant toute installation. Empreintes relevées sur les clés publiées.
verifier_cle() { # fichier, empreinte attendue
    local fpr
    fpr="$(gpg --show-keys --with-colons "$1" 2>/dev/null | awk -F: '/^fpr:/ { print $10; exit }')"
    [ "$fpr" = "$2" ] || { echo "Clé inattendue ($1) : $fpr au lieu de $2. Rien n'est installé."; exit 1; }
}

etape "Node.js 24"
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
    install -d -m 755 /etc/apt/keyrings
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key -o /tmp/nodesource.key
    verifier_cle /tmp/nodesource.key 6F71F525282841EEDAF851B42F59B5F99B1BE0B4
    gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg < /tmp/nodesource.key
    rm -f /tmp/nodesource.key
    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_24.x nodistro main" > /etc/apt/sources.list.d/nodesource.list
    apt-get update -q
    "${APT[@]}" install nodejs
fi
echo "Node $(node --version)"

etape "Caddy (HTTPS automatique)"
if ! command -v caddy >/dev/null; then
    curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key -o /tmp/caddy.key
    verifier_cle /tmp/caddy.key 65760C51EDEA2017CEA2CA15155B6D79CA56EA34
    gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg < /tmp/caddy.key
    rm -f /tmp/caddy.key
    # La ligne du dépôt est écrite ici, pas téléchargée telle quelle
    echo "deb [signed-by=/usr/share/keyrings/caddy-stable-archive-keyring.gpg] https://dl.cloudsmith.io/public/caddy/stable/deb/debian any-version main" > /etc/apt/sources.list.d/caddy-stable.list
    chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
    apt-get update -q
    "${APT[@]}" install caddy
fi
caddy version

etape "Vigie dans /opt/vigie"
id vigie >/dev/null 2>&1 || useradd --system --home-dir /opt/vigie --shell /usr/sbin/nologin vigie
install -d -o vigie -g vigie -m 755 /opt/vigie
# Version précédente gardée pour un retour arrière (sans la carte ni les modules) :
#   tar -xzf /root/vigie-precedent.tgz -C /opt && chown -R vigie:vigie /opt/vigie && systemctl restart vigie
if [ -f /opt/vigie/server.js ]; then
    tar -czf /root/vigie-precedent.tgz -C /opt --exclude='vigie/tiles.pmtiles*' --exclude=vigie/node_modules --exclude=vigie/cache vigie
fi
tar -xzf "$ARCHIVE" -C /opt/vigie --strip-components=1 --no-same-owner
# Aperçu des liens partagés : l'image et l'adresse de la page sont des adresses complètes, au domaine réel
sed -i "s#https://vigiemap\.org/#https://$DOMAINE/#g" /opt/vigie/public/index.html
chown -R vigie:vigie /opt/vigie
cd /opt/vigie
runuser -u vigie -- env HOME=/opt/vigie npm ci --omit=dev --no-audit --no-fund

etape "Carte de France (3,8 Go : quelques minutes)"
if [ -f /opt/vigie/tiles.pmtiles ]; then
    echo "Carte déjà présente, gardée. Pour la rafraîchir : cd /opt/vigie && runuser -u vigie -- env HOME=/opt/vigie npm run carte"
else
    runuser -u vigie -- env HOME=/opt/vigie npm run carte
fi

etape "Code medic"
install -d -m 700 /etc/vigie
if [ -s /etc/vigie/vigie.env ]; then
    echo "Code medic déjà en place, gardé."
else
    ( umask 077; echo "MEDIC_CODE=$(node -e "process.stdout.write(require('crypto').randomBytes(12).toString('hex'))")" > /etc/vigie/vigie.env )
    echo "Code medic créé (sans l'afficher). Pour le lire : cat /etc/vigie/vigie.env"
fi

etape "Service système"
# tr : au cas où un fichier aurait été réenregistré avec des fins de ligne Windows
tr -d '\r' < /opt/vigie/deploiement/vigie.service > /etc/systemd/system/vigie.service
systemctl daemon-reload
systemctl enable vigie
systemctl restart vigie

etape "HTTPS avec Caddy"
tr -d '\r' < /opt/vigie/deploiement/Caddyfile | sed "s/vigie\.exemple\.fr/$DOMAINE/g" > /etc/caddy/Caddyfile
install -d /etc/systemd/system/caddy.service.d
tr -d '\r' < /opt/vigie/deploiement/caddy-memoire.conf > /etc/systemd/system/caddy.service.d/vigie.conf
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
systemctl daemon-reload
systemctl restart caddy

etape "Vérifications"
ok=0
for _ in $(seq 1 15); do
    if curl -fs -o /dev/null http://127.0.0.1:4321/api/config; then ok=1; break; fi
    sleep 1
done
if [ "$ok" = 1 ]; then
    echo "Vigie répond."
else
    echo "Vigie ne répond pas. Ses dernières erreurs :"
    journalctl -u vigie -n 30 --no-pager
    exit 1
fi
# Lignes d'information seulement : jamais un échec (domaine pas encore en place, par exemple)
ICI="$(ip -brief address show scope global 2>/dev/null | awk '{for (i = 3; i <= NF; i++) print $i}' | tr '\n' ' ' || true)"
LA="$(getent ahosts "$DOMAINE" 2>/dev/null | awk '{print $1}' | sort -u | tr '\n' ' ' || true)"
echo "Adresses du serveur : $ICI"
echo "Adresses de $DOMAINE : ${LA:-aucune (DNS pas encore en place)}"
echo
echo "Terminé. Ouvre https://$DOMAINE : le certificat HTTPS arrive tout seul en une minute environ,"
echo "dès que le domaine pointe vers ce serveur. Code medic : cat /etc/vigie/vigie.env"
