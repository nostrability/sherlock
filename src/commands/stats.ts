import {
  getTotalEvents,
  getEventCountsByKind,
  getHighWaterMark,
  getDb,
} from '../db/index.js';
import { formatNumber, formatPercent } from '../util.js';

export function statsCommand(): void {
  getDb(); // ensure initialized

  const total = getTotalEvents();
  if (total === 0) {
    console.log('No events in database. Run `sherlock scan` first.');
    return;
  }

  const byKind = getEventCountsByKind();
  const hwm = getHighWaterMark();

  let totalValid = 0;
  let totalInvalid = 0;
  let totalNoSchema = 0;
  for (const row of byKind) {
    totalValid += row.valid;
    totalInvalid += row.invalid;
    totalNoSchema += row.no_schema;
  }

  console.log('\nSherlock Stats\n');
  console.log(`  Total events:     ${formatNumber(total)}`);
  console.log(`  Valid:            ${formatNumber(totalValid)} (${formatPercent(totalValid, total)})`);
  console.log(`  Invalid:          ${formatNumber(totalInvalid)} (${formatPercent(totalInvalid, total)})`);
  console.log(`  No schema:        ${formatNumber(totalNoSchema)} (${formatPercent(totalNoSchema, total)})`);

  if (hwm) {
    console.log(`  Last event:       ${new Date(hwm * 1000).toISOString()}`);
  }

  console.log('\nBy Kind:\n');
  console.log(`${'Kind'.padEnd(10)} ${'Total'.padStart(8)} ${'Valid'.padStart(8)} ${'Invalid'.padStart(8)} ${'No Schema'.padStart(10)} ${'Error Rate'.padStart(12)}`);
  console.log('-'.repeat(60));
  for (const row of byKind) {
    const validated = row.valid + row.invalid;
    const errorRate = validated > 0 ? formatPercent(row.invalid, validated) : 'N/A';
    console.log(
      `${String(row.kind).padEnd(10)} ${String(row.total).padStart(8)} ${String(row.valid).padStart(8)} ${String(row.invalid).padStart(8)} ${String(row.no_schema).padStart(10)} ${errorRate.padStart(12)}`
    );
  }
}
