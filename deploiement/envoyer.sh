#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Vigie : envoie le dernier commit sur le serveur par Tor. Depuis un terminal bash (Linux, macOS, ou
# Git Bash sous Windows), Tor Browser ouvert :
#   bash deploiement/envoyer.sh ADRESSE_IP vigiemap.org   installation complète (relançable)
#   bash deploiement/envoyer.sh --maj ADRESSE_IP          mise à jour du code seulement (20 s environ)
# La passphrase de la clé est demandée deux fois (envoi, puis installation ou redémarrage), ou jamais
# après un « ssh-add ~/.ssh/vigie » en début de session.
set -euo pipefail

MAJ=0
if [ "${1:-}" = "--maj" ]; then MAJ=1; shift; fi
IP="${1:-}"
DOMAINE="${2:-}"
if [ -z "$IP" ] || { [ "$MAJ" = 0 ] && [ -z "$DOMAINE" ]; }; then
    echo "Usage : bash deploiement/envoyer.sh ADRESSE_IP vigiemap.org   (installation)"
    echo "        bash deploiement/envoyer.sh --maj ADRESSE_IP          (mise à jour du code)"
    exit 1
fi
CLE="${CLE:-$HOME/.ssh/vigie}"
TOR="${TOR:-127.0.0.1:9150}" # le port de Tor Browser ; 9050 pour le service Tor seul
# Passage par Tor : « connect » (fourni avec Git pour Windows) ou « nc » (OpenBSD netcat, Linux et macOS)
if command -v connect >/dev/null 2>&1; then
    # connect s'identifie auprès de Tor, qui accepte n'importe quel mot de passe : on en donne un d'office,
    # sinon il essaie de le demander par une fenêtre et échoue
    export SOCKS5_PASSWD=vigie
    PROXY="connect -S vigie@$TOR %h %p"
elif command -v nc >/dev/null 2>&1; then
    PROXY="nc -X 5 -x $TOR %h %p"
else
    echo "Il faut « connect » ou « nc » (paquet netcat-openbsd) pour passer par Tor."
    exit 1
fi
SSH_OPTS=(-i "$CLE" -o "ProxyCommand=$PROXY" -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=30)

DOSSIER="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Seul le dernier commit part, par git archive : jamais un fichier local non suivi (notes, réglages de
# l'éditeur, copies), ni l'historique Git (il contient l'adresse du dépôt), ni un nom de compte. Une
# modification non commitée ne partirait pas : on refuse plutôt que de laisser croire qu'elle est en ligne.
if ! git -C "$DOSSIER" diff --quiet HEAD --; then
    echo "Des modifications ne sont pas commitées (git status) : commite-les, ou mets-les de côté avec git stash."
    exit 1
fi
echo "==> Archive du dernier commit ($(git -C "$DOSSIER" rev-parse --short HEAD) : $(git -C "$DOSSIER" log -1 --format=%s))"
# Le kit d'impression (flyers) ne sert pas au serveur : autant de moins à faire passer par Tor
git -C "$DOSSIER" archive --format=tar.gz --prefix=vigie/ -o "$TMP/vigie.tgz" HEAD -- . ':(exclude)kit'
echo "$(du -h "$TMP/vigie.tgz" | cut -f1) à envoyer"

if [ "$MAJ" = 1 ]; then
    echo "==> Envoi par Tor vers $IP"
    ssh "${SSH_OPTS[@]}" "root@$IP" 'cat > /root/vigie.tgz && echo "Connexions ouvertes sur Vigie en ce moment (en gros, les téléphones en direct) : $(ss -Htn state established "( sport = :4321 )" | wc -l)"' < "$TMP/vigie.tgz"
    read -r -p "Redémarrer Vigie avec la nouvelle version ? Tout ce qu'il a en mémoire sera effacé (o/N) " REPONSE
    if [ "$REPONSE" != o ] && [ "$REPONSE" != O ]; then
        echo "Rien n'a changé en ligne : la nouvelle version attend sur le serveur sans être appliquée."
        exit 0
    fi
    # Une fois appliquée, l'archive n'a plus rien à faire sur le serveur
    ssh "${SSH_OPTS[@]}" "root@$IP" "tar -xzOf /root/vigie.tgz vigie/deploiement/maj.sh | tr -d '\r' | bash && rm -f /root/vigie.tgz"
    exit 0
fi

echo "==> Envoi par Tor vers $IP"
ssh "${SSH_OPTS[@]}" "root@$IP" 'cat > /root/vigie.tgz && rm -rf /root/vigie && tar -xzf /root/vigie.tgz -C /root --no-same-owner' < "$TMP/vigie.tgz"

echo "==> Installation sur le serveur (une dizaine de minutes la première fois, surtout pour la carte)"
ssh -t "${SSH_OPTS[@]}" "root@$IP" "tr -d '\r' < /root/vigie/deploiement/installer.sh > /root/installer.sh && bash /root/installer.sh '$DOMAINE' /root/vigie.tgz && rm -rf /root/vigie /root/vigie.tgz /root/installer.sh"
