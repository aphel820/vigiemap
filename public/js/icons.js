// SPDX-License-Identifier: AGPL-3.0-or-later
// Vigie : pictogrammes (trait épais, lisibles même flous) et types de signalements

const P = {
    // Dangers (publics)
    charge: '<path d="M15 3.5l6 2.2v5c0 4.3-2.6 7.7-6 9.3-3.4-1.6-6-5-6-9.3v-5z"/><path d="M2 9h4.5M3 13h3.5M2 17h5"/>',
    nasse: '<path d="M3.5 3.5l5 5M20.5 3.5l-5 5M3.5 20.5l5-5M20.5 20.5l-5-5"/><path d="M9 4.5v4H5M15 4.5v4h4M9 19.5v-4H5M15 19.5v-4h4"/>',
    gaz: '<path d="M7 16.5h10a4 4 0 0 0 .4-8A6 6 0 0 0 6.2 9.6 3.5 3.5 0 0 0 7 16.5z"/><path d="M4 20.5h7M14 20.5h5"/>',
    eau: '<path d="M12 2.5c2.8 3.6 4.5 6 4.5 8.6a4.5 4.5 0 0 1-9 0c0-2.6 1.7-5 4.5-8.6z"/><path d="M3 19.5c1.5 1.2 3 1.2 4.5 0s3-1.2 4.5 0 3 1.2 4.5 0 3-1.2 4.5 0"/>',
    tirs: '<circle cx="12" cy="12" r="3.2"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4M4.9 4.9l2.8 2.8M16.3 16.3l2.8 2.8M4.9 19.1l2.8-2.8M16.3 7.7l2.8-2.8"/>',
    interp: '<circle cx="6.8" cy="14.5" r="4.3"/><circle cx="17.2" cy="14.5" r="4.3"/><path d="M9.6 11.1 12 8.5l2.4 2.6"/>',
    tension: '<path d="M2 13h4l2.5-6.5 4 13 3-9.5 2 3H22"/>',
    agressif: '<circle cx="6.5" cy="7.5" r="2.6"/><circle cx="17.5" cy="7.5" r="2.6"/><path d="M2.5 20.5v-2a4 4 0 0 1 8 0v2M13.5 20.5v-2a4 4 0 0 1 8 0v2"/><path d="M12.6 2.5 10.6 7h2.8l-2 4.5"/>',
    filtrage: '<path d="M3 4.5h18l-7 8.5v6.2l-4 2.3V13z"/>',
    ferme: '<circle cx="12" cy="12" r="9"/><path d="M6.8 12h10.4"/>',

    // Aide (medics seulement)
    blesse: '<rect x="2.5" y="8" width="19" height="8" rx="4" transform="rotate(-45 12 12)"/><path d="M10.6 10.6h.01M13.4 13.4h.01M10.6 13.4h.01M13.4 10.6h.01"/>',
    gaze: '<path d="M2 10.5s3.6-6 10-6 10 6 10 6-3.6 6-10 6-10-6-10-6z"/><circle cx="12" cy="10.5" r="2.6"/><path d="M8.5 20.2a1.6 1.6 0 0 0 3.2 0c0-1-1.6-2.9-1.6-2.9s-1.6 1.9-1.6 2.9z"/>',
    malaise: '<path d="M12 20.5s-7.6-4.6-9-9.6C2 7.2 4.3 4 7.4 4c2 0 3.5 1.1 4.6 2.7C13.1 5.1 14.6 4 16.6 4c3.1 0 5.4 3.2 4.4 6.9-1.4 5-9 9.6-9 9.6z"/><path d="M5 12h3.5l1.5-2.8 2.6 5.2 1.5-2.4H19"/>',
    isole: '<circle cx="12" cy="6.5" r="3.4"/><path d="M5.5 21v-2a6.5 6.5 0 0 1 13 0v2"/>',

    // Interface
    warn: '<path d="M12 3.2 2.3 20.2h19.4z"/><path d="M12 9.5v4.6M12 17.2v.1"/>',
    plus: '<path d="M12 4.5v15M4.5 12h15"/>',
    minus: '<path d="M4.5 12h15"/>',
    menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
    close: '<path d="M6 6l12 12M18 6 6 18"/>',
    locate: '<circle cx="12" cy="12" r="7"/><circle class="f" cx="12" cy="12" r="2.6"/><path d="M12 1.5v3M12 19.5v3M1.5 12h3M19.5 12h3"/>',
    arrow: '<path class="f" d="M12 2.5l7 18-7-4.2-7 4.2z"/>',
    wind: '<path d="M3 8.5h9.5a3 3 0 1 0-3-3M3 12.5h14.5a3 3 0 1 1-3 3M3 16.5h6"/>',
    eye: '<path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    lock: '<rect x="4.5" y="10.5" width="15" height="10.5" rx="2"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/>',
    pin: '<path d="M12 21.5s7-6.2 7-12a7 7 0 0 0-14 0c0 5.8 7 12 7 12z"/><circle cx="12" cy="9.5" r="2.6"/>',
    timer: '<circle cx="12" cy="13.5" r="7.5"/><path d="M12 9.5v4l2.6 2.4M9 2.5h6"/>',
    phone: '<path d="M5.2 3.5h3.4l1.6 4.4-2.3 1.5a11.5 11.5 0 0 0 6.7 6.7l1.5-2.3 4.4 1.6v3.4a2 2 0 0 1-2.1 2A16.8 16.8 0 0 1 3.2 5.6a2 2 0 0 1 2-2.1z"/>',
    users: '<circle cx="9" cy="8" r="3.2"/><path d="M3 20v-1.5A5.5 5.5 0 0 1 8.5 13h1a5.5 5.5 0 0 1 5.5 5.5V20"/><path d="M15.5 4.9a3.2 3.2 0 0 1 0 6.2M18 13.4a5.5 5.5 0 0 1 3 5.1V20"/>',
    check: '<path d="M4.5 12.5l5 5 10-11"/>',
    download: '<path d="M12 3.5v11M7 10l5 5 5-5M4.5 20h15"/>',
    // Guide d'installation : les boutons tels que le téléphone les montre
    partage: '<path d="M12 3v11.5M7.8 7.2 12 3l4.2 4.2"/><path d="M8.5 10.5H6.5a1.5 1.5 0 0 0-1.5 1.5v7.5A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V12a1.5 1.5 0 0 0-1.5-1.5h-2"/>',
    ajout: '<rect x="4" y="4" width="16" height="16" rx="3.5"/><path d="M12 8.5v7M8.5 12h7"/>',
    points: '<circle class="f" cx="12" cy="5" r="1.8"/><circle class="f" cx="12" cy="12" r="1.8"/><circle class="f" cx="12" cy="19" r="1.8"/>',
    shield: '<path d="M12 3l7.5 2.7v5.4c0 4.6-3.1 8-7.5 9.4-4.4-1.4-7.5-4.8-7.5-9.4V5.7z"/><path d="M8.6 12.2l2.4 2.4 4.4-4.8"/>',
    qr: '<path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4z"/><path d="M14 14h2.5v2.5H14zM17.5 17.5H20V20h-2.5zM14 20v-1M20 14v2.5"/>',
    camera: '<path d="M4 8h3l1.6-2.5h6.8L17 8h3v11H4z"/><circle cx="12" cy="13" r="3.4"/>',
    back: '<path d="M14 5l-7 7 7 7M7 12h13"/>',
    copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M4 16V5a1 1 0 0 1 1-1h11"/>',
    envoi: '<circle cx="18" cy="5.5" r="2.6"/><circle cx="6" cy="12" r="2.6"/><circle cx="18" cy="18.5" r="2.6"/><path d="M8.3 10.7l7.4-4M8.3 13.3l7.4 4"/>',
};

