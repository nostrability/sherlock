import { getKindNipMap } from './validate/engine.js';

export const DEFAULT_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.ditto.pub',
];

export const PUBLISH_RELAYS = DEFAULT_RELAYS;

export const PRIORITY_KINDS = [
  0,      // NIP-01: Profile metadata
  3,      // NIP-02: Contact list
  10002,  // NIP-65: Relay list metadata
  30023,  // NIP-23: Long-form content
  14,     // NIP-17: Direct message
  15,     // NIP-17: File message
  10050,  // NIP-17: DM relay list
  13,     // NIP-59: Seal
  1059,   // NIP-59: Gift wrap
  13194,  // NIP-47: NWC info
  23194,  // NIP-47: NWC request
  23195,  // NIP-47: NWC response
  23196,  // NIP-47: NWC notification request
  23197,  // NIP-47: NWC notification
  9734,   // NIP-57: Zap request
  9735,   // NIP-57: Zap receipt
];

// Default scan window: 24 hours
export const DEFAULT_SCAN_WINDOW_SECONDS = 24 * 60 * 60;

// Relay-friendly spacing
export const DEFAULT_PAGINATE_INTERVAL = '5s';   // pause between paginated pages
export const DEFAULT_RELAY_PAUSE_MS = 3000;       // pause between sequential relay scans
export const DEFAULT_BATCH_PAUSE_MS = 2000;       // pause between kind batches on same relay
export const DEFAULT_KIND_BATCH_SIZE = 5;         // max kinds per REQ filter

export const DB_FILENAME = 'sherlock.db';

export const GITHUB_REPO = 'https://github.com/nostrability/sherlock';

export const PRIORITY_KIND_NAMES: Record<number, string> = {
  0:     'Profile Metadata (NIP-01)',
  3:     'Contact List (NIP-02)',
  10002: 'Relay List Metadata (NIP-65)',
  30023: 'Long-form Content (NIP-23)',
  14:    'Direct Message (NIP-17)',
  15:    'File Message (NIP-17)',
  10050: 'DM Relay List (NIP-17)',
  13:    'Seal (NIP-59)',
  1059:  'Gift Wrap (NIP-59)',
  13194: 'NWC Info (NIP-47)',
  23194: 'NWC Request (NIP-47)',
  23195: 'NWC Response (NIP-47)',
  23196: 'NWC Notification Request (NIP-47)',
  23197: 'NWC Notification (NIP-47)',
  9734:  'Zap Request (NIP-57)',
  9735:  'Zap Receipt (NIP-57)',
};

let _kindNamesCache: Record<number, string> | null = null;

/**
 * Get human-readable names for all known kinds.
 * Priority kinds use hand-written names; others use "Kind N (NIP-XX)" from schemata.
 */
export function getKindNames(): Record<number, string> {
  if (_kindNamesCache) return _kindNamesCache;
  const names: Record<number, string> = { ...PRIORITY_KIND_NAMES };
  const nipMap = getKindNipMap();
  for (const [kind, nip] of nipMap) {
    if (!(kind in names)) {
      names[kind] = `Kind ${kind} (${nip})`;
    }
  }
  _kindNamesCache = names;
  return _kindNamesCache;
}

export const STATUS_THRESHOLDS = {
  MIN_EVENTS: 5,
  ALMOST_MAX: 0.05,  // ≤5% error rate = "almost clean"
};
