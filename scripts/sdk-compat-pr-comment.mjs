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
    sourceFile: candidateSymbol?.sourceFile ?? baselineSymbol?.sourceFile,
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
 * Merge a source row into a target bucket.  When the same language already
 * exists in the target, the before/after cells are concatenated (the two
 * rows represent different symbols affected by the same spec change in
 * that language, e.g. an options-type field + a model field).
 */
function foldRowInto(target, row) {
  for (const [lang, entry] of Object.entries(row.perLanguage)) {
    const existing = target.perLanguage[lang];
    if (existing) {
      // Combine cells: deduplicate identical references
      const prevSet = new Set(existing.previous.split('<br>'));
      const nowSet = new Set(existing.now.split('<br>'));
      for (const part of entry.previous.split('<br>')) {
        if (part && !prevSet.has(part)) {
          existing.previous += `<br>${part}`;
          prevSet.add(part);
        }
      }
      for (const part of entry.now.split('<br>')) {
        if (part && !nowSet.has(part)) {
          existing.now += `<br>${part}`;
          nowSet.add(part);
        }
      }
    } else {
      target.perLanguage[lang] = { ...entry };
    }
  }
  target.severity = highestSeverity(target.severity, row.severity);
  if (!target.routeKey && row.routeKey) target.routeKey = row.routeKey;
  if (!target.operationId && row.operationId) target.operationId = row.operationId;
  if (!target.service && row.service) target.service = row.service;
  if (!target.detail && row.detail) target.detail = row.detail;
}

/**
 * Merge rows that represent the same spec-level change across languages.
 *
 * Two merge passes:
 *
 * 1. **Category-local merge** — rows with the same change category and
 *    normalized local symbol name are merged when their language sets
 *    don't overlap (original logic).
 *
 * 2. **Cross-category merge** — rows that share a routeKey AND a common
 *    merge hint (the affected field name) are folded together even if
 *    their categories differ and languages overlap.  This catches cases
 *    like a parameter rename in PHP/Ruby being the same spec change as a
 *    field removal in dotnet/Go
 *    (e.g. AdminPortal.generateLink param admin_emails ↔
 *     AdminPortalGenerateLinkOptions.AdminEmails).
 */
/**
 * Pair symbol_removed + symbol_added rows that share an owner type and
 * language set into a single symbol_renamed row.  This collapses the common
 * pattern where a spec field rename surfaces as a removal + addition in
 * languages that use Options/Params types (dotnet, go) while appearing as a
 * parameter rename in languages that use positional args (php, ruby).
 *
 * Only pairs when there is exactly one removal and one addition for a given
 * (owner-type, language-set) combination to avoid false positives.
 */
function pairRemoveAddRows(rows) {
  // Index remove/add rows by normalized (owner-type, language-set) key
  const removeByKey = new Map();
  const addByKey = new Map();

  for (const row of rows) {
    if (row.category !== 'symbol_removed' && row.category !== 'symbol_added') continue;
    const dot = row.symbol.lastIndexOf('.');
    if (dot === -1) continue;
    const owner = row.symbol.substring(0, dot).replace(/_/g, '').toLowerCase();
    const langKey = Object.keys(row.perLanguage).sort().join(',');
    const groupKey = `${owner}:${langKey}`;

    const map = row.category === 'symbol_removed' ? removeByKey : addByKey;
    if (!map.has(groupKey)) map.set(groupKey, []);
    map.get(groupKey).push(row);
  }

  const absorbed = new Set();
  const renamed = [];

  for (const [groupKey, removeRows] of removeByKey) {
    if (removeRows.length !== 1) continue; // ambiguous — skip
    const addRows = addByKey.get(groupKey);
    if (!addRows || addRows.length !== 1) continue; // ambiguous — skip

    const rr = removeRows[0];
    const ar = addRows[0];
    if (absorbed.has(rr) || absorbed.has(ar)) continue;

    absorbed.add(rr);
    absorbed.add(ar);

    const merged = {
      ...rr,
      category: 'symbol_renamed',
      severity: 'breaking',
      perLanguage: {},
      mergeHints: [...new Set([...(rr.mergeHints ?? []), ...(ar.mergeHints ?? [])])],
    };
    if (!merged.routeKey && ar.routeKey) merged.routeKey = ar.routeKey;
    if (!merged.operationId && ar.operationId) merged.operationId = ar.operationId;
    if (!merged.service && ar.service) merged.service = ar.service;

    for (const lang of Object.keys(rr.perLanguage)) {
      merged.perLanguage[lang] = {
        previous: rr.perLanguage[lang]?.previous || '—',
        now: ar.perLanguage[lang]?.now || '—',
      };
    }

    renamed.push(merged);
  }

  return [...rows.filter((r) => !absorbed.has(r)), ...renamed];
}

