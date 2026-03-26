import type { SemanticCheck } from '../semantic.js';
import type { NostrEvent, SemanticViolation } from '../../types.js';

const FIFTEEN_MINUTES = 15 * 60;
const NOSTR_EPOCH = 1577836800; // 2020-01-01 00:00:00 UTC

export const universalChecks: SemanticCheck[] = [
  {
    kind: '*',
    name: 'future_timestamp',
    check: (event: NostrEvent): SemanticViolation[] => {
      const now = Math.floor(Date.now() / 1000);
      if (event.created_at > now + FIFTEEN_MINUTES) {
        return [{
          check_name: 'future_timestamp',
          message: `Timestamp is ${Math.floor((event.created_at - now) / 60)} minutes in the future`,
          path: '/created_at',
          severity: 'warning',
        }];
      }
      return [];
    },
  },
  {
    kind: '*',
    name: 'timestamp_too_old',
    check: (event: NostrEvent): SemanticViolation[] => {
      if (event.created_at < NOSTR_EPOCH) {
        return [{
          check_name: 'timestamp_too_old',
          message: `Timestamp is before 2020-01-01 (${new Date(event.created_at * 1000).toISOString()})`,
          path: '/created_at',
          severity: 'warning',
        }];
      }
      return [];
    },
  },
];
