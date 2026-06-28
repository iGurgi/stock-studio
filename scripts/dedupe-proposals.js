// One-time cleanup: collapse duplicate *pending* proposals down to the most
// recent per idea. An "idea" is asset_type:side:symbol (the same key the
// proposal pass now uses to avoid re-surfacing duplicates). Older rows in each
// duplicate group are marked 'expired' rather than deleted, so the audit trail
// is preserved. Safe to run repeatedly — it's a no-op once deduped.
//
//   node scripts/dedupe-proposals.js          # apply
//   node scripts/dedupe-proposals.js --dry     # show what would change, touch nothing
//
// Honors DB_PATH (same as the app); defaults to ./data/studio.db.
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || join(__dirname, '..', 'data', 'studio.db');
const DRY = process.argv.includes('--dry');

const db = new DatabaseSync(DB_PATH);
const now = () => new Date().toISOString();

// Within each idea group, keep the highest id (most recent); expire the rest.
const losers = db.prepare(`
  SELECT id, symbol, asset_type, side FROM proposals
  WHERE status='pending'
    AND id NOT IN (
      SELECT MAX(id) FROM proposals
      WHERE status='pending'
      GROUP BY lower(asset_type || ':' || side || ':' || symbol)
    )
  ORDER BY id
`).all();

if (!losers.length) {
  console.log(`No duplicate pending proposals in ${DB_PATH}. Nothing to do.`);
  process.exit(0);
}

console.log(`${DRY ? '[dry run] ' : ''}Expiring ${losers.length} duplicate pending proposal(s) in ${DB_PATH}:`);
for (const p of losers) console.log(`  - #${p.id}  ${p.side} ${p.symbol} (${p.asset_type})`);

if (DRY) { console.log('\n[dry run] no changes written.'); process.exit(0); }

const upd = db.prepare("UPDATE proposals SET status='expired', decided_at=?, decided_by='dedupe-script' WHERE id=? AND status='pending'");
const tx = db.prepare('BEGIN'); tx.run();
try {
  for (const p of losers) upd.run(now(), p.id);
  db.prepare('COMMIT').run();
} catch (e) {
  db.prepare('ROLLBACK').run();
  throw e;
}
console.log(`\nDone. ${losers.length} duplicate(s) marked 'expired'; the most recent of each idea remains pending.`);
