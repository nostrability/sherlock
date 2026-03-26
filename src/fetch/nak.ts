import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { which } from '../util.js';
import {
  DEFAULT_PAGINATE_INTERVAL,
  DEFAULT_RELAY_PAUSE_MS,
  DEFAULT_BATCH_PAUSE_MS,
  DEFAULT_KIND_BATCH_SIZE,
  DEFAULT_BATCH_LIMIT,
  HIGH_VOLUME_KINDS,
} from '../config.js';
import type { ChildProcess } from 'node:child_process';
import type { NostrEvent, RateLimitEvent } from '../types.js';

// Track active child processes so we can kill them on SIGINT
const activeProcs = new Set<ChildProcess>();
let sigintHandlerInstalled = false;

function installSigintHandler(): void {
  if (sigintHandlerInstalled) return;
  sigintHandlerInstalled = true;
  process.on('SIGINT', () => {
    for (const proc of activeProcs) {
      proc.kill('SIGTERM');
    }
    activeProcs.clear();
    process.exit(130); // standard SIGINT exit code
  });
}

// Patterns nak prints to stderr when a relay sends CLOSED
const RATE_LIMIT_PATTERNS = [
  'rate-limited',
  'too many',
  'slow down',
  'throttl',
];

/**
 * Check if nak is installed and accessible.
 */
export async function checkNak(): Promise<string | null> {
  return which('nak');
}

export interface NakFetchOptions {
  kinds: number[];
  relays: string[];
  since: number;
  /** Per-kind watermarks — if provided, each batch uses the minimum since across its kinds. */
  perKindSince?: Map<number, number>;
  /** Max events per nak batch request (passed as --limit to nak). 0 = unlimited. */
  batchLimit?: number;
  onEvent: (event: NostrEvent, relay: string) => void;
  onError?: (error: string) => void;
  onRateLimit?: (event: RateLimitEvent) => void;
  onRelayStart?: (relay: string, index: number, total: number) => void;
  onRelayDone?: (relay: string, count: number) => void;
  onBatchStart?: (relay: string, batchKinds: number[], batchIndex: number, totalBatches: number) => void;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function chunk<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

/**
 * Fisher-Yates shuffle (in-place).
 */
export function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Check stderr output for rate limiting signals.
 * nak prints "wss://relay.example.com CLOSED: rate-limited: ..." to stderr.
 */
function detectRateLimits(stderr: string, relay: string): RateLimitEvent[] {
  const events: RateLimitEvent[] = [];
  const lines = stderr.split('\n');
  for (const line of lines) {
    const lower = line.toLowerCase();
    if (lower.includes('closed:') && RATE_LIMIT_PATTERNS.some(p => lower.includes(p))) {
      events.push({ relay, reason: line.trim() });
    }
  }
  return events;
}

/**
 * Fetch events from a single relay for a batch of kinds via nak.
 */
async function fetchBatchFromRelay(
  nakPath: string,
  relay: string,
  kinds: number[],
  since: number,
  batchLimit: number,
  onEvent: (event: NostrEvent, relay: string) => void,
  onError?: (error: string) => void,
  onRateLimit?: (event: RateLimitEvent) => void,
): Promise<number> {
  const args = ['req'];

  for (const kind of kinds) {
    args.push('-k', String(kind));
  }

  args.push('--since', String(since));
  if (batchLimit > 0) {
    args.push('--limit', String(batchLimit));
  }
  args.push('--paginate');
  args.push('--paginate-interval', DEFAULT_PAGINATE_INTERVAL);
  args.push(relay);

  return new Promise<number>((resolve, reject) => {
    let count = 0;

    const proc = spawn(nakPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    activeProcs.add(proc);

    const rl = createInterface({ input: proc.stdout });

    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;

      try {
        const event = JSON.parse(trimmed) as NostrEvent;
        if (event.id && event.kind !== undefined && event.pubkey) {
          count++;
          onEvent(event, relay);
        }
      } catch {
        onError?.(`Failed to parse nak output: ${trimmed.slice(0, 100)}`);
      }
    });

    let stderr = '';
    const STDERR_MAX = 10240; // 10 KB cap
    proc.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < STDERR_MAX) {
        stderr += chunk.toString();
        if (stderr.length > STDERR_MAX) stderr = stderr.slice(0, STDERR_MAX);
      }
    });

    proc.on('close', (code) => {
      activeProcs.delete(proc);
      // Check for rate limiting in stderr regardless of exit code
      const rateLimits = detectRateLimits(stderr, relay);
      for (const rateLimit of rateLimits) {
        onRateLimit?.(rateLimit);
      }

      if (code === 0) {
        resolve(count);
      } else if (code === 3) {
        onError?.(`Relay ${relay} failed for kinds [${kinds}]: ${stderr.trim()}`);
        resolve(count);
      } else {
        reject(new Error(`nak exited with code ${code} for ${relay}: ${stderr.trim()}`));
      }
    });

    proc.on('error', (err) => {
      reject(new Error(`Failed to spawn nak: ${err.message}`));
    });
  });
}

/**
 * Fetch events from all relays sequentially, batching kinds into small groups.
 *
 * Relays are shuffled to avoid always hitting the same relay first.
 * Kind batches are also shuffled for sampling diversity.
 */
export async function fetchEvents(opts: NakFetchOptions): Promise<number> {
  const nakPath = await checkNak();
  if (!nakPath) {
    throw new Error('nak is not installed. Install from: https://github.com/fiatjaf/nak');
  }

  installSigintHandler();

  // Shuffle relay order so we don't always hit the same one first
  const relays = shuffle([...opts.relays]);

  // Separate high-volume kinds into solo batches so they don't starve others
  const highVolume = new Set(HIGH_VOLUME_KINDS);
  const soloKinds = opts.kinds.filter(k => highVolume.has(k));
  const normalKinds = opts.kinds.filter(k => !highVolume.has(k));
  const kindBatches = shuffle([
    ...soloKinds.map(k => [k]),
    ...chunk(normalKinds, DEFAULT_KIND_BATCH_SIZE),
  ]);

  let totalCount = 0;

  for (let ri = 0; ri < relays.length; ri++) {
    const relay = relays[ri];

    if (ri > 0) {
      await sleep(DEFAULT_RELAY_PAUSE_MS);
    }

    opts.onRelayStart?.(relay, ri, relays.length);
    let relayCount = 0;

    for (let bi = 0; bi < kindBatches.length; bi++) {
      const batch = kindBatches[bi];

      if (bi > 0) {
        await sleep(DEFAULT_BATCH_PAUSE_MS);
      }

      opts.onBatchStart?.(relay, batch, bi, kindBatches.length);

      // Use per-kind watermarks if available: take the minimum since across this batch's kinds
      let batchSince = opts.since;
      if (opts.perKindSince) {
        batchSince = Math.min(...batch.map(k => opts.perKindSince!.get(k) ?? opts.since));
      }

      try {
        const count = await fetchBatchFromRelay(
          nakPath,
          relay,
          batch,
          batchSince,
          opts.batchLimit ?? DEFAULT_BATCH_LIMIT,
          opts.onEvent,
          opts.onError,
          opts.onRateLimit,
        );
        relayCount += count;
      } catch (err) {
        opts.onError?.(`Error scanning ${relay} kinds [${batch}]: ${err}`);
      }
    }

    totalCount += relayCount;
    opts.onRelayDone?.(relay, relayCount);
  }

  return totalCount;
}
