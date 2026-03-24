import {
  getViolationsByKind,
  getViolationsByClient,
  getViolationsByError,
  getRecentViolations,
  getDb,
} from '../db/index.js';

interface ReportCommandOptions {
  by?: string;
  format?: string;
  limit?: string;
}

export function reportCommand(opts: ReportCommandOptions): void {
  getDb(); // ensure initialized

  const groupBy = opts.by || 'kind';
  const format = opts.format || 'table';
  const limit = opts.limit ? parseInt(opts.limit, 10) : undefined;

  switch (groupBy) {
    case 'kind':
      reportByKind(format);
      break;
    case 'client':
      reportByClient(format);
      break;
    case 'error':
      reportByError(format, limit);
      break;
    case 'recent':
      reportRecent(format, limit);
      break;
    default:
      console.error(`Unknown grouping: ${groupBy}. Use: kind, client, error, recent`);
      process.exit(1);
  }
}

function reportByKind(format: string): void {
  const rows = getViolationsByKind();
  if (rows.length === 0) {
    console.log('No violations found.');
    return;
  }

  if (format === 'json') {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  if (format === 'csv') {
    console.log('kind,schema_key,error_keyword,error_count');
    for (const row of rows) {
      console.log(`${row.kind},${row.schema_key},${row.error_keyword ?? ''},${row.error_count}`);
    }
    return;
  }

  // Table format
  console.log('\nViolations by Kind\n');
  console.log(`${'Kind'.padEnd(8)} ${'Schema'.padEnd(25)} ${'Error Type'.padEnd(20)} ${'Count'.padStart(8)}`);
  console.log('-'.repeat(65));
  for (const row of rows) {
    console.log(
      `${String(row.kind).padEnd(8)} ${row.schema_key.padEnd(25)} ${(row.error_keyword ?? '-').padEnd(20)} ${String(row.error_count).padStart(8)}`
    );
  }
}

function reportByClient(format: string): void {
  const rows = getViolationsByClient();
  if (rows.length === 0) {
    console.log('No client-attributed events found.');
    return;
  }

  if (format === 'json') {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  if (format === 'csv') {
    console.log('client_name,total_events,invalid_events,violation_count');
    for (const row of rows) {
      console.log(`${row.client_name ?? 'unknown'},${row.total_events},${row.invalid_events},${row.violation_count}`);
    }
    return;
  }

  // Table format
  console.log('\nViolations by Client\n');
  console.log(`${'Client'.padEnd(25)} ${'Events'.padStart(8)} ${'Invalid'.padStart(8)} ${'Violations'.padStart(12)}`);
  console.log('-'.repeat(57));
  for (const row of rows) {
    console.log(
      `${(row.client_name ?? 'unknown').padEnd(25)} ${String(row.total_events).padStart(8)} ${String(row.invalid_events).padStart(8)} ${String(row.violation_count).padStart(12)}`
    );
  }
}

function reportByError(format: string, limit?: number): void {
  const rows = getViolationsByError();
  const display = limit ? rows.slice(0, limit) : rows;

  if (display.length === 0) {
    console.log('No violations found.');
    return;
  }

  if (format === 'json') {
    console.log(JSON.stringify(display, null, 2));
    return;
  }

  if (format === 'csv') {
    console.log('error_keyword,error_path,error_message,count');
    for (const row of display) {
      console.log(`${row.error_keyword ?? ''},${row.error_path ?? ''},${JSON.stringify(row.error_message)},${row.count}`);
    }
    return;
  }

  // Table format
  console.log('\nViolations by Error\n');
  console.log(`${'Keyword'.padEnd(18)} ${'Path'.padEnd(25)} ${'Message'.padEnd(40)} ${'Count'.padStart(8)}`);
  console.log('-'.repeat(95));
  for (const row of display) {
    const msg = row.error_message.length > 38 ? row.error_message.slice(0, 35) + '...' : row.error_message;
    console.log(
      `${(row.error_keyword ?? '-').padEnd(18)} ${(row.error_path ?? '/').padEnd(25)} ${msg.padEnd(40)} ${String(row.count).padStart(8)}`
    );
  }
}

function reportRecent(format: string, limit?: number): void {
  const rows = getRecentViolations(limit ?? 20);

  if (rows.length === 0) {
    console.log('No violations found.');
    return;
  }

  if (format === 'json') {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  console.log('\nRecent Violations\n');
  console.log(`${'Event ID'.padEnd(12)} ${'Kind'.padEnd(8)} ${'Client'.padEnd(20)} ${'Error'.padEnd(40)}`);
  console.log('-'.repeat(84));
  for (const row of rows) {
    const msg = row.error_message.length > 38 ? row.error_message.slice(0, 35) + '...' : row.error_message;
    console.log(
      `${row.event_id.slice(0, 10).padEnd(12)} ${String(row.kind).padEnd(8)} ${(row.client_name ?? '-').padEnd(20)} ${msg.padEnd(40)}`
    );
  }
}