export function icon(name) {
    return `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${P[name] || ''}</svg>`;
}

// Dangers : visibles par tous. « sent » sert au message de confirmation (accords compris).
export const TYPES = {
    charge: { label: 'Charge', hint: 'Ils avancent', icon: 'charge', sent: 'Charge signalée', vibe: [450, 120, 450, 120, 450] },
    nasse: { label: 'Nasse', hint: 'On est encerclés', icon: 'nasse', sent: 'Nasse signalée', vibe: [450, 120, 450, 120, 450] },
    gaz: { label: 'Gaz', hint: 'Lacrymogènes', icon: 'gaz', sent: 'Gaz signalé', vibe: [300, 120, 300] },
    eau: { label: 'Canon à eau', hint: 'Jets d\'eau', icon: 'eau', sent: 'Canon à eau signalé', vibe: [300, 120, 300] },
    tirs: { label: 'Tirs', hint: 'LBD, grenades', icon: 'tirs', sent: 'Tirs signalés', vibe: [450, 120, 450, 120, 450] },
    interp: { label: 'Arrestations', hint: 'Interpellations', icon: 'interp', sent: 'Arrestations signalées', vibe: [300, 120, 300] },
    // « more » : tuiles compactes sous les six dangers principaux, pour ne pas cacher la carte où l'on vise
    tension: { label: 'Ça se tend', hint: 'Avant que ça parte', icon: 'tension', sent: 'Tension signalée', vibe: [200, 100, 200], more: true },
    agressif: { label: 'Groupe agressif', hint: 'Attaque, intimidation', icon: 'agressif', sent: 'Groupe agressif signalé', vibe: [450, 120, 450, 120, 450], more: true },
    filtrage: { label: 'Filtrage', hint: 'Fouilles, contrôles', icon: 'filtrage', sent: 'Filtrage signalé', vibe: [300, 120, 300], more: true },
    ferme: { label: 'Sortie fermée', hint: 'Rue, métro bloqués', icon: 'ferme', sent: 'Sortie fermée signalée', vibe: [200, 100, 200], more: true },
};

// Aide : ne part qu'aux medics
export const HELP_TYPES = {
    blesse: { label: 'Blessé·e', hint: 'Plaie, chute, coup', icon: 'blesse' },
    gaze: { label: 'Gazé·e', hint: 'Yeux, souffle', icon: 'gaze' },
    malaise: { label: 'Malaise', hint: 'Panique, vertiges', icon: 'malaise' },
    isole: { label: 'Isolé·e', hint: 'Perdu·e, mineur·e', icon: 'isole' },
};
