import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  getDb,
  getEventCountsByKind,
  getTotalEvents,
  getAppKindMatrix,
  getViolationDetails,
  getTopPubkeysForErrors,
  getTimeRange,
  getDistinctRelays,
} from '../db/index.js';
import { KIND_NAMES, STATUS_THRESHOLDS, GITHUB_REPO, DEFAULT_KINDS } from '../config.js';
import { which } from '../util.js';

// --- Types ---

interface KindFindings {
  name: string;
  schema_key: string;
  total: number; valid: number; invalid: number; error_rate: number;
  top_errors: Array<{ keyword: string | null; path: string | null; message: string; count: number }>;
  by_app: Record<string, { total: number; valid: number; invalid: number; error_rate: number; status: string }>;
}

interface AppFindings {
  total_events: number; total_valid: number; total_invalid: number; error_rate: number;
  kinds_published: number[];
  violations: Array<{
    kind: number; keyword: string | null; path: string | null;
    message: string; count: number; sample_event_ids: string[];
  }>;
}

interface ErrorPattern {
  keyword: string | null; path: string | null; message: string;
  total_count: number; affected_kinds: number[];
  affected_apps: string[];
  sample_event_ids: string[];
  top_pubkeys: string[];
}

interface Findings {
  version: number;
  generated_at: string;
  scan_coverage: {
    total_events: number; total_valid: number; total_invalid: number; total_no_schema: number;
    kinds_scanned: number[];
    relays: string[];
    first_event_at: string | null; last_event_at: string | null;
  };
  by_kind: Record<string, KindFindings>;
  by_app: Record<string, AppFindings>;
  error_patterns: ErrorPattern[];
}

export interface ExportCommandOptions {
  outdir?: string;
  publish?: boolean;
}

// --- Helpers ---

function computeStatus(total: number, invalid: number): string {
  if (total < STATUS_THRESHOLDS.MIN_EVENTS) return 'u';
  if (invalid === 0) return 'y';
  if (invalid / total <= STATUS_THRESHOLDS.ALMOST_MAX) return 'a';
  return 'n';
}

function ts(unix: number | null): string | null {
  return unix ? new Date(unix * 1000).toISOString() : null;
}

// --- Build findings ---

