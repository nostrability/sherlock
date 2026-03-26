import { DEFAULT_RELAYS, PRIORITY_KINDS, DEFAULT_SCAN_WINDOW_SECONDS, DEFAULT_KIND_BATCH_SIZE, DEFAULT_RELAY_PAUSE_MS, DEFAULT_BATCH_LIMIT } from '../config.js';
import { fetchEvents, checkNak } from '../fetch/nak.js';
import { validateEvent, checkSchemaAvailability, runSemanticChecks, getAvailableKinds } from '../validate/engine.js';
import { resolveAttribution } from '../attribution/resolve.js';
import { fetchNip89Handlers } from '../attribution/nip89.js';
import { loadFingerprints } from '../attribution/fingerprints.js';
import { storeEvent, getHighWaterMark, getDb, createScanRun, finishScanRun } from '../db/index.js';
import { parseDuration, formatNumber } from '../util.js';
import type { RateLimitEvent } from '../types.js';

interface ScanCommandOptions {
  kinds?: string;
  allSchemas?: boolean;
  relays?: string;
  since?: string;
  jitter?: string;
  batchLimit?: string;
}

/**
 * Add random jitter to a timestamp.
 * Returns a timestamp shifted by a random amount within [-jitterSeconds, 0].
 * This ensures we look further back (never forward) by a random offset,
 * so different runs sample different time cohorts.
 */
function applyJitter(since: number, jitterSeconds: number): number {
  const offset = Math.floor(Math.random() * jitterSeconds);
  return since - offset;
}

