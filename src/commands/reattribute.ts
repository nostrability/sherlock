import { extractClientTag } from '../attribution/client-tag.js';
import { getDb } from '../db/index.js';
import { formatNumber } from '../util.js';

/**
 * Re-run Tier 1 (client tag) attribution on existing unattributed events.
 * Scans events where client_name IS NULL and raw JSON is available,
 * parses tags, and updates attribution columns in place.
 */
export function reattributeCommand(): void {
  const db = getDb();

  // Find unattributed events that still have raw JSON stored
  const rows = db.prepare(`
    SELECT id, raw FROM events
    WHERE client_name IS NULL AND raw != '' AND raw IS NOT NULL
  `).all() as Array<{ id: string; raw: string }>;

  console.log(`Found ${formatNumber(rows.length)} unattributed events with stored raw JSON`);

  if (rows.length === 0) {
    console.log('Nothing to reattribute.');
    return;
  }

  const update = db.prepare(`
    UPDATE events
    SET client_name = ?, attribution_method = 'client_tag', attribution_confidence = 'high'
    WHERE id = ?
  `);

  let attributed = 0;
  let parsed = 0;
  let parseErrors = 0;

  const txn = db.transaction(() => {
    for (const row of rows) {
      let tags: string[][];
      try {
        const event = JSON.parse(row.raw);
        tags = event.tags;
        parsed++;
      } catch {
        parseErrors++;
        continue;
      }

      if (!Array.isArray(tags)) continue;

      const client = extractClientTag(tags);
      if (client) {
        update.run(client.name, row.id);
        attributed++;
      }
    }
  });

  txn();

  console.log(`\nResults:`);
  console.log(`  Parsed:      ${formatNumber(parsed)}`);
  console.log(`  Parse errors: ${formatNumber(parseErrors)}`);
  console.log(`  Attributed:  ${formatNumber(attributed)}`);
  console.log(`  Still unattributed: ${formatNumber(rows.length - attributed)}`);
}
