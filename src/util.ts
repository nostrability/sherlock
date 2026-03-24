import { execFile } from 'node:child_process';

/**
 * Check if a command is available on PATH. Returns the path or null.
 */
export function which(cmd: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('which', [cmd], (err, stdout) => {
      if (err) resolve(null);
      else resolve(stdout.trim() || null);
    });
  });
}

/**
 * Parse a human-friendly duration string to seconds.
 * Supports: 1h, 24h, 7d, 30m, 1h30m, etc.
 */
export function parseDuration(input: string): number {
  let total = 0;
  const pattern = /(\d+)\s*(d|h|m|s)/gi;
  let match;
  while ((match = pattern.exec(input)) !== null) {
    const value = parseInt(match[1], 10);
    const unit = match[2].toLowerCase();
    switch (unit) {
      case 'd': total += value * 86400; break;
      case 'h': total += value * 3600; break;
      case 'm': total += value * 60; break;
      case 's': total += value; break;
    }
  }
  if (total === 0) {
    // Try parsing as plain number (seconds)
    const num = parseInt(input, 10);
    if (!isNaN(num)) return num;
    throw new Error(`Invalid duration: "${input}". Use formats like: 1h, 24h, 7d, 30m`);
  }
  return total;
}

/**
 * Format a number with commas.
 */
export function formatNumber(n: number): string {
  return n.toLocaleString();
}

/**
 * Format a percentage with 1 decimal place.
 */
export function formatPercent(n: number, total: number): string {
  if (total === 0) return '0.0%';
  return (n / total * 100).toFixed(1) + '%';
}
