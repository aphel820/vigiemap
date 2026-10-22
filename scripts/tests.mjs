// SPDX-License-Identifier: AGPL-3.0-or-later
// Lance toutes les suites de tests/ l'une après l'autre : chacune démarre son propre serveur, sur
// son propre port. Usage : npm test (ou node scripts/tests.mjs audit pour une seule suite).
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const DIR = fileURLToPath(new URL('../tests/', import.meta.url));
const only = process.argv[2];
const files = readdirSync(DIR).filter((f) => /\.test\.(mjs|cjs)$/.test(f) && (!only || f.startsWith(only))).sort();
const failed = [];
for (const f of files) {
    const t0 = Date.now();
    // --expose-gc : la suite mémoire mesure le tas après un vrai ramassage
    const r = spawnSync(process.execPath, ['--expose-gc', path.join(DIR, f)], { encoding: 'utf8', timeout: 300_000 });
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    const ok = r.status === 0;
    console.log(`${ok ? 'ok   ' : 'ÉCHEC'} ${f} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
    if (!ok) {
        failed.push(f);
        const fails = out.split('\n').filter((l) => l.startsWith('FAIL'));
        console.log((fails.length ? fails : out.trim().split('\n').slice(-15)).map((l) => `      ${l}`).join('\n'));
    }
}
console.log(failed.length ? `\n${failed.length} suite(s) en échec sur ${files.length}` : `\nToutes les suites passent (${files.length}).`);
process.exit(failed.length ? 1 : 0);