function buildFindings(): Findings {
  getDb(); // ensure initialized

  const total = getTotalEvents();
  const byKind = getEventCountsByKind();
  const matrix = getAppKindMatrix();
  const violations = getViolationDetails();
  const pubkeyRows = getTopPubkeysForErrors();
  const timeRange = getTimeRange();
  const relays = getDistinctRelays();

  // Aggregate totals
  let totalValid = 0, totalInvalid = 0, totalNoSchema = 0;
  for (const r of byKind) {
    totalValid += r.valid;
    totalInvalid += r.invalid;
    totalNoSchema += r.no_schema;
  }

  // Build by_kind (use Object.create(null) to prevent prototype pollution from client-controlled keys)
  const findingsByKind: Record<string, KindFindings> = Object.create(null);
  for (const r of byKind) {
    const validated = r.valid + r.invalid;
    const errorRate = validated > 0 ? r.invalid / validated : 0;

    // Per-app breakdown for this kind
    const appBreakdown: Record<string, { total: number; valid: number; invalid: number; error_rate: number; status: string }> = Object.create(null);
    for (const m of matrix) {
      if (m.kind === r.kind) {
        const mValidated = m.valid + m.invalid;
        const mRate = mValidated > 0 ? m.invalid / mValidated : 0;
        appBreakdown[m.client_name] = {
          total: m.total, valid: m.valid, invalid: m.invalid,
          error_rate: Math.round(mRate * 10000) / 10000,
          status: computeStatus(m.total, m.invalid),
        };
      }
    }

    // Top errors for this kind
    const kindErrors: Array<{ keyword: string | null; path: string | null; message: string; count: number }> = [];
    for (const v of violations) {
      if (v.kind === r.kind) {
        // Deduplicate across apps — aggregate by keyword+path+message
        const existing = kindErrors.find(
          e => e.keyword === v.error_keyword && e.path === v.error_path && e.message === v.error_message
        );
        if (existing) {
          existing.count += v.count;
        } else {
          kindErrors.push({ keyword: v.error_keyword, path: v.error_path, message: v.error_message, count: v.count });
        }
      }
    }
    kindErrors.sort((a, b) => b.count - a.count);

    findingsByKind[String(r.kind)] = {
      name: KIND_NAMES[r.kind] ?? `Kind ${r.kind}`,
      schema_key: `kind${r.kind}Schema`,
      total: r.total, valid: r.valid, invalid: r.invalid,
      error_rate: Math.round(errorRate * 10000) / 10000,
      top_errors: kindErrors.slice(0, 10),
      by_app: appBreakdown,
    };
  }

  // Build by_app
  const findingsByApp: Record<string, AppFindings> = Object.create(null);
  for (const m of matrix) {
    if (!findingsByApp[m.client_name]) {
      findingsByApp[m.client_name] = {
        total_events: 0, total_valid: 0, total_invalid: 0, error_rate: 0,
        kinds_published: [], violations: [],
      };
    }
    const app = findingsByApp[m.client_name];
    app.total_events += m.total;
    app.total_valid += m.valid;
    app.total_invalid += m.invalid;
    app.kinds_published.push(m.kind);
  }
  // Fill violations and compute error rates
  for (const v of violations) {
    const app = findingsByApp[v.client_name];
    if (app) {
      const samples = v.sample_event_ids ? v.sample_event_ids.split(',') : [];
      app.violations.push({
        kind: v.kind, keyword: v.error_keyword, path: v.error_path,
        message: v.error_message, count: v.count, sample_event_ids: samples,
      });
    }
  }
  for (const app of Object.values(findingsByApp)) {
    const validated = app.total_valid + app.total_invalid;
    app.error_rate = validated > 0 ? Math.round(app.total_invalid / validated * 10000) / 10000 : 0;
    app.kinds_published.sort((a, b) => a - b);
    app.violations.sort((a, b) => b.count - a.count);
  }

  // Build error_patterns
  // Index pubkeys by error_keyword+error_path
  const pubkeyIndex = new Map<string, Array<{ pubkey: string; cnt: number }>>();
  for (const p of pubkeyRows) {
    const key = `${p.error_keyword ?? ''}\0${p.error_path ?? ''}`;
    if (!pubkeyIndex.has(key)) pubkeyIndex.set(key, []);
    pubkeyIndex.get(key)!.push({ pubkey: p.pubkey, cnt: p.cnt });
  }

  // Aggregate violations into error patterns
  const patternMap = new Map<string, ErrorPattern>();
  for (const v of violations) {
    const key = `${v.error_keyword ?? ''}\0${v.error_path ?? ''}\0${v.error_message}`;
    if (!patternMap.has(key)) {
      patternMap.set(key, {
        keyword: v.error_keyword, path: v.error_path, message: v.error_message,
        total_count: 0, affected_kinds: [], affected_apps: [],
        sample_event_ids: [], top_pubkeys: [],
      });
    }
    const p = patternMap.get(key)!;
    p.total_count += v.count;
    if (!p.affected_kinds.includes(v.kind)) p.affected_kinds.push(v.kind);
    if (!p.affected_apps.includes(v.client_name)) p.affected_apps.push(v.client_name);
    const samples = v.sample_event_ids ? v.sample_event_ids.split(',') : [];
    for (const s of samples) {
      if (p.sample_event_ids.length < 3 && !p.sample_event_ids.includes(s)) {
        p.sample_event_ids.push(s);
      }
    }
  }

  const errorPatterns = [...patternMap.values()];
  // Fill top pubkeys
  for (const p of errorPatterns) {
    const pubkeyKey = `${p.keyword ?? ''}\0${p.path ?? ''}`;
    const pubs = pubkeyIndex.get(pubkeyKey) ?? [];
    p.top_pubkeys = pubs.slice(0, 5).map(x => x.pubkey);
  }
  errorPatterns.sort((a, b) => b.total_count - a.total_count);

  return {
    version: 1,
    generated_at: new Date().toISOString(),
    scan_coverage: {
      total_events: total, total_valid: totalValid, total_invalid: totalInvalid, total_no_schema: totalNoSchema,
      kinds_scanned: byKind.map(r => r.kind).sort((a, b) => a - b),
      relays,
      first_event_at: ts(timeRange.first_at),
      last_event_at: ts(timeRange.last_at),
    },
    by_kind: findingsByKind,
    by_app: findingsByApp,
    error_patterns: errorPatterns,
  };
}

