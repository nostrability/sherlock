import type { SemanticCheck } from '../semantic.js';
import type { NostrEvent, SemanticViolation } from '../../types.js';

/**
 * Parse millisat amount from a bolt11 invoice prefix.
 * Only handles the amount prefix (before the 1-separator), no full decode.
 * Returns null if unparseable.
 */
function parseBolt11Amount(bolt11: string): number | null {
  const lower = bolt11.toLowerCase();
  // bolt11 format: ln[tb][c]<amount><multiplier>1<data...>
  const match = lower.match(/^ln(?:bc|tb|tbs|bcrt)(\d+)([munp]?)1/);
  if (!match) return null;

  const base = parseInt(match[1], 10);
  if (isNaN(base)) return null;

  const multiplier = match[2];
  // Convert to millisats
  // Base unit is BTC, so 1 = 100_000_000_000 msat
  switch (multiplier) {
    case 'm': return base * 100_000_000;   // milli-BTC
    case 'u': return base * 100_000;       // micro-BTC
    case 'n': return base * 100;           // nano-BTC
    case 'p': return base / 10;            // pico-BTC (0.1 msat)
    case '':  return base * 100_000_000_000; // BTC
    default: return null;
  }
}

export const kind9735Checks: SemanticCheck[] = [
  {
    kind: 9735,
    name: 'kind9735_bolt11_amount_mismatch',
    check: (event: NostrEvent): SemanticViolation[] => {
      // Find bolt11 tag
      const bolt11Tag = event.tags.find(t => t[0] === 'bolt11' && t[1]);
      if (!bolt11Tag) return [];

      // Find amount tag (in millisats)
      const amountTag = event.tags.find(t => t[0] === 'amount' && t[1]);
      if (!amountTag) return [];

      const tagAmount = parseInt(amountTag[1], 10);
      if (isNaN(tagAmount)) return [];

      const bolt11Amount = parseBolt11Amount(bolt11Tag[1]);
      if (bolt11Amount === null) return []; // Can't parse, skip

      // Compare (allow 1% tolerance for rounding)
      if (Math.abs(bolt11Amount - tagAmount) > Math.max(tagAmount * 0.01, 1)) {
        return [{
          check_name: 'kind9735_bolt11_amount_mismatch',
          message: `bolt11 amount (${bolt11Amount} msat) does not match amount tag (${tagAmount} msat)`,
          path: '/tags',
          severity: 'warning',
        }];
      }

      return [];
    },
  },
];
