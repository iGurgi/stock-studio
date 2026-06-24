import { config, equitiesOpen } from '../config.js';
import { logEvent, isHalted } from '../db.js';
import { researchPass } from './research.js';
import { trackingPass } from './tracking.js';
import { proposalPass } from './proposals.js';

const MIN = 60 * 1000;
let running = { research: false, tracking: false, proposal: false };

async function guarded(name, fn) {
  if (running[name]) return;            // never overlap a pass with itself
  if (isHalted() && name !== 'tracking') return; // keep watching even when halted
  running[name] = true;
  try {
    await fn();
  } catch (e) {
    logEvent('error', 'scheduler', `${name} threw: ${e.message || e}`);
  } finally {
    running[name] = false;
  }
}

export function startScheduler() {
  logEvent('info', 'scheduler', 'Scheduler started');
  console.log('[scheduler] running. Cadence (min):', config.cadence);

  // Kick one of each shortly after boot so the dashboard isn't empty.
  setTimeout(() => guarded('research', researchPass), 5 * 1000);
  setTimeout(() => guarded('tracking', trackingPass), 15 * 1000);

  setInterval(() => guarded('research', researchPass), config.cadence.researchMin * MIN);
  setInterval(() => guarded('tracking', trackingPass), config.cadence.trackingMin * MIN);
  setInterval(() => {
    // proposals only when there's somewhere to act: crypto 24/7, equities in-hours
    if (config.rails.allowCrypto || equitiesOpen()) guarded('proposal', proposalPass);
  }, config.cadence.proposalMin * MIN);
}

// Run standalone: `node src/agent/scheduler.js`
if (import.meta.url === `file://${process.argv[1]}`) {
  startScheduler();
}
