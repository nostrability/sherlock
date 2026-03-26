import type { SemanticCheck } from '../semantic.js';
import type { NostrEvent, SemanticViolation } from '../../types.js';

const URL_PATTERN = /^https?:\/\/.+/;
const NIP05_PATTERN = /^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

export const kind0Checks: SemanticCheck[] = [
  {
    kind: 0,
    name: 'kind0_picture_url',
    check: (event: NostrEvent): SemanticViolation[] => {
      try {
        const profile = JSON.parse(event.content);
        const violations: SemanticViolation[] = [];

        if (profile.picture && typeof profile.picture === 'string' && profile.picture.length > 0) {
          if (!URL_PATTERN.test(profile.picture)) {
            violations.push({
              check_name: 'kind0_picture_url',
              message: `picture field is not a valid URL: "${profile.picture.slice(0, 50)}"`,
              path: '/content/picture',
              severity: 'warning',
            });
          }
        }

        if (profile.banner && typeof profile.banner === 'string' && profile.banner.length > 0) {
          if (!URL_PATTERN.test(profile.banner)) {
            violations.push({
              check_name: 'kind0_banner_url',
              message: `banner field is not a valid URL: "${profile.banner.slice(0, 50)}"`,
              path: '/content/banner',
              severity: 'warning',
            });
          }
        }

        return violations;
      } catch {
        return []; // Content not valid JSON — already caught by schema validation
      }
    },
  },
  {
    kind: 0,
    name: 'kind0_nip05_format',
    check: (event: NostrEvent): SemanticViolation[] => {
      try {
        const profile = JSON.parse(event.content);
        if (profile.nip05 && typeof profile.nip05 === 'string' && profile.nip05.length > 0) {
          if (!NIP05_PATTERN.test(profile.nip05)) {
            return [{
              check_name: 'kind0_nip05_format',
              message: `nip05 field has invalid format: "${profile.nip05.slice(0, 50)}"`,
              path: '/content/nip05',
              severity: 'warning',
            }];
          }
        }
        return [];
      } catch {
        return [];
      }
    },
  },
];