export async function scanCommand(opts: ScanCommandOptions): Promise<void> {
  // Check nak availability
  const nakPath = await checkNak();
  if (!nakPath) {
    console.error('Error: nak is not installed.');
    console.error('Install from: https://github.com/fiatjaf/nak');
    process.exit(1);
  }
  console.log(`Using nak: ${nakPath}`);

  // Resolve kinds: --kinds CSV > --all-schemas > default priority kinds
  const allAvailable = getAvailableKinds();
  let kinds: number[];
  if (opts.kinds) {
    kinds = opts.kinds.split(',').map(k => parseInt(k.trim(), 10)).filter(k => !isNaN(k));
  } else if (opts.allSchemas) {
    kinds = allAvailable;
  } else {
    kinds = PRIORITY_KINDS;
  }

  // Parse relays
  const relays = opts.relays
    ? opts.relays.split(',').map(r => r.trim()).filter(Boolean)
    : DEFAULT_RELAYS;

  // Determine since timestamp + per-kind watermarks
  let since: number;
  let perKindSince: Map<number, number> | undefined;
  if (opts.since) {
    const duration = parseDuration(opts.since);
    since = Math.floor(Date.now() / 1000) - duration;
  } else {
    // Use per-kind high water marks so frequent kinds don't starve rare ones
    const fallback = Math.floor(Date.now() / 1000) - DEFAULT_SCAN_WINDOW_SECONDS;
    perKindSince = new Map();
    let minSince = Infinity;
    for (const kind of kinds) {
      const hwm = getHighWaterMark(kind);
      const ts = hwm ?? fallback;
      perKindSince.set(kind, ts);
      if (ts < minSince) minSince = ts;
    }
    since = minSince === Infinity ? fallback : minSince;
  }

  // Apply time jitter: randomly look further back by up to 6 hours
  // so consecutive runs sample different time cohorts
  const jitterSeconds = opts.jitter ? parseDuration(opts.jitter) : 6 * 3600;
  const originalSince = since;
  since = applyJitter(since, jitterSeconds);
  const jitterApplied = originalSince - since;

  // Check schema availability
  const { available, missing } = checkSchemaAvailability(kinds);
  console.log(`\nAvailable schemas: ${allAvailable.length} | Scanning: ${kinds.length} kinds`);
  console.log(`  Schema coverage: ${available.length}/${kinds.length} kinds`);
  if (missing.length > 0) {
    console.log(`  Missing schemas: ${missing.join(', ')}`);
    console.log(`  Events for these kinds will be stored with valid=NULL`);
  }

  const batchLimit = opts.batchLimit !== undefined ? parseInt(opts.batchLimit, 10) : DEFAULT_BATCH_LIMIT;
  const sinceDate = new Date(since * 1000).toISOString();
  const numBatches = Math.ceil(kinds.length / DEFAULT_KIND_BATCH_SIZE);
  const estMinutes = Math.ceil((numBatches * 7 + DEFAULT_RELAY_PAUSE_MS / 1000) * relays.length / 60);
  console.log(`\nScanning ${kinds.length} kinds in ${numBatches} batches from ${relays.length} relays (~${estMinutes}min)`);
  console.log(`  Kinds: ${kinds.join(', ')}`);
  console.log(`  Relays: ${relays.join(', ')} (order randomized)`);
  console.log(`  Since: ${sinceDate} (jitter: -${Math.floor(jitterApplied / 60)}m)`);
  console.log(`  Batch limit: ${batchLimit > 0 ? formatNumber(batchLimit) + ' events/batch' : 'unlimited'}`);
  if (perKindSince) {
    console.log(`  Using per-kind watermarks (${perKindSince.size} kinds)`);
  }
  console.log('');

  const progress = {
    fetched: 0,
    duplicates: 0,
    newEvents: 0,
    violations: 0,
    rateLimits: 0,
  };
  const rateLimitEvents: RateLimitEvent[] = [];

  // Ensure DB is initialized
  getDb();

  // Create scan run
  const scanRunId = createScanRun(kinds, relays, since);
  console.log(`  Scan run #${scanRunId}`);

  const startTime = Date.now();

  try {
    // Load attribution data
    console.log('  Loading attribution data...');
    const nip89Map = await fetchNip89Handlers(relays);
    console.log(`  NIP-89 handlers: ${nip89Map.size} pubkeys mapped`);
    const fingerprints = loadFingerprints();
    console.log(`  Fingerprints: ${fingerprints.length} app patterns loaded`);
    console.log('');

    await fetchEvents({
      kinds,
      relays,
      since,
      perKindSince,
      batchLimit: isNaN(batchLimit) ? DEFAULT_BATCH_LIMIT : batchLimit,
      onRelayStart: (relay, index, total) => {
        console.log(`  [relay ${index + 1}/${total}] ${relay}`);
      },
      onRelayDone: (relay, count) => {
        console.log(`  [done] ${relay}: ${formatNumber(count)} events\n`);
      },
      onBatchStart: (_relay, batchKinds, batchIndex, totalBatches) => {
        console.log(`    batch ${batchIndex + 1}/${totalBatches}: kinds [${batchKinds.join(', ')}]`);
      },
      onRateLimit: (event) => {
        progress.rateLimits++;
        rateLimitEvents.push(event);
        console.error(`    !! RATE LIMITED by ${event.relay}: ${event.reason}`);
      },
      onEvent: (event, relay) => {
        progress.fetched++;

        const validation = validateEvent(event);
        const semanticIssues = runSemanticChecks(event);

        // Add semantic violations to validation errors for storage
        for (const issue of semanticIssues) {
          validation.errors.push({
            instancePath: issue.path,
            schemaPath: '',
            keyword: issue.check_name,
            params: { severity: issue.severity },
            message: issue.message,
          });
          if (validation.valid !== false && issue.severity === 'error') {
            validation.valid = false;
          }
        }

        const attribution = resolveAttribution(event, nip89Map, fingerprints);
        const isNew = storeEvent(event, validation, null, relay, scanRunId, attribution);

        if (!isNew) {
          progress.duplicates++;
        } else {
          progress.newEvents++;
          if (validation.errors.length > 0) {
            progress.violations += validation.errors.length;
          }
        }

        if (progress.fetched % 500 === 0) {
          process.stdout.write(`\r    ${formatNumber(progress.fetched)} events processed...`);
        }
      },
      onError: (error) => {
        console.error(`\n  Warning: ${error}`);
      },
    });
  } finally {
    // Always finalize scan run, even on error
    finishScanRun(scanRunId, {
      events_fetched: progress.fetched,
      events_new: progress.newEvents,
      violations_found: progress.violations,
    });
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log('');
  console.log(`Finished in ${elapsed}s (scan run #${scanRunId})`);
  console.log('');
  console.log('Results:');
  console.log(`  Total fetched:  ${formatNumber(progress.fetched)}`);
  console.log(`  New events:     ${formatNumber(progress.newEvents)}`);
  console.log(`  Duplicates:     ${formatNumber(progress.duplicates)}`);
  console.log(`  Violations:     ${formatNumber(progress.violations)}`);

  if (progress.rateLimits > 0) {
    console.log('');
    console.log(`  !! Rate limited ${progress.rateLimits} time(s):`);
    for (const rl of rateLimitEvents) {
      console.log(`     ${rl.relay}: ${rl.reason}`);
    }
    console.log('');
    console.log('  Consider: fewer kinds per batch, longer paginate interval, or fewer relays.');
  }
}
