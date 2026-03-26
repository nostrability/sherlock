import { DEFAULT_RELAYS, DEFAULT_KINDS, DEFAULT_SCAN_WINDOW_SECONDS, DEFAULT_KIND_BATCH_SIZE } from '../config.js';
import { fetchEvents, checkNak } from '../fetch/nak.js';
import { validateEvent, checkSchemaAvailability } from '../validate/engine.js';
import { extractClientTag } from '../attribution/client-tag.js';
import { storeEvent, getHighWaterMark, getDb } from '../db/index.js';
import { parseDuration, formatNumber } from '../util.js';
import type { RateLimitEvent } from '../types.js';

interface ScanCommandOptions {
  kinds?: string;
  relays?: string;
  since?: string;
  jitter?: string;
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

  // Parse kinds
  const kinds = opts.kinds
    ? opts.kinds.split(',').map(k => parseInt(k.trim(), 10)).filter(k => !isNaN(k))
    : DEFAULT_KINDS;

  // Parse relays
  const relays = opts.relays
    ? opts.relays.split(',').map(r => r.trim()).filter(Boolean)
    : DEFAULT_RELAYS;

  // Determine since timestamp.
  // When no --since is given, use per-kind high-water marks so that each kind
  // resumes from its own last-seen timestamp. This prevents a kind with recent
  // activity from advancing the watermark past kinds that haven't been scanned.
  let since: number;
  let perKindSince: Map<number, number> | null = null;
  if (opts.since) {
    const duration = parseDuration(opts.since);
    since = Math.floor(Date.now() / 1000) - duration;
  } else {
    const fallback = Math.floor(Date.now() / 1000) - DEFAULT_SCAN_WINDOW_SECONDS;
    const kindTimestamps = new Map<number, number>();
    let minSince = Infinity;
    for (const kind of kinds) {
      const hwm = getHighWaterMark(kind);
      const ts = hwm ?? fallback;
      kindTimestamps.set(kind, ts);
      if (ts < minSince) minSince = ts;
    }
    since = minSince === Infinity ? fallback : minSince;
    perKindSince = kindTimestamps;
  }

  // Apply time jitter: randomly look further back by up to 6 hours
  // so consecutive runs sample different time cohorts
  const jitterSeconds = opts.jitter ? parseDuration(opts.jitter) : 6 * 3600;
  const originalSince = since;
  since = applyJitter(since, jitterSeconds);
  const jitterApplied = originalSince - since;

  // Check schema availability
  const { available, missing } = checkSchemaAvailability(kinds);
  console.log(`\nSchema coverage: ${available.length}/${kinds.length} kinds`);
  if (missing.length > 0) {
    console.log(`  Missing schemas: ${missing.join(', ')}`);
    console.log(`  Events for these kinds will be stored with valid=NULL`);
  }

  const sinceDate = new Date(since * 1000).toISOString();
  const numBatches = Math.ceil(kinds.length / DEFAULT_KIND_BATCH_SIZE);
  console.log(`\nScanning ${kinds.length} kinds in ${numBatches} batches from ${relays.length} relays`);
  console.log(`  Kinds: ${kinds.join(', ')}`);
  console.log(`  Relays: ${relays.join(', ')} (order randomized)`);
  console.log(`  Since: ${sinceDate} (jitter: -${Math.floor(jitterApplied / 60)}m)`);
  console.log('');

  const progress = {
    fetched: 0,
    duplicates: 0,
    newEvents: 0,
    invalidEvents: 0,
    violationErrors: 0,
    rateLimits: 0,
  };
  const rateLimitEvents: RateLimitEvent[] = [];

  // Ensure DB is initialized
  getDb();

  const startTime = Date.now();

  await fetchEvents({
    kinds,
    relays,
    since,
    perKindSince: perKindSince ?? undefined,
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
      const client = extractClientTag(event.tags);
      const isNew = storeEvent(event, validation, client, relay);

      if (!isNew) {
        progress.duplicates++;
      } else {
        progress.newEvents++;
        if (validation.valid === false) {
          progress.invalidEvents++;
          progress.violationErrors += validation.errors.length;
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

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log('');
  console.log(`Finished in ${elapsed}s`);
  console.log('');
  console.log('Results:');
  console.log(`  Total fetched:  ${formatNumber(progress.fetched)}`);
  console.log(`  New events:     ${formatNumber(progress.newEvents)}`);
  console.log(`  Duplicates:     ${formatNumber(progress.duplicates)}`);
  console.log(`  Invalid events: ${formatNumber(progress.invalidEvents)}`);
  console.log(`  Violation errs: ${formatNumber(progress.violationErrors)}`);

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
