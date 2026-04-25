#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

function parseArgs(argv) {
  const args = { artifactsRoot: '', output: '', buildResult: 'unknown' };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--artifacts-root') {
      args.artifactsRoot = argv[++i] ?? '';
    } else if (arg === '--output') {
      args.output = argv[++i] ?? '';
    } else if (arg === '--build-result') {
      args.buildResult = argv[++i] ?? 'unknown';
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (!args.artifactsRoot || !args.output) {
    throw new Error('Usage: sdk-compat-pr-comment.mjs --artifacts-root <dir> --output <file> [--build-result <result>]');
  }

  return args;
}

function exists(filePath) {
  return fs.existsSync(filePath);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readOperationsMap(dirPath) {
  const manifestPath = path.join(dirPath, '.oagen-manifest.json');
  if (!exists(manifestPath)) return new Map();

  const parsed = readJson(manifestPath);
  const operations = parsed?.operations;
  if (!operations || typeof operations !== 'object') return new Map();

  const map = new Map();
  for (const [httpKey, rawValue] of Object.entries(operations)) {
    const values = Array.isArray(rawValue) ? rawValue : [rawValue];
    map.set(
      httpKey,
      values
        .map((value) => ({
          sdkMethod: value?.sdkMethod ?? '',
          service: value?.service ?? '',
        }))
        .filter((value) => value.sdkMethod || value.service),
    );
  }

  return map;
}

function listArtifactDirs(root) {
  if (!exists(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(root, entry.name))
    .sort();
}

function inferLanguage(dirPath, report) {
  if (report?.language && report.language !== 'unknown') return report.language;

  const base = path.basename(dirPath);
  const prefix = 'oagen-diagnostics-';
  return base.startsWith(prefix) ? base.slice(prefix.length) : base;
}

function buildSymbolIndex(snapshot) {
  const byFqName = new Map();
  for (const symbol of snapshot?.symbols ?? []) {
    const entries = byFqName.get(symbol.fqName) ?? [];
    entries.push(symbol);
    byFqName.set(symbol.fqName, entries);
  }
  return byFqName;
}

function firstSymbol(index, candidates) {
  for (const candidate of candidates) {
    if (!candidate || candidate === '(removed)' || candidate === '(absent)') continue;
    const matches = index.get(candidate);
    if (matches?.length) return matches[0];
  }
  return undefined;
}

function pickSymbolMeta(change, baselineIndex, candidateIndex) {
  const baselineSymbol = firstSymbol(baselineIndex, [change.old?.name, change.old?.symbol, change.symbol]);
  const candidateSymbol = firstSymbol(candidateIndex, [change.new?.name, change.new?.symbol, change.symbol]);
  const matches = [candidateSymbol, baselineSymbol].filter(Boolean);

  const routeMatch = matches.find((symbol) => symbol?.route);
  const anyMatch = matches[0];

  return {
    baselineSymbol,
    candidateSymbol,
    route: routeMatch?.route,
    operationId: routeMatch?.operationId ?? anyMatch?.operationId,
    kind: routeMatch?.kind ?? anyMatch?.kind,
  };
}

function highestSeverity(left, right) {
  const rank = { breaking: 3, 'soft-risk': 2, additive: 1 };
  return rank[right] > rank[left] ? right : left;
}

function formatDetail(change) {
  if (change.message) return change.message;

  const parts = [];
  for (const key of Object.keys(change.old ?? {})) {
    const oldValue = change.old[key];
    const newValue = change.new?.[key];
    if (newValue && oldValue !== newValue) {
      parts.push(`${key}: ${oldValue} -> ${newValue}`);
    }
  }

  return parts.join(', ') || change.category;
}

function escapeCell(value) {
  return String(value).replace(/\|/g, '\\|').replace(/\n/g, '<br>');
}

function formatParamList(parameters) {
  if (!parameters?.length) return '';
  const params = parameters.map((p) => (p.required ? p.publicName : `${p.publicName}?`));
  if (params.length <= 5) return params.join(', ');
  return params.slice(0, 4).join(', ') + ', \u2026';
}

function formatSymbolReference(symbol) {
  if (!symbol?.fqName) return '';
  if (symbol.kind === 'callable' || symbol.kind === 'constructor') {
    const params = formatParamList(symbol.parameters);
    return `\`${symbol.fqName}(${params})\``;
  }
  return `\`${symbol.fqName}\``;
}

function formatPreviousState(change, baselineSymbol) {
  const lines = [];

  const symbolRef = formatSymbolReference(baselineSymbol);
  if (symbolRef) {
    lines.push(symbolRef);
  } else if (change.old?.name && change.old.name !== '(removed)') {
    lines.push(`\`${change.old.name}\``);
  } else if (change.old?.symbol && change.old.symbol !== '(removed)' && change.old.symbol !== '(absent)') {
    lines.push(`\`${change.old.symbol}\``);
  } else if (change.symbol) {
    lines.push(`\`${change.symbol}\``);
  }

  const details = [];
  for (const [key, value] of Object.entries(change.old ?? {})) {
    if (key === 'name' || key === 'symbol') continue;
    if (value === '(removed)' || value === '(absent)') continue;
    details.push(`${key}: \`${value}\``);
  }
  if (details.length > 0) lines.push(details.join('<br>'));

  return lines.join('<br>') || '—';
}

function formatNowState(change, candidateSymbol, manifestEntry) {
  const lines = [];

  if (manifestEntry) {
    const params = formatParamList(candidateSymbol?.parameters);
    lines.push(`\`${manifestEntry.service}.${manifestEntry.sdkMethod}(${params})\``);
  } else {
    const symbolRef = formatSymbolReference(candidateSymbol);
    if (symbolRef) {
      lines.push(symbolRef);
    } else if (change.new?.name && change.new.name !== '(removed)') {
      lines.push(`\`${change.new.name}\``);
    } else if (change.new?.symbol && change.new.symbol !== '(removed)' && change.new.symbol !== '(absent)') {
      lines.push(`\`${change.new.symbol}\``);
    }
  }

  const details = [];
  for (const [key, value] of Object.entries(change.new ?? {})) {
    if (key === 'name' || key === 'symbol') continue;
    if (value === '(removed)' || value === '(absent)') continue;
    details.push(`${key}: \`${value}\``);
  }
  if (details.length > 0) lines.push(details.join('<br>'));

  return lines.join('<br>') || '—';
}

function buildLanguageData(dirPath) {
  const reportPath = path.join(dirPath, 'compat-report.json');
  const baselinePath = path.join(dirPath, '.oagen-compat-snapshot.json');
  const candidatePath = path.join(dirPath, 'sdk', '.oagen-compat-snapshot.json');

  if (!exists(reportPath)) {
    return {
      language: inferLanguage(dirPath, null),
      missing: 'compat-report.json missing',
    };
  }

  const report = readJson(reportPath);
  const baseline = exists(baselinePath) ? readJson(baselinePath) : { symbols: [] };
  const candidate = exists(candidatePath) ? readJson(candidatePath) : { symbols: [] };
  const operationsMap = readOperationsMap(path.join(dirPath, 'sdk'));

  return {
    language: inferLanguage(dirPath, report),
    report,
    baselineIndex: buildSymbolIndex(baseline),
    candidateIndex: buildSymbolIndex(candidate),
    operationsMap,
  };
}

/**
 * Extract the local symbol name (part after the last dot) and normalize it
 * for cross-language comparison.  AdminEmails, admin_emails, adminEmails
 * all become "adminemails".
 */
function normalizeLocalName(symbol) {
  const local = symbol.includes('.') ? symbol.split('.').pop() : symbol;
  return local.replace(/_/g, '').toLowerCase();
}

/**
 * Merge rows that represent the same spec-level change across languages.
 *
 * Different languages produce different conceptualChangeIds for the same
 * underlying change (e.g. AdminPortalGenerateLinkOptions.AdminEmails in
 * dotnet vs GenerateLink.admin_emails in Ruby).  This pass collapses them
 * into a single row when:
 *  - they share the same change category
 *  - their normalized local symbol names match
 *  - their language sets don't overlap (no two entries for the same lang)
 */
function mergeRelatedRows(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.category}:${normalizeLocalName(row.symbol)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  const result = [];
  for (const group of groups.values()) {
    if (group.length === 1) {
      result.push(group[0]);
      continue;
    }

    // Greedy merge: try to fold each row into an existing bucket whose
    // language set doesn't overlap.  Rows that can't merge into any
    // bucket start a new one (they represent genuinely distinct changes
    // that happen to share a local name, e.g. admin_emails on two
    // different models).
    const buckets = [];
    for (const row of group) {
      const rowLangs = new Set(Object.keys(row.perLanguage));
      let target = null;
      for (const bucket of buckets) {
        const hasOverlap = [...rowLangs].some((lang) => bucket.perLanguage[lang]);
        if (!hasOverlap) {
          target = bucket;
          break;
        }
      }

      if (target) {
        for (const [lang, entry] of Object.entries(row.perLanguage)) {
          target.perLanguage[lang] = entry;
        }
        target.severity = highestSeverity(target.severity, row.severity);
        if (!target.routeKey && row.routeKey) target.routeKey = row.routeKey;
        if (!target.operationId && row.operationId) target.operationId = row.operationId;
        if (!target.service && row.service) target.service = row.service;
        if (!target.detail && row.detail) target.detail = row.detail;
      } else {
        buckets.push(row);
      }
    }
    result.push(...buckets);
  }

  return result;
}

function buildRollup(languageData) {
  const languages = languageData.map((entry) => entry.language).sort();
  const rows = new Map();
  const missingLanguages = [];

  for (const entry of languageData) {
    if (entry.missing) {
      missingLanguages.push({ language: entry.language, reason: entry.missing });
      continue;
    }

    for (const change of entry.report.changes ?? []) {
      const meta = pickSymbolMeta(change, entry.baselineIndex, entry.candidateIndex);
      const routeKey = meta.route ? `${String(meta.route.method).toUpperCase()} ${meta.route.path}` : '';
      const manifestEntries = routeKey ? (entry.operationsMap.get(routeKey) ?? []) : [];
      const manifestEntry = manifestEntries[0];
      const row = rows.get(change.conceptualChangeId) ?? {
        id: change.conceptualChangeId,
        severity: change.severity,
        category: change.category,
        detail: formatDetail(change),
        routeKey,
        operationId: meta.operationId ?? '',
        service: manifestEntry?.service ?? '',
        symbol: change.symbol,
        perLanguage: {},
      };

      row.severity = highestSeverity(row.severity, change.severity);
      if (!row.routeKey && routeKey) row.routeKey = routeKey;
      if (!row.operationId && meta.operationId) row.operationId = meta.operationId;
      if (!row.service && manifestEntry?.service) row.service = manifestEntry.service;
      if (!row.detail && change.message) row.detail = change.message;

      if (manifestEntries.length > 1) {
        row.perLanguage[entry.language] = {
          previous: formatPreviousState(change, meta.baselineSymbol),
          now: manifestEntries
            .map((item) => formatNowState(change, meta.candidateSymbol, item))
            .filter(Boolean)
            .join('<br><br>'),
        };
      } else if (manifestEntry) {
        row.perLanguage[entry.language] = {
          previous: formatPreviousState(change, meta.baselineSymbol),
          now: formatNowState(change, meta.candidateSymbol, manifestEntry),
        };
      } else {
        row.perLanguage[entry.language] = {
          previous: formatPreviousState(change, meta.baselineSymbol),
          now:
            formatNowState(change, meta.candidateSymbol, undefined) ||
            (routeKey ? `manifest entry missing for ${routeKey}` : 'non-operation symbol'),
        };
      }

      rows.set(change.conceptualChangeId, row);
    }
  }

  const mergedRows = mergeRelatedRows([...rows.values()]);

  return {
    languages,
    missingLanguages,
    rows: mergedRows.sort((left, right) => {
      const severityOrder = { breaking: 0, 'soft-risk': 1, additive: 2 };
      const severityDiff = severityOrder[left.severity] - severityOrder[right.severity];
      if (severityDiff !== 0) return severityDiff;
      return `${left.service} ${left.routeKey} ${left.symbol}`.localeCompare(`${right.service} ${right.routeKey} ${right.symbol}`);
    }),
  };
}

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

const CATEGORY_VERBS = {
  symbol_removed: 'removed',
  symbol_added: 'added',
  symbol_renamed: 'renamed',
  parameter_removed: 'param removed',
  parameter_added_optional_terminal: 'optional param added',
  parameter_added_non_terminal_optional: 'optional param added',
  parameter_renamed: 'param renamed',
  parameter_type_narrowed: 'param type changed',
  parameter_requiredness_increased: 'param now required',
  parameter_position_changed_order_sensitive: 'param reordered',
  constructor_position_changed_order_sensitive: 'ctor param reordered',
  constructor_reordered_named_friendly: 'ctor reordered (named-friendly)',
  field_type_changed: 'type changed',
  return_type_changed: 'return type changed',
  enum_member_value_changed: 'enum value changed',
};

function categoryVerb(category) {
  return CATEGORY_VERBS[category] ?? category.replace(/_/g, ' ');
}

/** Pull the first backtick-wrapped reference out of a formatted cell. */
function extractRef(formatted) {
  if (!formatted || formatted === '—') return '—';
  const match = formatted.match(/`([^`]+)`/);
  if (!match) return formatted.split('<br>')[0] || '—';
  const inner = match[1];
  if (inner === '(removed)' || inner === '(absent)') return '—';
  return `\`${inner}\``;
}

/** One compact cell per language in the detailed table. */
function compactCell(entry) {
  if (!entry) return '—';
  const prev = extractRef(entry.previous);
  const now = extractRef(entry.now);
  if (prev === '—' && now === '—') return '—';
  if (prev === '—') return now;
  if (now === '—') return prev;
  return `${prev} → ${now}`;
}

/** Render changes as per-change blocks with before/after code samples. */
function renderChangeBlocks(lines, rows, languages) {
  for (const row of rows) {
    const activeLangs = languages.filter((lang) => row.perLanguage[lang]);
    if (activeLangs.length === 0) continue;

    const desc = `\`${row.symbol}\` ${categoryVerb(row.category)}`;
    const route = row.routeKey ? ` — \`${row.routeKey}\`` : '';
    lines.push(`**${desc}**${route}`);
    lines.push('');
    lines.push('| Language | Before | After |');
    lines.push('| --- | --- | --- |');

    for (const lang of activeLangs) {
      const entry = row.perLanguage[lang];
      const before = entry.previous || '—';
      const after = entry.now || '—';
      lines.push(`| ${lang} | ${escapeCell(before)} | ${escapeCell(after)} |`);
    }
    lines.push('');
  }
}

/** Render breaking / soft-risk section: grouped by service, with route shown inline. */
function renderDetailedSection(lines, title, rows, languages, open) {
  lines.push(`<details${open ? ' open' : ''}>`);
  lines.push(`<summary><h3>${title} (${rows.length})</h3></summary>`);
  lines.push('');

  const byService = new Map();
  const noService = [];
  for (const row of rows) {
    if (row.service) {
      if (!byService.has(row.service)) byService.set(row.service, []);
      byService.get(row.service).push(row);
    } else {
      noService.push(row);
    }
  }

  for (const [service, serviceRows] of byService) {
    lines.push(`#### ${service}`);
    lines.push('');
    renderChangeBlocks(lines, serviceRows, languages);
  }

  if (noService.length > 0) {
    if (byService.size > 0) {
      lines.push('#### Other changes');
      lines.push('');
    }
    renderChangeBlocks(lines, noService, languages);
  }

  lines.push('</details>');
  lines.push('');
}

/** Render additive section: compact list with language coverage. */
function renderCompactSection(lines, title, rows, languages) {
  lines.push('<details>');
  lines.push(`<summary><h3>${title} (${rows.length})</h3></summary>`);
  lines.push('');

  lines.push('| Change | Languages |');
  lines.push('| --- | --- |');

  for (const row of rows) {
    const affected = languages.filter((lang) => row.perLanguage[lang]);
    const langStr = affected.length === languages.length ? 'all' : affected.join(', ');
    lines.push(`| ${escapeCell(`\`${row.symbol}\` ${categoryVerb(row.category)}`)} | ${langStr} |`);
  }

  lines.push('');
  lines.push('</details>');
  lines.push('');
}

// ---------------------------------------------------------------------------
// Main renderer
// ---------------------------------------------------------------------------

function renderMarkdown(languageData, buildResult) {
  const rollup = buildRollup(languageData);
  const lines = [];

  lines.push('<!-- sdk-validation-comment -->');
  lines.push('## SDK compatibility report');
  lines.push('');

  if (buildResult !== 'success') {
    lines.push(`:x: Matrix result: \`${buildResult}\``);
    lines.push('');
  }

  lines.push('| Language | Breaking | Soft-risk | Additive |');
  lines.push('| --- | --- | --- | --- |');
  for (const entry of [...languageData].sort((left, right) => left.language.localeCompare(right.language))) {
    if (entry.missing) {
      lines.push(`| ${entry.language} | n/a | n/a | n/a |`);
      continue;
    }

    const summary = entry.report.summary ?? { breaking: 0, softRisk: 0, additive: 0 };
    lines.push(`| ${entry.language} | ${summary.breaking} | ${summary.softRisk} | ${summary.additive} |`);
  }

  if (rollup.missingLanguages.length > 0) {
    lines.push('');
    lines.push('### Missing diagnostics');
    lines.push('');
    for (const missing of rollup.missingLanguages) {
      lines.push(`- ${missing.language}: ${missing.reason}`);
    }
  }

  if (rollup.rows.length === 0) {
    lines.push('');
    lines.push('No compatibility changes detected.');
    return lines.join('\n') + '\n';
  }

  const breaking = rollup.rows.filter((r) => r.severity === 'breaking');
  const softRisk = rollup.rows.filter((r) => r.severity === 'soft-risk');
  const additive = rollup.rows.filter((r) => r.severity === 'additive');

  lines.push('');

  if (breaking.length > 0) {
    renderDetailedSection(lines, 'Breaking', breaking, rollup.languages, true);
  }
  if (softRisk.length > 0) {
    renderDetailedSection(lines, 'Soft-risk', softRisk, rollup.languages, false);
  }
  if (additive.length > 0) {
    renderCompactSection(lines, 'Additive', additive, rollup.languages);
  }

  return lines.join('\n') + '\n';
}

function main() {
  const args = parseArgs(process.argv);
  const artifactDirs = listArtifactDirs(args.artifactsRoot);
  const languageData = artifactDirs.map(buildLanguageData);
  const markdown = renderMarkdown(languageData, args.buildResult);
  fs.writeFileSync(args.output, markdown, 'utf8');
}

main();
