// Syntax-check every JS/MJS source file with `node --check`. Cross-platform
// (no shell globbing) so it runs the same locally and in CI. `node --check`
// validates a file's syntax without executing it or resolving its imports —
// safe to run without credentials or a configured environment.
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOTS = ['src', 'scripts'];
const SKIP = new Set(['node_modules', '.git', 'data']);

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(mjs|cjs|js)$/.test(entry)) out.push(p);
  }
  return out;
}

const files = ROOTS.flatMap(walk);
let failed = 0;
for (const f of files) {
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
  } catch (e) {
    failed++;
    console.error(`✗ ${f}`);
    console.error(String(e.stderr || e.message).trim());
  }
}
console.log(`checked ${files.length} files — ${failed ? `${failed} failed` : 'all OK'}`);
process.exit(failed ? 1 : 0);