// --- HTML dashboard ---

function generateHtml(findings: Findings): string {
  // Escape </script> sequences to prevent XSS breakout from inline <script> tag.
  // Also escape <!-- to prevent HTML comment injection.
  const data = JSON.stringify(findings).replace(/</g, '\\u003c');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sherlock — Nostr Schema Validation Report</title>
<style>
:root { --bg: #fff; --fg: #1a1a1a; --muted: #666; --border: #e0e0e0; --hover: #f5f5f5; --accent: #4a90d9; --green: #22863a; --yellow: #b08800; --red: #cb2431; --badge-bg: #f0f0f0; }
@media(prefers-color-scheme:dark) { :root { --bg: #0d1117; --fg: #c9d1d9; --muted: #8b949e; --border: #30363d; --hover: #161b22; --accent: #58a6ff; --green: #3fb950; --yellow: #d29922; --red: #f85149; --badge-bg: #21262d; } }
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; background: var(--bg); color: var(--fg); line-height: 1.5; max-width: 1200px; margin: 0 auto; padding: 20px; }
h1 { font-size: 1.5rem; margin-bottom: 4px; }
.subtitle { color: var(--muted); font-size: 0.85rem; margin-bottom: 16px; }
.subtitle a { color: var(--accent); text-decoration: none; }
.coverage { display: flex; gap: 24px; flex-wrap: wrap; margin-bottom: 20px; padding: 12px 16px; background: var(--badge-bg); border-radius: 8px; font-size: 0.9rem; }
.coverage .stat { display: flex; flex-direction: column; }
.coverage .stat .label { color: var(--muted); font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.5px; }
.coverage .stat .value { font-weight: 600; font-size: 1.1rem; }
.tabs { display: flex; gap: 0; border-bottom: 2px solid var(--border); margin-bottom: 16px; }
.tab { padding: 8px 20px; cursor: pointer; border: none; background: none; color: var(--muted); font-size: 0.9rem; font-weight: 500; border-bottom: 2px solid transparent; margin-bottom: -2px; }
.tab.active { color: var(--accent); border-bottom-color: var(--accent); }
.tab:hover { color: var(--fg); }
.panel { display: none; }
.panel.active { display: block; }
table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
th { text-align: left; padding: 8px 12px; border-bottom: 2px solid var(--border); color: var(--muted); font-weight: 600; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.5px; }
td { padding: 8px 12px; border-bottom: 1px solid var(--border); vertical-align: top; }
tr:hover { background: var(--hover); }
tr.expandable { cursor: pointer; }
tr.expandable td:first-child::before { content: "▸ "; color: var(--muted); }
tr.expandable.open td:first-child::before { content: "▾ "; }
tr.detail { display: none; }
tr.detail.open { display: table-row; }
tr.detail td { padding-left: 32px; background: var(--hover); }
.status { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 4px; vertical-align: middle; }
.status-y { background: var(--green); }
.status-a { background: var(--yellow); }
.status-n { background: var(--red); }
.status-u { background: var(--muted); }
.mono { font-family: "SFMono-Regular", Consolas, monospace; font-size: 0.8rem; }
.badge { display: inline-block; padding: 1px 6px; border-radius: 4px; background: var(--badge-bg); font-size: 0.75rem; margin: 1px; }
.rate { font-weight: 600; }
.rate-good { color: var(--green); }
.rate-warn { color: var(--yellow); }
.rate-bad { color: var(--red); }
.truncate { max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.copy { cursor: pointer; color: var(--accent); }
.copy:hover { text-decoration: underline; }
.empty { text-align: center; padding: 40px; color: var(--muted); }
</style>
</head>
<body>
<h1>Sherlock — Nostr Schema Validation Report</h1>
<p class="subtitle">Generated ${findings.generated_at.replace('T', ' ').replace(/\.\d+Z$/, ' UTC')} · <a href="${GITHUB_REPO}">Source</a></p>

<div class="coverage" id="coverage"></div>

<div class="tabs">
  <button class="tab active" data-tab="kind">By Kind</button>
  <button class="tab" data-tab="app">By App</button>
  <button class="tab" data-tab="errors">Errors</button>
</div>

<div class="panel active" id="panel-kind"></div>
<div class="panel" id="panel-app"></div>
<div class="panel" id="panel-errors"></div>

<script>
const FINDINGS = ${data};

const KIND_NAMES = ${JSON.stringify(KIND_NAMES)};

function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
function pct(n, t) { return t > 0 ? (n/t*100).toFixed(1) + '%' : '0.0%'; }
function rateClass(rate) { return rate === 0 ? 'rate-good' : rate <= 0.05 ? 'rate-warn' : 'rate-bad'; }
function statusDot(s) { return '<span class="status status-' + s + '" title="' + ({y:'clean',a:'almost',n:'broken',u:'unknown'}[s]||s) + '"></span>'; }
function shortId(id) { return id ? id.slice(0, 8) + '…' : ''; }

// Coverage
(function() {
  const c = FINDINGS.scan_coverage;
  document.getElementById('coverage').innerHTML = [
    stat('Events', c.total_events.toLocaleString()),
    stat('Valid', c.total_valid.toLocaleString()),
    stat('Invalid', c.total_invalid.toLocaleString()),
    stat('No Schema', c.total_no_schema.toLocaleString()),
    stat('Kinds', c.kinds_scanned.length),
    stat('Relays', c.relays.length),
  ].join('');
  function stat(label, value) { return '<div class="stat"><span class="label">' + label + '</span><span class="value">' + value + '</span></div>'; }
})();

// Tabs
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById('panel-' + tab.dataset.tab).classList.add('active');
  });
});

