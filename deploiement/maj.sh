#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Vigie : applique la nouvelle version déjà envoyée dans /root/vigie.tgz (lancé par envoyer.sh --maj).
# Code seulement : pas de mises à jour du système, pas de carte. Les modules ne sont réinstallés que si
# package-lock.json a changé. Le redémarrage efface ce que Vigie a en mémoire.
set -euo pipefail

cd /opt/vigie
avant="$(sha256sum package-lock.json 2>/dev/null | cut -d' ' -f1 || true)"
# Version précédente gardée pour un retour arrière (sans la carte ni les modules) :
#   tar -xzf /root/vigie-precedent.tgz -C /opt && chown -R vigie:vigie /opt/vigie && systemctl restart vigie
tar -czf /root/vigie-precedent.tgz -C /opt --exclude='vigie/tiles.pmtiles*' --exclude=vigie/node_modules --exclude=vigie/cache vigie
# Extraite d'abord à part : une archive tronquée (envoi coupé) arrête tout ici, l'appli en ligne intacte.
# Puis public/ et scripts/ sont remplacés en entier : un fichier qui en est retiré ne reste pas en ligne
# (ailleurs, un fichier retiré reste sur le serveur, sans être servi : seul public/ l'est).
NOUVEAU="$(mktemp -d)"
trap 'rm -rf "$NOUVEAU"' EXIT
tar -xzf /root/vigie.tgz -C "$NOUVEAU" --strip-components=1 --no-same-owner
rm -rf /opt/vigie/public /opt/vigie/scripts
cp -a "$NOUVEAU"/. /opt/vigie/
chown -R vigie:vigie /opt/vigie
if [ "$avant" != "$(sha256sum package-lock.json | cut -d' ' -f1)" ]; then
    echo "==> Dépendances changées : réinstallation"
    runuser -u vigie -- env HOME=/opt/vigie npm ci --omit=dev --no-audit --no-fund
else
    # public/vendor n'est pas dans l'archive : on le refait à partir des modules déjà installés
    runuser -u vigie -- env HOME=/opt/vigie node scripts/vendor.js
fi

# Le service lui-même a changé : on le réinstalle (les fins de ligne Windows éventuelles retirées)
if ! tr -d '\r' < deploiement/vigie.service | cmp -s - /etc/systemd/system/vigie.service; then
    echo "==> Service système modifié : réinstallé"
    tr -d '\r' < deploiement/vigie.service > /etc/systemd/system/vigie.service
    systemctl daemon-reload
fi

# Caddy aussi : un changement du Caddyfile ou de caddy-memoire.conf n'était jamais appliqué par --maj.
# Le domaine se relit dans le Caddyfile en place (la ligne « domaine {  »).
caddy_change=0
DOMAINE="$(awk '$2 == "{" && $1 ~ /\./ { print $1; exit }' /etc/caddy/Caddyfile 2>/dev/null || true)"
if [ -n "$DOMAINE" ]; then
    # Aperçu des liens partagés : adresses complètes au domaine réel (comme à l'installation)
    sed -i "s#https://vigiemap\.org/#https://$DOMAINE/#g" public/index.html
    chown vigie:vigie public/index.html
    tr -d '\r' < deploiement/Caddyfile | sed "s/vigie\.exemple\.fr/$DOMAINE/g" > /tmp/Caddyfile.vigie
    if ! cmp -s /tmp/Caddyfile.vigie /etc/caddy/Caddyfile; then
        caddy validate --config /tmp/Caddyfile.vigie --adapter caddyfile
        install -m 644 /tmp/Caddyfile.vigie /etc/caddy/Caddyfile
        echo "==> Caddyfile modifié : appliqué"
        caddy_change=1
    fi
    rm -f /tmp/Caddyfile.vigie
fi
if ! tr -d '\r' < deploiement/caddy-memoire.conf | cmp -s - /etc/systemd/system/caddy.service.d/vigie.conf; then
    install -d /etc/systemd/system/caddy.service.d
    tr -d '\r' < deploiement/caddy-memoire.conf > /etc/systemd/system/caddy.service.d/vigie.conf
    systemctl daemon-reload
    echo "==> Réglages du service Caddy modifiés : appliqués"
    caddy_change=1
fi
if [ "$caddy_change" = 1 ]; then systemctl restart caddy; fi

echo "==> Redémarrage de Vigie"
systemctl restart vigie
for _ in $(seq 1 15); do
    if curl -fs -o /dev/null http://127.0.0.1:4321/api/config; then
        echo "Vigie répond : nouvelle version en ligne."
        exit 0
    fi
    sleep 1
done
echo "Vigie ne répond pas. Ses dernières erreurs :"
journalctl -u vigie -n 30 --no-pager
exit 1
