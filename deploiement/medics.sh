#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Vigie : ajoute, retire ou compte les empreintes des codes de collectifs de medics, par Tor. Depuis un
# terminal bash (Git Bash sous Windows), Tor Browser ouvert :
#   bash deploiement/medics.sh ajouter ADRESSE_IP XXXX-XXXX-XXXX-XXXX
#   bash deploiement/medics.sh retirer ADRESSE_IP XXXX-XXXX-XXXX-XXXX
#   bash deploiement/medics.sh compter ADRESSE_IP
# Le serveur relit la liste tout seul en une seconde : rien ne redémarre, rien n'est effacé.
# Après un ajout, supprime le mail qui t'a apporté l'empreinte : ne garde nulle part quel collectif a
# quelle empreinte. La liste du serveur n'a ni nom ni date, et elle est triée (l'ordre d'ajout disparaît).
set -euo pipefail

ACTION="${1:-}"
IP="${2:-}"
FICHIER=/etc/vigie-medics.txt
usage() {
    echo "Usage : bash deploiement/medics.sh ajouter ADRESSE_IP EMPREINTE"
    echo "        bash deploiement/medics.sh retirer ADRESSE_IP EMPREINTE"
    echo "        bash deploiement/medics.sh compter ADRESSE_IP"
    exit 1
}
[ -n "$IP" ] || usage
EMPREINTE=""
if [ "$ACTION" = ajouter ] || [ "$ACTION" = retirer ]; then
    # Même nettoyage que l'appli : majuscules, lettres ambiguës ramenées à l'alphabet, tirets retirés
    EMPREINTE="$(printf '%s' "${3:-}" | tr 'a-z' 'A-Z' | tr 'ILOU' '110V' | tr -cd '0-9A-Z')"
    [[ "$EMPREINTE" =~ ^[0-9A-HJKMNP-TV-Z]{16}$ ]] || { echo "Empreinte invalide : 16 caractères attendus (XXXX-XXXX-XXXX-XXXX)."; exit 1; }
elif [ "$ACTION" != compter ]; then
    usage
fi

CLE="${CLE:-$HOME/.ssh/vigie}"
TOR="${TOR:-127.0.0.1:9150}" # le port de Tor Browser ; 9050 pour le service Tor seul
if command -v connect >/dev/null 2>&1; then
    export SOCKS5_PASSWD=vigie
    PROXY="connect -S vigie@$TOR %h %p"
elif command -v nc >/dev/null 2>&1; then
    PROXY="nc -X 5 -x $TOR %h %p"
else
    echo "Il faut « connect » ou « nc » (paquet netcat-openbsd) pour passer par Tor."
    exit 1
fi
SSH_OPTS=(-i "$CLE" -o "ProxyCommand=$PROXY" -o StrictHostKeyChecking=accept-new)

# L'empreinte n'a que des lettres et des chiffres (vérifié plus haut) : rien à échapper dans la commande
case "$ACTION" in
    ajouter)
        ssh "${SSH_OPTS[@]}" "root@$IP" "touch $FICHIER && chmod 644 $FICHIER && echo $EMPREINTE >> $FICHIER && sort -u -o $FICHIER $FICHIER && echo \"Ajoutée. Collectifs dans la liste : \$(wc -l < $FICHIER)\""
        echo "Pense à supprimer le mail qui t'a apporté cette empreinte."
        ;;
    retirer)
        ssh "${SSH_OPTS[@]}" "root@$IP" "touch $FICHIER && if grep -qx $EMPREINTE $FICHIER; then grep -vx $EMPREINTE $FICHIER > $FICHIER.tmp || true; cat $FICHIER.tmp > $FICHIER; rm -f $FICHIER.tmp; echo \"Retirée : ce code ne marche plus. Collectifs dans la liste : \$(wc -l < $FICHIER)\"; else echo 'Empreinte absente de la liste.'; fi"
        ;;
    compter)
        ssh "${SSH_OPTS[@]}" "root@$IP" "touch $FICHIER && echo \"Collectifs dans la liste : \$(wc -l < $FICHIER)\""
        ;;
esac