// By Kind
(function() {
  const bk = FINDINGS.by_kind;
  const kinds = Object.keys(bk).sort((a,b) => Number(a) - Number(b));
  if (!kinds.length) { document.getElementById('panel-kind').innerHTML = '<div class="empty">No data</div>'; return; }
  let html = '<table><thead><tr><th>Kind</th><th>Name</th><th>Events</th><th>Valid</th><th>Invalid</th><th>Error Rate</th><th>Top Error</th></tr></thead><tbody>';
  for (const k of kinds) {
    const d = bk[k];
    const topErr = d.top_errors[0];
    const rc = rateClass(d.error_rate);
    html += '<tr class="expandable" data-kind="' + k + '"><td>' + k + '</td><td>' + esc(d.name) + '</td><td>' + d.total.toLocaleString() + '</td><td>' + d.valid.toLocaleString() + '</td><td>' + d.invalid.toLocaleString() + '</td><td class="rate ' + rc + '">' + pct(d.invalid, d.valid + d.invalid) + '</td><td class="truncate mono">' + (topErr ? esc(topErr.keyword + ' @ ' + (topErr.path||'/')) : '—') + '</td></tr>';
    // Detail rows: per-app breakdown
    const apps = Object.keys(d.by_app).sort((a,b) => d.by_app[b].total - d.by_app[a].total);
    for (const app of apps) {
      const a = d.by_app[app];
      html += '<tr class="detail" data-parent="' + k + '"><td></td><td>' + statusDot(a.status) + ' ' + esc(app) + '</td><td>' + a.total.toLocaleString() + '</td><td>' + a.valid.toLocaleString() + '</td><td>' + a.invalid.toLocaleString() + '</td><td class="rate ' + rateClass(a.error_rate) + '">' + pct(a.invalid, a.valid + a.invalid) + '</td><td></td></tr>';
    }
  }
  html += '</tbody></table>';
  document.getElementById('panel-kind').innerHTML = html;
})();

