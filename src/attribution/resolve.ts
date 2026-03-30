import { extractClientTag } from './client-tag.js';
import type { NostrEvent, Attribution, AppFingerprint } from '../types.js';

/**
 * Unified attribution resolver with priority cascade:
 * 1. Tier 1: NIP-89 client tag (high confidence)
 * 2. Tier 2: NIP-89 pubkey→app map (medium confidence)
 * 3. Tier 4: Fingerprint rules (low-medium confidence)
 */
export function resolveAttribution(
  event: NostrEvent,
  nip89Map: Map<string, { name: string; address: string }>,
  fingerprints: AppFingerprint[],
): Attribution | null {
  // Tier 1: client tag
  const clientTag = extractClientTag(event.tags);
  if (clientTag) {
    // Check if any fingerprint disagrees with the client tag
    for (const fp of fingerprints) {
      if (matchFingerprint(event, fp) && fp.app_name.toLowerCase() !== clientTag.name.toLowerCase()) {
        console.warn(`[fingerprint-disagree] client_tag="${clientTag.name}" fingerprint="${fp.app_name}" event=${event.id.slice(0, 8)}`);
        break;
      }
    }
    return {
      name: clientTag.name,
      method: 'client_tag',
      confidence: 'high',
      address: clientTag.address,
    };
  }

  // Tier 2: NIP-89 pubkey lookup
  const nip89Entry = nip89Map.get(event.pubkey);
  if (nip89Entry) {
    return {
      name: nip89Entry.name,
      method: 'nip89_pubkey',
      confidence: 'medium',
      address: nip89Entry.address,
    };
  }

  // Tier 4: Fingerprint matching
  for (const fp of fingerprints) {
    if (matchFingerprint(event, fp)) {
      return {
        name: fp.app_name,
        method: 'fingerprint',
        confidence: 'low',
      };
    }
  }

  return null;
}

export function matchFingerprint(event: NostrEvent, fp: AppFingerprint): boolean {
  // Check pubkey prefix match
  if (fp.pubkey_prefix?.length) {
    if (fp.pubkey_prefix.some(prefix => event.pubkey.startsWith(prefix))) {
      return true;
    }
  }

  // Check tag pattern match (all patterns must match)
  if (fp.tag_pattern?.length) {
    const allMatch = fp.tag_pattern.every(pattern => {
      return event.tags.some(tag => {
        if (tag[0] !== pattern.tag) return false;
        if (pattern.value && tag[1] !== pattern.value) return false;
        return true;
      });
    });
    if (allMatch) return true;
  }

  // Check tag name presence (all names must be present)
  if (fp.tag_name_present?.length) {
    const allPresent = fp.tag_name_present.every(name =>
      event.tags.some(tag => tag[0] === name)
    );
    if (allPresent) return true;
  }

  // Check content pattern match (any pattern matches)
  if (fp.content_pattern?.length) {
    if (fp.content_pattern.some(pattern => event.content.includes(pattern))) {
      return true;
    }
  }

  return false;
}
