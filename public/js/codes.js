// SPDX-License-Identifier: AGPL-3.0-or-later
// Vigie : codes à partager de la main à la main (cellule, binôme, collectif de medics), en base32
// Crockford, et empreinte d'un code de collectif. Module à part, chargé aussi par le serveur : l'appli et
// lui calculent la même empreinte, et les tests le vérifient.
import { sha256 } from './pow.js';

export const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function b32encode(bytes) {
    let bits = 0;
    let val = 0;
    let out = '';
    for (const b of bytes) {
        val = (val << 8) | b;
        bits += 8;
        while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; }
    }
    if (bits > 0) out += B32[(val << (5 - bits)) & 31];
    return out;
}

// Lettres qu'on confond à la lecture ramenées à celles de l'alphabet, séparateurs retirés
export const cleanCode = (str) => String(str ?? '').toUpperCase().replace(/I/g, '1').replace(/L/g, '1').replace(/O/g, '0').replace(/U/g, 'V').replace(/[^0-9A-Z]/g, '');

export function b32decode(str) {
    const clean = cleanCode(str);
    let bits = 0;
    let val = 0;
    const out = [];
    for (const ch of clean) {
        const idx = B32.indexOf(ch);
        if (idx < 0) return null;
        val = (val << 5) | idx;
        bits += 5;
        if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; }
    }
    return out;
}

// Code d'un collectif de medics : 14 octets tirés au hasard (23 caractères) et le type « M » en dernier
export const MEDIC_CODE_RE = /^[0-9A-HJKMNP-TV-Z]{23}M$/;
export const PRINT_RE = /^[0-9A-HJKMNP-TV-Z]{16}$/;

// Empreinte d'un code de collectif : SHA-256 du code nettoyé, ses 10 premiers octets en base32
// (16 caractères). Seule l'empreinte part chez l'exploitant du serveur : elle ne permet pas de
// retrouver le code, et elle ne porte aucun nom.
export const medicPrint = (code) => b32encode(sha256(new TextEncoder().encode(cleanCode(code))).slice(0, 10));
