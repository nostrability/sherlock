import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { which } from '../util.js';
import { DEFAULT_RELAY_PAUSE_MS } from '../config.js';
import type { NostrEvent } from '../types.js';

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Fetch kind:31990 (NIP-89 handler info) events from relays.
 * Returns a Map<pubkey, {name, address}> for pubkey→app resolution.
 *
 * Follows relay-friendly conventions: sequential relay scanning with pauses.
 */
type HandlerEntry = { name: string; address: string; created_at: number; id: string };

export async function fetchNip89Handlers(relays: string[]): Promise<Map<string, { name: string; address: string }>> {
  const nakPath = await which('nak');
  if (!nakPath) return new Map();

  const handlers = new Map<string, HandlerEntry>();

  for (let i = 0; i < relays.length; i++) {
    const relay = relays[i];
    if (i > 0) await sleep(DEFAULT_RELAY_PAUSE_MS);

    try {
      const events = await fetchKind31990(nakPath, relay);
      for (const event of events) {
        processHandlerEvent(event, handlers);
      }
    } catch (err) {
      // Non-fatal: skip relay on error
      console.error(`    Warning: NIP-89 fetch from ${relay} failed: ${err}`);
    }
  }

  // Strip internal fields before returning
  const result = new Map<string, { name: string; address: string }>();
  for (const [pubkey, entry] of handlers) {
    result.set(pubkey, { name: entry.name, address: entry.address });
  }
  return result;
}

const NAK_TIMEOUT_MS = 60_000; // 60s max per relay
const MAX_STDERR_LEN = 4096;

function fetchKind31990(nakPath: string, relay: string): Promise<NostrEvent[]> {
  return new Promise((resolve, reject) => {
    const events: NostrEvent[] = [];
    const args = ['req', '-k', '31990', '--limit', '500', relay];
    let settled = false;

    const proc = spawn(nakPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        proc.kill();
        resolve(events); // return whatever we got before timeout
      }
    }, NAK_TIMEOUT_MS);

    const rl = createInterface({ input: proc.stdout });

    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const event = JSON.parse(trimmed) as NostrEvent;
        if (event.id && event.kind === 31990) {
          events.push(event);
        }
      } catch { /* skip malformed */ }
    });

    let stderr = '';
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
      if (stderr.length > MAX_STDERR_LEN) {
        stderr = stderr.slice(-MAX_STDERR_LEN);
      }
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (code === 0 || code === 3) {
        resolve(events);
      } else {
        reject(new Error(`nak exited with code ${code}: ${stderr.trim()}`));
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      reject(new Error(`Failed to spawn nak: ${err.message}`));
    });
  });
}

/**
 * Extract app name and pubkey bindings from a kind:31990 handler event.
 *
 * Handler events contain:
 * - d tag: app identifier
 * - content: JSON with name field
 * - pubkey: the app operator's pubkey
 *
 * We map the handler's pubkey to the app name so events from that
 * pubkey can be attributed to the app.
 */
function processHandlerEvent(
  event: NostrEvent,
  handlers: Map<string, HandlerEntry>,
): void {
  try {
    // Try to parse content for app name
    let appName: string | null = null;

    if (event.content) {
      try {
        const content = JSON.parse(event.content);
        if (content.name && typeof content.name === 'string') {
          appName = content.name;
        }
      } catch { /* content may not be JSON */ }
    }

    // Fall back to d-tag value
    if (!appName) {
      const dTag = event.tags.find(t => t[0] === 'd');
      if (dTag?.[1]) {
        appName = dTag[1];
      }
    }

    if (!appName) return;

    // Build the NIP-89 address (31990:pubkey:d-tag)
    const dTag = event.tags.find(t => t[0] === 'd');
    const address = `31990:${event.pubkey}:${dTag?.[1] ?? ''}`;

    // Map the handler's pubkey to the app — keep the newest event per pubkey
    const existing = handlers.get(event.pubkey);
    if (!existing) {
      handlers.set(event.pubkey, { name: appName, address, created_at: event.created_at, id: event.id });
    } else if (event.created_at > existing.created_at || (event.created_at === existing.created_at && event.id < existing.id)) {
      handlers.set(event.pubkey, { name: appName, address, created_at: event.created_at, id: event.id });
    }
  } catch { /* skip malformed handler events */ }
}