// By App
(function() {
  const ba = FINDINGS.by_app;
  const apps = Object.keys(ba).sort((a,b) => ba[b].total_events - ba[a].total_events);
  if (!apps.length) { document.getElementById('panel-app').innerHTML = '<div class="empty">No data</div>'; return; }
  let html = '<table><thead><tr><th>App</th><th>Events</th><th>Valid</th><th>Invalid</th><th>Error Rate</th><th>Kinds</th></tr></thead><tbody>';
  for (const app of apps) {
    const d = ba[app];
    const rc = rateClass(d.error_rate);
    html += '<tr class="expandable" data-app="' + esc(app) + '"><td>' + esc(app) + '</td><td>' + d.total_events.toLocaleString() + '</td><td>' + d.total_valid.toLocaleString() + '</td><td>' + d.total_invalid.toLocaleString() + '</td><td class="rate ' + rc + '">' + pct(d.total_invalid, d.total_valid + d.total_invalid) + '</td><td>' + d.kinds_published.map(k => '<span class="badge">' + k + '</span>').join('') + '</td></tr>';
    // Detail rows: violations
    for (const v of d.violations.slice(0, 10)) {
      const name = KIND_NAMES[v.kind] || 'kind:' + v.kind;
      html += '<tr class="detail" data-parent="' + esc(app) + '"><td></td><td colspan="2" class="mono">' + esc((v.keyword||'') + ' @ ' + (v.path||'/')) + '</td><td>' + v.count + '</td><td class="mono truncate">' + esc(v.message) + '</td><td class="mono">' + v.sample_event_ids.map(id => '<span class="copy" title="Click to copy ' + id + '" onclick="navigator.clipboard.writeText(\\'' + id + '\\')">' + shortId(id) + '</span>').join(' ') + '</td></tr>';
    }
  }
  html += '</tbody></table>';
  document.getElementById('panel-app').innerHTML = html;
})();

// Errors
(function() {
  const errs = FINDINGS.error_patterns;
  if (!errs.length) { document.getElementById('panel-errors').innerHTML = '<div class="empty">No errors</div>'; return; }
  let html = '<table><thead><tr><th>Error</th><th>Path</th><th>Message</th><th>Count</th><th>Kinds</th><th>Apps</th><th>Top Pubkeys</th></tr></thead><tbody>';
  for (const e of errs.slice(0, 50)) {
    html += '<tr><td class="mono">' + esc(e.keyword||'—') + '</td><td class="mono">' + esc(e.path||'/') + '</td><td class="truncate">' + esc(e.message) + '</td><td>' + e.total_count.toLocaleString() + '</td><td>' + e.affected_kinds.map(k => '<span class="badge">' + k + '</span>').join('') + '</td><td>' + e.affected_apps.map(a => '<span class="badge">' + esc(a) + '</span>').join('') + '</td><td class="mono">' + e.top_pubkeys.map(p => '<span class="copy" title="' + p + '" onclick="navigator.clipboard.writeText(\\'' + p + '\\')">' + p.slice(0,8) + '…</span>').join(' ') + '</td></tr>';
  }
  html += '</tbody></table>';
  document.getElementById('panel-errors').innerHTML = html;
})();

