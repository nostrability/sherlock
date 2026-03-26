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
  getAttributionSummary,
  getPubkeyDistribution,
  getTagFrequency,
  getSampleEvents,
  getAppTrend,
  getAllAppTrends,
} from '../db/index.js';
import { KIND_NAMES, STATUS_THRESHOLDS, GITHUB_REPO, DEFAULT_KINDS } from '../config.js';
import { which } from '../util.js';

// --- Types ---

interface KindFindings {
  name: string;
  schema_key: string;
  total: number; valid: number; invalid: number; error_rate: number;
  top_errors: Array<{ keyword: string | null; path: string | null; message: string; count: number }>;
  semantic_warnings: Array<{ check_name: string; message: string; count: number }>;
  by_app: Record<string, { total: number; valid: number; invalid: number; error_rate: number; status: string; attribution_method?: string }>;
  unique_pubkeys: number;
}

interface AppFindings {
  total_events: number; total_valid: number; total_invalid: number; error_rate: number;
  kinds_published: number[];
  unique_pubkeys: number;
  is_widespread: boolean;
  attribution_method?: string;
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

interface TrendDataPoint {
  date: string;
  error_rate: number;
  events: number;
  invalid: number;
}

interface AppTrend {
  direction: 'improving' | 'worsening' | 'stable' | 'insufficient_data';
  data_points: TrendDataPoint[];
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
  attribution_summary: Record<string, number>;
  by_kind: Record<string, KindFindings>;
  by_app: Record<string, AppFindings>;
  error_patterns: ErrorPattern[];
  trends: { by_app: Record<string, AppTrend> };
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

function computeTrendDirection(dataPoints: TrendDataPoint[]): AppTrend['direction'] {
  if (dataPoints.length < 6) return 'insufficient_data';

  const recent = dataPoints.slice(-3);
  const previous = dataPoints.slice(-6, -3);

  const avgRecent = recent.reduce((sum, d) => sum + d.error_rate, 0) / recent.length;
  const avgPrevious = previous.reduce((sum, d) => sum + d.error_rate, 0) / previous.length;

  if (avgPrevious === 0 && avgRecent === 0) return 'stable';
  if (avgPrevious === 0) return 'worsening';

  const change = (avgRecent - avgPrevious) / avgPrevious;
  if (change < -0.20) return 'improving';
  if (change > 0.20) return 'worsening';
  return 'stable';
}

function buildFindings(): Findings {
  getDb(); // ensure initialized

  const total = getTotalEvents();
  const byKind = getEventCountsByKind();
  const matrix = getAppKindMatrix();
  const violations = getViolationDetails();
  const pubkeyRows = getTopPubkeysForErrors();
  const timeRange = getTimeRange();
  const relays = getDistinctRelays();
  const attrSummary = getAttributionSummary();
  const pubkeyDist = getPubkeyDistribution();

  // Attribution summary as object
  const attributionSummary: Record<string, number> = {};
  for (const row of attrSummary) {
    attributionSummary[row.method] = row.count;
  }

  // Index pubkey distribution by client_name+kind
  const pubkeyIndex2 = new Map<string, number>();
  for (const row of pubkeyDist) {
    pubkeyIndex2.set(`${row.client_name}\0${row.kind}`, row.unique_pubkeys);
  }

  // Aggregate totals
  let totalValid = 0, totalInvalid = 0, totalNoSchema = 0;
  for (const r of byKind) {
    totalValid += r.valid;
    totalInvalid += r.invalid;
    totalNoSchema += r.no_schema;
  }

  // Build by_kind
  const findingsByKind: Record<string, KindFindings> = {};
  for (const r of byKind) {
    const validated = r.valid + r.invalid;
    const errorRate = validated > 0 ? r.invalid / validated : 0;

    // Per-app breakdown for this kind
    const appBreakdown: Record<string, { total: number; valid: number; invalid: number; error_rate: number; status: string; attribution_method?: string }> = {};
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

    // Top errors for this kind (schema validation errors)
    const kindErrors: Array<{ keyword: string | null; path: string | null; message: string; count: number }> = [];
    const semanticWarnings: Array<{ check_name: string; message: string; count: number }> = [];

    for (const v of violations) {
      if (v.kind === r.kind) {
        // Separate semantic warnings from schema errors
        const isSemantic = v.error_keyword && (
          v.error_keyword.startsWith('kind0_') ||
          v.error_keyword.startsWith('kind3_') ||
          v.error_keyword.startsWith('kind10002_') ||
          v.error_keyword.startsWith('kind9735_') ||
          v.error_keyword === 'future_timestamp' ||
          v.error_keyword === 'timestamp_too_old'
        );

        if (isSemantic) {
          const existing = semanticWarnings.find(w => w.check_name === v.error_keyword && w.message === v.error_message);
          if (existing) {
            existing.count += v.count;
          } else {
            semanticWarnings.push({ check_name: v.error_keyword!, message: v.error_message, count: v.count });
          }
        } else {
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
    }
    kindErrors.sort((a, b) => b.count - a.count);
    semanticWarnings.sort((a, b) => b.count - a.count);

    // Count unique pubkeys for this kind
    let kindPubkeys = 0;
    for (const [key, count] of pubkeyIndex2) {
      if (key.endsWith(`\0${r.kind}`)) kindPubkeys += count;
    }

    findingsByKind[String(r.kind)] = {
      name: KIND_NAMES[r.kind] ?? `Kind ${r.kind}`,
      schema_key: `kind${r.kind}Schema`,
      total: r.total, valid: r.valid, invalid: r.invalid,
      error_rate: Math.round(errorRate * 10000) / 10000,
      top_errors: kindErrors.slice(0, 10),
      semantic_warnings: semanticWarnings.slice(0, 10),
      by_app: appBreakdown,
      unique_pubkeys: kindPubkeys,
    };
  }

  // Build by_app
  const findingsByApp: Record<string, AppFindings> = {};
  for (const m of matrix) {
    if (!findingsByApp[m.client_name]) {
      findingsByApp[m.client_name] = {
        total_events: 0, total_valid: 0, total_invalid: 0, error_rate: 0,
        kinds_published: [], unique_pubkeys: 0, is_widespread: false,
        violations: [],
      };
    }
    const app = findingsByApp[m.client_name];
    app.total_events += m.total;
    app.total_valid += m.valid;
    app.total_invalid += m.invalid;
    app.kinds_published.push(m.kind);

    // Add pubkey count for this app+kind
    const pk = pubkeyIndex2.get(`${m.client_name}\0${m.kind}`) ?? 0;
    app.unique_pubkeys += pk;
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
  for (const [, app] of Object.entries(findingsByApp)) {
    const validated = app.total_valid + app.total_invalid;
    app.error_rate = validated > 0 ? Math.round(app.total_invalid / validated * 10000) / 10000 : 0;
    app.kinds_published.sort((a, b) => a - b);
    app.violations.sort((a, b) => b.count - a.count);
    // Widespread = many unique pubkeys (>10 suggests client bug, not individual misconfiguration)
    app.is_widespread = app.unique_pubkeys > 10;
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

  // Build trends
  const trendsByApp: Record<string, AppTrend> = {};
  const allApps = Object.keys(findingsByApp);
  for (const appName of allApps) {
    const rawTrend = getAppTrend(appName);
    const dataPoints: TrendDataPoint[] = rawTrend.map(t => ({
      date: t.period,
      error_rate: t.error_rate,
      events: t.total,
      invalid: t.invalid,
    }));
    trendsByApp[appName] = {
      direction: computeTrendDirection(dataPoints),
      data_points: dataPoints,
    };
  }

  return {
    version: 2,
    generated_at: new Date().toISOString(),
    scan_coverage: {
      total_events: total, total_valid: totalValid, total_invalid: totalInvalid, total_no_schema: totalNoSchema,
      kinds_scanned: byKind.map(r => r.kind).sort((a, b) => a - b),
      relays,
      first_event_at: ts(timeRange.first_at),
      last_event_at: ts(timeRange.last_at),
    },
    attribution_summary: attributionSummary,
    by_kind: findingsByKind,
    by_app: findingsByApp,
    error_patterns: errorPatterns,
    trends: { by_app: trendsByApp },
  };
}

// --- HTML dashboard ---

function generateHtml(findings: Findings): string {
  // Escape for safe embedding in HTML: replace </ to prevent </script> breakout
  const data = JSON.stringify(findings).replace(/</g, '\\u003c');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sherlock — Nostr Schema Validation Report</title>
<style>
:root { --bg: #fff; --fg: #1a1a1a; --muted: #666; --border: #e0e0e0; --hover: #f5f5f5; --accent: #4a90d9; --green: #22863a; --yellow: #b08800; --red: #cb2431; --badge-bg: #f0f0f0; --warn-bg: #fff8e1; }
@media(prefers-color-scheme:dark) { :root { --bg: #0d1117; --fg: #c9d1d9; --muted: #8b949e; --border: #30363d; --hover: #161b22; --accent: #58a6ff; --green: #3fb950; --yellow: #d29922; --red: #f85149; --badge-bg: #21262d; --warn-bg: #2d2200; } }
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
tr.expandable td:first-child::before { content: "\\25b8 "; color: var(--muted); }
tr.expandable.open td:first-child::before { content: "\\25be "; }
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
.badge-method { font-size: 0.65rem; padding: 0 4px; }
.badge-warn { background: var(--warn-bg); color: var(--yellow); }
.badge-pubkey { font-size: 0.7rem; color: var(--muted); margin-left: 4px; }
.rate { font-weight: 600; }
.rate-good { color: var(--green); }
.rate-warn { color: var(--yellow); }
.rate-bad { color: var(--red); }
.truncate { max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.copy { cursor: pointer; color: var(--accent); }
.copy:hover { text-decoration: underline; }
.empty { text-align: center; padding: 40px; color: var(--muted); }
.sparkline { display: inline-flex; align-items: flex-end; gap: 1px; height: 24px; vertical-align: middle; }
.sparkline span { display: inline-block; width: 4px; min-height: 1px; background: var(--accent); border-radius: 1px 1px 0 0; }
.sparkline span.bar-bad { background: var(--red); }
.sparkline span.bar-warn { background: var(--yellow); }
.sparkline span.bar-good { background: var(--green); }
.trend-arrow { font-weight: 700; margin-left: 4px; }
.trend-improving { color: var(--green); }
.trend-worsening { color: var(--red); }
.trend-stable { color: var(--muted); }
.trend-insufficient { color: var(--muted); font-style: italic; }
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
  <button class="tab" data-tab="trends">Trends</button>
</div>

<div class="panel active" id="panel-kind"></div>
<div class="panel" id="panel-app"></div>
<div class="panel" id="panel-errors"></div>
<div class="panel" id="panel-trends"></div>

<script>
var FINDINGS = ${data};

var KIND_NAMES = ${JSON.stringify(KIND_NAMES)};

function esc(s) { if (s == null) return ''; var d = document.createElement('div'); d.textContent = String(s); return d.innerHTML; }
function pct(n, t) { return t > 0 ? (n/t*100).toFixed(1) + '%' : '0.0%'; }
function rateClass(rate) { return rate === 0 ? 'rate-good' : rate <= 0.05 ? 'rate-warn' : 'rate-bad'; }
function statusDot(s) { return '<span class="status status-' + s + '" title="' + ({y:'clean',a:'almost',n:'broken',u:'unknown'}[s]||s) + '"></span>'; }
function shortId(id) { return id ? id.slice(0, 8) + '\\u2026' : ''; }
function methodBadge(m) {
  if (!m) return '';
  var labels = {client_tag:'tag',nip89_pubkey:'nip89',fingerprint:'fp'};
  return ' <span class="badge badge-method">' + (labels[m]||m) + '</span>';
}
function trendArrow(dir) {
  var arrows = {improving:'\\u2193',worsening:'\\u2191',stable:'\\u2192',insufficient_data:'?'};
  var cls = 'trend-' + (dir === 'insufficient_data' ? 'insufficient' : dir);
  return '<span class="trend-arrow ' + cls + '">' + (arrows[dir]||'?') + '</span>';
}
function sparkline(points) {
  if (!points || !points.length) return '';
  var maxRate = 0;
  for (var i=0;i<points.length;i++) { if (points[i].error_rate > maxRate) maxRate = points[i].error_rate; }
  if (maxRate === 0) maxRate = 1;
  var html = '<span class="sparkline">';
  var recent = points.slice(-30);
  for (var i=0;i<recent.length;i++) {
    var h = Math.max(1, Math.round(recent[i].error_rate / maxRate * 24));
    var cls = recent[i].error_rate === 0 ? 'bar-good' : recent[i].error_rate <= 0.05 ? 'bar-warn' : 'bar-bad';
    html += '<span class="' + cls + '" style="height:' + h + 'px" title="' + esc(recent[i].date) + ': ' + (recent[i].error_rate*100).toFixed(1) + '%"></span>';
  }
  html += '</span>';
  return html;
}
function copyText(text) { navigator.clipboard.writeText(text); }

// Coverage
(function() {
  var c = FINDINGS.scan_coverage;
  var a = FINDINGS.attribution_summary || {};
  var attrParts = Object.keys(a).filter(function(k){return k!=='unattributed'}).map(function(k){return k + ': ' + a[k]});
  var attrText = attrParts.length ? attrParts.join(', ') : 'none';
  document.getElementById('coverage').innerHTML = [
    stat('Events', c.total_events.toLocaleString()),
    stat('Valid', c.total_valid.toLocaleString()),
    stat('Invalid', c.total_invalid.toLocaleString()),
    stat('No Schema', c.total_no_schema.toLocaleString()),
    stat('Kinds', c.kinds_scanned.length),
    stat('Relays', c.relays.length),
    stat('Attributed', attrText),
  ].join('');
  function stat(label, value) { return '<div class="stat"><span class="label">' + label + '</span><span class="value">' + value + '</span></div>'; }
})();

// Tabs
document.querySelectorAll('.tab').forEach(function(tab) {
  tab.addEventListener('click', function() {
    document.querySelectorAll('.tab').forEach(function(t) { t.classList.remove('active'); });
    document.querySelectorAll('.panel').forEach(function(p) { p.classList.remove('active'); });
    tab.classList.add('active');
    document.getElementById('panel-' + tab.dataset.tab).classList.add('active');
  });
});

// By Kind
(function() {
  var bk = FINDINGS.by_kind;
  var kinds = Object.keys(bk).sort(function(a,b) { return Number(a) - Number(b); });
  if (!kinds.length) { document.getElementById('panel-kind').innerHTML = '<div class="empty">No data</div>'; return; }
  var html = '<table><thead><tr><th>Kind</th><th>Name</th><th>Events</th><th>Valid</th><th>Invalid</th><th>Error Rate</th><th>Top Error</th></tr></thead><tbody>';
  for (var ki = 0; ki < kinds.length; ki++) {
    var k = kinds[ki];
    var d = bk[k];
    var topErr = d.top_errors[0];
    var rc = rateClass(d.error_rate);
    var warnCount = d.semantic_warnings ? d.semantic_warnings.reduce(function(s,w){return s+w.count},0) : 0;
    var warnBadge = warnCount > 0 ? ' <span class="badge badge-warn">' + warnCount + ' warns</span>' : '';
    var pkBadge = d.unique_pubkeys ? '<span class="badge-pubkey">' + d.unique_pubkeys + ' pubkeys</span>' : '';
    html += '<tr class="expandable" data-kind="' + k + '"><td>' + k + '</td><td>' + esc(d.name) + warnBadge + '</td><td>' + d.total.toLocaleString() + ' ' + pkBadge + '</td><td>' + d.valid.toLocaleString() + '</td><td>' + d.invalid.toLocaleString() + '</td><td class="rate ' + rc + '">' + pct(d.invalid, d.valid + d.invalid) + '</td><td class="truncate mono">' + (topErr ? esc(topErr.keyword + ' @ ' + (topErr.path||'/')) : '\\u2014') + '</td></tr>';
    // Detail rows: per-app breakdown
    var apps = Object.keys(d.by_app).sort(function(a,b) { return d.by_app[b].total - d.by_app[a].total; });
    for (var ai = 0; ai < apps.length; ai++) {
      var app = apps[ai];
      var a = d.by_app[app];
      html += '<tr class="detail" data-parent="' + k + '"><td></td><td>' + statusDot(a.status) + ' ' + esc(app) + methodBadge(a.attribution_method) + '</td><td>' + a.total.toLocaleString() + '</td><td>' + a.valid.toLocaleString() + '</td><td>' + a.invalid.toLocaleString() + '</td><td class="rate ' + rateClass(a.error_rate) + '">' + pct(a.invalid, a.valid + a.invalid) + '</td><td></td></tr>';
    }
    // Semantic warning detail rows
    if (d.semantic_warnings && d.semantic_warnings.length) {
      for (var wi = 0; wi < d.semantic_warnings.length; wi++) {
        var w = d.semantic_warnings[wi];
        html += '<tr class="detail" data-parent="' + k + '"><td></td><td colspan="4" class="mono"><span class="badge badge-warn">warn</span> ' + esc(w.check_name) + ': ' + esc(w.message) + '</td><td>' + w.count + '</td><td></td></tr>';
      }
    }
  }
  html += '</tbody></table>';
  document.getElementById('panel-kind').innerHTML = html;
})();

// By App
(function() {
  var ba = FINDINGS.by_app;
  var trends = FINDINGS.trends ? FINDINGS.trends.by_app : {};
  var apps = Object.keys(ba).sort(function(a,b) { return ba[b].total_events - ba[a].total_events; });
  if (!apps.length) { document.getElementById('panel-app').innerHTML = '<div class="empty">No data</div>'; return; }
  var html = '<table><thead><tr><th>App</th><th>Events</th><th>Valid</th><th>Invalid</th><th>Error Rate</th><th>Trend</th><th>Kinds</th></tr></thead><tbody>';
  for (var ai = 0; ai < apps.length; ai++) {
    var app = apps[ai];
    var d = ba[app];
    var rc = rateClass(d.error_rate);
    var appId = 'app-' + ai;
    var pkBadge = d.unique_pubkeys ? '<span class="badge-pubkey">' + d.unique_pubkeys + ' pubkeys</span>' : '';
    var trend = trends[app];
    var trendHtml = trend ? trendArrow(trend.direction) + ' ' + sparkline(trend.data_points) : '';
    html += '<tr class="expandable" data-app="' + appId + '"><td>' + esc(app) + methodBadge(d.attribution_method) + '</td><td>' + d.total_events.toLocaleString() + ' ' + pkBadge + '</td><td>' + d.total_valid.toLocaleString() + '</td><td>' + d.total_invalid.toLocaleString() + '</td><td class="rate ' + rc + '">' + pct(d.total_invalid, d.total_valid + d.total_invalid) + '</td><td>' + trendHtml + '</td><td>' + d.kinds_published.map(function(k) { return '<span class="badge">' + k + '</span>'; }).join('') + '</td></tr>';
    // Detail rows: violations
    for (var vi = 0; vi < Math.min(d.violations.length, 10); vi++) {
      var v = d.violations[vi];
      var name = KIND_NAMES[v.kind] || 'kind:' + v.kind;
      html += '<tr class="detail" data-parent="' + appId + '"><td></td><td colspan="2" class="mono">' + esc((v.keyword||'') + ' @ ' + (v.path||'/')) + '</td><td>' + v.count + '</td><td class="mono truncate">' + esc(v.message) + '</td><td></td><td class="mono">' + v.sample_event_ids.map(function(id) { return '<span class="copy" data-copy="' + esc(id) + '" title="Click to copy ' + esc(id) + '">' + shortId(id) + '</span>'; }).join(' ') + '</td></tr>';
    }
  }
  html += '</tbody></table>';
  document.getElementById('panel-app').innerHTML = html;
})();

// Errors
(function() {
  var errs = FINDINGS.error_patterns;
  if (!errs.length) { document.getElementById('panel-errors').innerHTML = '<div class="empty">No errors</div>'; return; }
  var html = '<table><thead><tr><th>Error</th><th>Path</th><th>Message</th><th>Count</th><th>Kinds</th><th>Apps</th><th>Top Pubkeys</th></tr></thead><tbody>';
  for (var i = 0; i < Math.min(errs.length, 50); i++) {
    var e = errs[i];
    html += '<tr><td class="mono">' + esc(e.keyword||'\\u2014') + '</td><td class="mono">' + esc(e.path||'/') + '</td><td class="truncate">' + esc(e.message) + '</td><td>' + e.total_count.toLocaleString() + '</td><td>' + e.affected_kinds.map(function(k) { return '<span class="badge">' + k + '</span>'; }).join('') + '</td><td>' + e.affected_apps.map(function(a) { return '<span class="badge">' + esc(a) + '</span>'; }).join('') + '</td><td class="mono">' + e.top_pubkeys.map(function(p) { return '<span class="copy" data-copy="' + esc(p) + '" title="' + esc(p) + '">' + p.slice(0,8) + '\\u2026</span>'; }).join(' ') + '</td></tr>';
  }
  html += '</tbody></table>';
  document.getElementById('panel-errors').innerHTML = html;
})();

// Trends
(function() {
  var trends = FINDINGS.trends ? FINDINGS.trends.by_app : {};
  var apps = Object.keys(trends).filter(function(a) { return trends[a].data_points.length > 0; });
  apps.sort(function(a,b) {
    var da = {improving:0,worsening:1,stable:2,insufficient_data:3};
    var diff = (da[trends[a].direction]||3) - (da[trends[b].direction]||3);
    if (diff !== 0) return diff;
    return trends[b].data_points.length - trends[a].data_points.length;
  });
  if (!apps.length) { document.getElementById('panel-trends').innerHTML = '<div class="empty">No trend data yet. Run multiple scans to see trends.</div>'; return; }
  var html = '<table><thead><tr><th>App</th><th>Direction</th><th>Sparkline (last 30d)</th><th>Latest Error Rate</th><th>Data Points</th></tr></thead><tbody>';
  for (var i = 0; i < apps.length; i++) {
    var app = apps[i];
    var t = trends[app];
    var last = t.data_points[t.data_points.length - 1];
    var latestRate = last ? last.error_rate : 0;
    html += '<tr><td>' + esc(app) + '</td><td>' + trendArrow(t.direction) + ' ' + esc(t.direction) + '</td><td>' + sparkline(t.data_points) + '</td><td class="rate ' + rateClass(latestRate) + '">' + (latestRate*100).toFixed(1) + '%</td><td>' + t.data_points.length + '</td></tr>';
  }
  html += '</tbody></table>';
  document.getElementById('panel-trends').innerHTML = html;
})();

// Expand/collapse rows + copy handler (delegated)
document.addEventListener('click', function(e) {
  // Copy handler
  var copyEl = e.target.closest('.copy[data-copy]');
  if (copyEl) {
    navigator.clipboard.writeText(copyEl.dataset.copy);
    return;
  }
  // Expand/collapse
  var row = e.target.closest('tr.expandable');
  if (!row) return;
  var key = row.dataset.kind || row.dataset.app;
  row.classList.toggle('open');
  row.closest('tbody').querySelectorAll('tr.detail[data-parent="' + key + '"]').forEach(function(r) { r.classList.toggle('open'); });
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
