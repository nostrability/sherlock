import type { SemanticCheck } from '../semantic.js';
import type { NostrEvent, SemanticViolation } from '../../types.js';

const WSS_PATTERN = /^wss?:\/\/.+/;

export const kind10002Checks: SemanticCheck[] = [
  {
    kind: 10002,
    name: 'kind10002_relay_url_format',
    check: (event: NostrEvent): SemanticViolation[] => {
      const violations: SemanticViolation[] = [];
      const rTags = event.tags.filter(t => t[0] === 'r' && t[1]);

      for (const tag of rTags) {
        const url = tag[1];
        if (!WSS_PATTERN.test(url)) {
          violations.push({
            check_name: 'kind10002_relay_url_format',
            message: `Relay URL does not use wss:// scheme: "${url.slice(0, 60)}"`,
            path: '/tags',
            severity: 'warning',
          });
        }
      }

      return violations;
    },
  },
  {
    kind: 10002,
    name: 'kind10002_duplicate_relays',
    check: (event: NostrEvent): SemanticViolation[] => {
      const rTags = event.tags.filter(t => t[0] === 'r' && t[1]);
      const urls = rTags.map(t => t[1].toLowerCase().replace(/\/+$/, ''));
      const unique = new Set(urls);

      if (unique.size < urls.length) {
        const dupeCount = urls.length - unique.size;
        return [{
          check_name: 'kind10002_duplicate_relays',
          message: `Relay list has ${dupeCount} duplicate relay URL(s)`,
          path: '/tags',
          severity: 'warning',
        }];
      }
      return [];
    },
  },
];