// Expand/collapse rows
document.addEventListener('click', function(e) {
  const row = e.target.closest('tr.expandable');
  if (!row) return;
  const key = row.dataset.kind || row.dataset.app;
  row.classList.toggle('open');
  row.closest('tbody').querySelectorAll('tr.detail[data-parent="' + key + '"]').forEach(r => r.classList.toggle('open'));
});
</script>
</body>
</html>`;
}

// --- Nostr publishing ---

function buildKind1Summary(findings: Findings): string {
  const c = findings.scan_coverage;
  const totalValidated = c.total_valid + c.total_invalid;
  const overallRate = totalValidated > 0 ? (c.total_invalid / totalValidated * 100).toFixed(1) : '0.0';

  let text = `🔍 Sherlock Schema Validation Report\n\n`;
  text += `${c.total_events.toLocaleString()} events scanned across ${c.kinds_scanned.length} kinds\n`;
  text += `✅ ${c.total_valid.toLocaleString()} valid · ❌ ${c.total_invalid.toLocaleString()} invalid (${overallRate}% error rate)\n\n`;

  // Top broken kinds
  const brokenKinds = Object.entries(findings.by_kind)
    .filter(([, v]) => v.invalid > 0)
    .sort(([, a], [, b]) => b.error_rate - a.error_rate)
    .slice(0, 5);

  if (brokenKinds.length > 0) {
    text += `Top issues:\n`;
    for (const [kind, data] of brokenKinds) {
      const ratePct = (data.error_rate * 100).toFixed(1);
      text += `• kind:${kind} (${data.name}): ${data.invalid} invalid (${ratePct}%)\n`;
    }
    text += '\n';
  }

  // Named apps with issues
  const namedApps = Object.entries(findings.by_app)
    .filter(([name, v]) => name !== '_unattributed' && v.total_invalid > 0)
    .sort(([, a], [, b]) => b.total_invalid - a.total_invalid)
    .slice(0, 5);

  if (namedApps.length > 0) {
    text += `Apps with violations:\n`;
    for (const [name, data] of namedApps) {
      text += `• ${name}: ${data.total_invalid} invalid of ${data.total_events}\n`;
    }
    text += '\n';
  }

  text += `Full report: ${GITHUB_REPO}/tree/main/docs`;
  return text;
}

function buildKind30023Content(findings: Findings): string {
  const c = findings.scan_coverage;
  const totalValidated = c.total_valid + c.total_invalid;
  const overallRate = totalValidated > 0 ? (c.total_invalid / totalValidated * 100).toFixed(1) : '0.0';

  let md = `# Sherlock Schema Validation Report\n\n`;
  md += `*Generated: ${findings.generated_at}*\n\n`;
  md += `## Scan Coverage\n\n`;
  md += `| Metric | Value |\n|--------|-------|\n`;
  md += `| Total Events | ${c.total_events.toLocaleString()} |\n`;
  md += `| Valid | ${c.total_valid.toLocaleString()} |\n`;
  md += `| Invalid | ${c.total_invalid.toLocaleString()} (${overallRate}%) |\n`;
  md += `| No Schema | ${c.total_no_schema.toLocaleString()} |\n`;
  md += `| Kinds Scanned | ${c.kinds_scanned.join(', ')} |\n\n`;

  // By Kind table
  md += `## Results by Kind\n\n`;
  md += `| Kind | Name | Events | Valid | Invalid | Error Rate |\n`;
  md += `|------|------|--------|-------|---------|------------|\n`;
  for (const [kind, data] of Object.entries(findings.by_kind).sort(([a], [b]) => Number(a) - Number(b))) {
    const ratePct = (data.error_rate * 100).toFixed(1);
    md += `| ${kind} | ${data.name} | ${data.total.toLocaleString()} | ${data.valid.toLocaleString()} | ${data.invalid.toLocaleString()} | ${ratePct}% |\n`;
  }
  md += '\n';

  // By App — only named apps
  const namedApps = Object.entries(findings.by_app)
    .filter(([name]) => name !== '_unattributed')
    .sort(([, a], [, b]) => b.total_events - a.total_events);

  if (namedApps.length > 0) {
    md += `## Results by App\n\n`;
    md += `| App | Events | Valid | Invalid | Error Rate |\n`;
    md += `|-----|--------|-------|---------|------------|\n`;
    for (const [name, data] of namedApps) {
      const ratePct = (data.error_rate * 100).toFixed(1);
      md += `| ${name} | ${data.total_events.toLocaleString()} | ${data.total_valid.toLocaleString()} | ${data.total_invalid.toLocaleString()} | ${ratePct}% |\n`;
    }
    md += '\n';
  }

  // Top errors
  const topErrors = findings.error_patterns.slice(0, 20);
  if (topErrors.length > 0) {
    md += `## Top Error Patterns\n\n`;
    md += `| Error | Path | Count | Affected Kinds |\n`;
    md += `|-------|------|-------|----------------|\n`;
    for (const e of topErrors) {
      md += `| ${e.keyword || '—'} | \`${e.path || '/'}\` | ${e.total_count.toLocaleString()} | ${e.affected_kinds.join(', ')} |\n`;
    }
    md += '\n';
  }

  md += `---\n\n`;
  md += `[Source & methodology](${GITHUB_REPO}) · Sherlock validates Nostr events against [schemata](https://github.com/nostrability/schemata) JSON Schemas\n`;
  return md;
}