function mergeRelatedRows(rows) {
  // --- Pass 1: category + local name (existing logic) ---
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.category}:${normalizeLocalName(row.symbol)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  const pass1 = [];
  for (const group of groups.values()) {
    if (group.length === 1) {
      pass1.push(group[0]);
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
        foldRowInto(target, row);
      } else {
        buckets.push(row);
      }
    }
    pass1.push(...buckets);
  }

  // --- Pass 1.5: pair symbol_removed + symbol_added into symbol_renamed ---
  const afterPairing = pairRemoveAddRows(pass1);

  // --- Pass 2: cross-category merge via routeKey + mergeHints ---
  // Only attempt this when rows share a routeKey (same HTTP endpoint)
  // and have a common normalized merge hint (the affected field name).
  const routeGroups = new Map();
  for (const row of afterPairing) {
    if (!row.routeKey) continue;
    for (const hint of row.mergeHints ?? []) {
      const key = `${row.routeKey}:${hint}`;
      if (!routeGroups.has(key)) routeGroups.set(key, []);
      routeGroups.get(key).push(row);
    }
  }

  const absorbed = new Set();
  for (const group of routeGroups.values()) {
    if (group.length <= 1) continue;
    const target = group[0];
    for (let i = 1; i < group.length; i++) {
      const row = group[i];
      if (row === target || absorbed.has(row)) continue;
      foldRowInto(target, row);
      absorbed.add(row);
    }
  }

  // --- Pass 3: absorb non-routeKey rows into unique anchors ---
  // A row without a routeKey (e.g. an Options-type field change) can be
  // folded into a routeKey row (e.g. a service method param change) when
  // they share a merge hint — they represent the same spec-level change
  // surfacing differently across languages.  Only absorb when there is
  // exactly one candidate anchor to avoid ambiguous merges.
  const hintToAnchor = new Map();
  for (const row of afterPairing) {
    if (!row.routeKey || absorbed.has(row)) continue;
    for (const hint of row.mergeHints ?? []) {
      if (hint.length < 4) continue; // skip generic hints like "id"
      if (!hintToAnchor.has(hint)) hintToAnchor.set(hint, new Set());
      hintToAnchor.get(hint).add(row);
    }
  }

  for (const row of afterPairing) {
    if (row.routeKey || absorbed.has(row)) continue;
    const candidates = new Set();
    for (const hint of row.mergeHints ?? []) {
      if (hint.length < 4) continue;
      const anchors = hintToAnchor.get(hint);
      if (anchors) for (const a of anchors) candidates.add(a);
    }
    if (candidates.size === 1) {
      foldRowInto([...candidates][0], row);
      absorbed.add(row);
    }
  }

  return afterPairing.filter((row) => !absorbed.has(row));
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
        mergeHints: [],
        perLanguage: {},
        kind: '',
        signature: '',
      };

      // Collect normalized field names for cross-category merge.
      // The local symbol name (e.g. "AdminEmails" from
      // "AdminPortalGenerateLinkOptions.AdminEmails") and any affected
      // parameter name (e.g. "adminEmails" from a parameter rename)
      // are all normalized so they can match across languages.
      const symbolHint = normalizeLocalName(change.symbol);
      if (symbolHint && !row.mergeHints.includes(symbolHint)) row.mergeHints.push(symbolHint);
      for (const key of ['parameter', 'name']) {
        const oldVal = change.old?.[key];
        if (oldVal && oldVal !== '(removed)' && oldVal !== '(absent)') {
          const hint = normalizeLocalName(oldVal);
          if (hint && !row.mergeHints.includes(hint)) row.mergeHints.push(hint);
        }
        const newVal = change.new?.[key];
        if (newVal && newVal !== '(removed)' && newVal !== '(absent)') {
          const hint = normalizeLocalName(newVal);
          if (hint && !row.mergeHints.includes(hint)) row.mergeHints.push(hint);
        }
      }

      row.severity = highestSeverity(row.severity, change.severity);
      if (!row.routeKey && routeKey) row.routeKey = routeKey;
      if (!row.operationId && meta.operationId) row.operationId = meta.operationId;
      if (!row.service && manifestEntry?.service) row.service = manifestEntry.service;
      if (!row.detail && change.message) row.detail = change.message;
      if (!row.kind && meta.kind) row.kind = meta.kind;
      if (!row.signature && meta.candidateSymbol?.parameters?.length) {
        row.signature = formatParamList(meta.candidateSymbol.parameters);
      }

      const langSourceFile = meta.sourceFile ?? '';
      if (manifestEntries.length > 1) {
        row.perLanguage[entry.language] = {
          previous: formatPreviousState(change, meta.baselineSymbol),
          now: manifestEntries
            .map((item) => formatNowState(change, meta.candidateSymbol, item))
            .filter(Boolean)
            .join('<br><br>'),
          sourceFile: langSourceFile,
        };
      } else if (manifestEntry) {
        row.perLanguage[entry.language] = {
          previous: formatPreviousState(change, meta.baselineSymbol),
          now: formatNowState(change, meta.candidateSymbol, manifestEntry),
          sourceFile: langSourceFile,
        };
      } else {
        row.perLanguage[entry.language] = {
          previous: formatPreviousState(change, meta.baselineSymbol),
          now:
            formatNowState(change, meta.candidateSymbol, undefined) ||
            (routeKey ? `manifest entry missing for ${routeKey}` : 'non-operation symbol'),
          sourceFile: langSourceFile,
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

const KIND_LABELS = {
  service_accessor: 'service',
  callable: 'function',
  constructor: 'constructor',
  field: 'field',
  property: 'property',
  enum: 'enum',
  enum_member: 'enum value',
  alias: 'type',
};

function kindLabel(kind) {
  return KIND_LABELS[kind] ?? '';
}

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

/** Render changes as per-change blocks with before/after code samples.
 *  Rows that share the same symbol + category are collapsed into a single
 *  table so that e.g. three param removals on one method render as one block.
 */
function renderChangeBlocks(lines, rows, languages) {
  // Group rows by symbol + category
  const groups = [];
  const groupIndex = new Map();
  for (const row of rows) {
    const key = `${row.symbol}:${row.category}`;
    let idx = groupIndex.get(key);
    if (idx === undefined) {
      idx = groups.length;
      groupIndex.set(key, idx);
      groups.push([]);
    }
    groups[idx].push(row);
  }

  for (const group of groups) {
    const first = group[0];

    // Collect all active languages across the group
    const activeLangs = languages.filter((lang) => group.some((r) => r.perLanguage[lang]));
    if (activeLangs.length === 0) continue;

    const kl = kindLabel(first.kind);
    const kindTag = kl ? ` _(${kl})_` : '';
    const desc = `\`${first.symbol}\` ${categoryVerb(first.category)}${kindTag}`;
    const route = first.routeKey ? ` — \`${first.routeKey}\`` : '';
    lines.push(`**${desc}**${route}`);
    lines.push('');
    lines.push('| Language | Before | After |');
    lines.push('| --- | --- | --- |');

    for (const lang of activeLangs) {
      const befores = [];
      const afters = [];
      const sourceFiles = new Set();
      for (const row of group) {
        const entry = row.perLanguage[lang];
        if (!entry) continue;
        if (entry.sourceFile) sourceFiles.add(entry.sourceFile);
        if (entry.previous && entry.previous !== '—') befores.push(entry.previous);
        if (entry.now && entry.now !== '—') afters.push(entry.now);
      }
      const before = befores.length > 0 ? befores.join('<br>') : '—';
      const after = afters.length > 0 ? afters.join('<br>') : '—';
      const fileSuffix = sourceFiles.size > 0 ? `<br>📄 ${[...sourceFiles].join(', ')}` : '';
      lines.push(`| ${lang}${fileSuffix} | ${escapeCell(before)} | ${escapeCell(after)} |`);
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

/** Render additive section: grouped by service with method signatures. */
function renderCompactSection(lines, title, rows, languages) {
  lines.push('<details>');
  lines.push(`<summary><h3>${title} (${rows.length})</h3></summary>`);
  lines.push('');

  // Group by service
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

  function renderAdditiveGroup(groupRows) {
    const methods = groupRows.filter((r) => r.kind === 'callable');
    const others = groupRows.filter((r) => r.kind !== 'callable');

    if (methods.length > 0) {
      for (const row of methods) {
        const affected = languages.filter((lang) => row.perLanguage[lang]);
        const langStr = affected.length === languages.length ? 'all' : affected.join(', ');
        const sig = row.signature ? `(${row.signature})` : '';
        lines.push(`- \`${row.symbol}${sig}\` _(function)_ — ${langStr}`);
      }
      lines.push('');
    }

    if (others.length > 0) {
      lines.push('| Change | Languages |');
      lines.push('| --- | --- |');
      for (const row of others) {
        const affected = languages.filter((lang) => row.perLanguage[lang]);
        const langStr = affected.length === languages.length ? 'all' : affected.join(', ');
        const kl = kindLabel(row.kind);
        const kindTag = kl ? ` _(${kl})_` : '';
        lines.push(`| ${escapeCell(`\`${row.symbol}\` ${categoryVerb(row.category)}${kindTag}`)} | ${langStr} |`);
      }
      lines.push('');
    }
  }

  for (const [service, serviceRows] of [...byService].sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(`#### ${service}`);
    lines.push('');
    renderAdditiveGroup(serviceRows);
  }

  if (noService.length > 0) {
    if (byService.size > 0) {
      lines.push('#### Other');
      lines.push('');
    }
    renderAdditiveGroup(noService);
  }

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
