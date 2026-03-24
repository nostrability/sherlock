import type { ClientAttribution } from '../types.js';

/**
 * Extract NIP-89 client tag from event tags (Tier 1 attribution).
 * Tag format: ["client", "<name>", "<31990:pubkey:d-tag>"]
 */
export function extractClientTag(tags: string[][]): ClientAttribution | null {
  const tag = tags.find(t => t[0] === 'client');
  if (!tag || !tag[1]) return null;
  return {
    name: tag[1],
    address: tag[2] ?? undefined,
  };
}