async function publishToNostr(findings: Findings): Promise<void> {
  const nakPath = await which('nak');
  if (!nakPath) {
    console.error('  nak not found — skipping Nostr publish');
    return;
  }

  const secretKey = process.env.NOSTR_SECRET_KEY;
  if (!secretKey) {
    console.error('  NOSTR_SECRET_KEY not set — skipping Nostr publish');
    return;
  }

  const publishRelays = [
    'wss://relay.damus.io',
    'wss://nos.lol',
    'wss://relay.nostr.band',
  ];

  const now = Math.floor(Date.now() / 1000);
  const dateTag = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  // Pass secret key via env (nak reads $NOSTR_SECRET_KEY automatically)
  const nakEnv = { ...process.env, NOSTR_SECRET_KEY: secretKey };

  // Kind 1: short summary
  const kind1Content = buildKind1Summary(findings);
  console.log('  Publishing kind:1 summary...');
  try {
    const kind1Args = [
      'event',
      '-k', '1',
      '-c', kind1Content,
      '-t', 't=sherlock',
      '-t', 't=nostrability',
      ...publishRelays,
    ];
    const result1 = execFileSync(nakPath, kind1Args, { encoding: 'utf-8', timeout: 30000, env: nakEnv });
    console.log('  kind:1 published:', result1.trim().slice(0, 80));
  } catch (err) {
    console.error('  kind:1 publish failed:', (err as Error).message);
  }

  // Kind 30023: long-form article
  const kind30023Content = buildKind30023Content(findings);
  const dTag = `sherlock-report-${dateTag}`;
  console.log('  Publishing kind:30023 report...');
  try {
    const kind30023Args = [
      'event',
      '-k', '30023',
      '-c', kind30023Content,
      '-d', dTag,
      '-t', `title=${`Sherlock Report ${dateTag}`}`,
      '-t', `summary=Nostr schema validation report for ${dateTag}`,
      '-t', `published_at=${String(now)}`,
      '-t', 't=sherlock',
      '-t', 't=nostrability',
      ...publishRelays,
    ];
    const result2 = execFileSync(nakPath, kind30023Args, { encoding: 'utf-8', timeout: 30000, env: nakEnv });
    console.log('  kind:30023 published:', result2.trim().slice(0, 80));
  } catch (err) {
    console.error('  kind:30023 publish failed:', (err as Error).message);
  }
}

// --- Main export command ---

export async function exportCommand(opts: ExportCommandOptions): Promise<void> {
  const outdir = opts.outdir ?? '.';

  console.log('Building findings...');
  const findings = buildFindings();

  // Write JSON
  const jsonPath = resolve(outdir, 'data', 'findings.json');
  mkdirSync(dirname(jsonPath), { recursive: true });
  writeFileSync(jsonPath, JSON.stringify(findings, null, 2) + '\n');
  console.log(`  Wrote ${jsonPath}`);

  // Write HTML
  const htmlPath = resolve(outdir, 'docs', 'index.html');
  mkdirSync(dirname(htmlPath), { recursive: true });
  writeFileSync(htmlPath, generateHtml(findings));
  console.log(`  Wrote ${htmlPath}`);

  // Summary
  const c = findings.scan_coverage;
  console.log(`\nScan coverage: ${c.total_events.toLocaleString()} events, ${c.total_valid.toLocaleString()} valid, ${c.total_invalid.toLocaleString()} invalid`);
  console.log(`Kinds: ${Object.keys(findings.by_kind).length} | Apps: ${Object.keys(findings.by_app).length} | Error patterns: ${findings.error_patterns.length}`);

  // Publish to Nostr (if requested)
  if (opts.publish) {
    console.log('\nPublishing to Nostr...');
    await publishToNostr(findings);
  }
}
