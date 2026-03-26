#!/usr/bin/env node

import { Command } from 'commander';
import { scanCommand } from './commands/scan.js';
import { reportCommand } from './commands/report.js';
import { statsCommand } from './commands/stats.js';
import { exportCommand } from './commands/export.js';
import { closeDb } from './db/index.js';

const program = new Command();

program
  .name('sherlock')
  .description('Validate Nostr events against JSON Schemas and identify apps producing malformed blobs')
  .version('0.1.0');

program
  .command('scan')
  .description('Fetch and validate events from relays')
  .option('--kinds <kinds>', 'Comma-separated list of kinds to scan (default: 16 priority kinds)')
  .option('--all-schemas', 'Scan all kinds that have a schemata schema')
  .option('--relays <relays>', 'Comma-separated list of relay URLs')
  .option('--since <duration>', 'How far back to scan (e.g., 1h, 24h, 7d)')
  .option('--jitter <duration>', 'Max random offset added to --since for cohort diversity (default: 6h)')
  .action(async (opts) => {
    if (opts.kinds && opts.allSchemas) {
      console.error('Error: --kinds and --all-schemas are mutually exclusive.');
      process.exit(1);
    }
    try {
      await scanCommand(opts);
    } catch (err) {
      console.error('Scan failed:', err);
      process.exit(1);
    } finally {
      closeDb();
    }
  });

program
  .command('report')
  .description('Show violation reports')
  .option('--by <grouping>', 'Group by: kind, client, error, recent, trend (default: kind)')
  .option('--format <format>', 'Output format: table, json, csv (default: table)')
  .option('--limit <n>', 'Limit number of results')
  .action((opts) => {
    try {
      reportCommand(opts);
    } catch (err) {
      console.error('Report failed:', err);
      process.exit(1);
    } finally {
      closeDb();
    }
  });

program
  .command('stats')
  .description('Show database statistics')
  .action(() => {
    try {
      statsCommand();
    } catch (err) {
      console.error('Stats failed:', err);
      process.exit(1);
    } finally {
      closeDb();
    }
  });

program
  .command('export')
  .description('Export findings to JSON, HTML dashboard, and optionally publish to Nostr')
  .option('--outdir <dir>', 'Output directory (default: current directory)')
  .option('--publish', 'Publish report to Nostr via nak (requires NOSTR_SECRET_KEY)')
  .action(async (opts) => {
    try {
      await exportCommand(opts);
    } catch (err) {
      console.error('Export failed:', err);
      process.exit(1);
    } finally {
      closeDb();
    }
  });

program.parse();
