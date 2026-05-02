#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

function parseArgs(argv) {
  const args = {
    artifactsRoot: '',
    output: '',
    buildResult: 'unknown',
    runId: '',
    repo: '',
    codeDiffAvailable: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--artifacts-root') {
      args.artifactsRoot = argv[++i] ?? '';
    } else if (arg === '--output') {
      args.output = argv[++i] ?? '';
    } else if (arg === '--build-result') {
      args.buildResult = argv[++i] ?? 'unknown';
    } else if (arg === '--run-id') {
      args.runId = argv[++i] ?? '';
    } else if (arg === '--repo') {
      args.repo = argv[++i] ?? '';
    } else if (arg === '--code-diff-available') {
      args.codeDiffAvailable = (argv[++i] ?? '') === 'true';
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (!args.artifactsRoot || !args.output) {
    throw new Error('Usage: sdk-compat-pr-comment.mjs --artifacts-root <dir> --output <file> [--build-result <result>] [--run-id <id>] [--repo <owner/name>] [--code-diff-available true|false]');
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

// ---------------------------------------------------------------------------
// Domain inference and compact rendering helpers
// ---------------------------------------------------------------------------

/**
 * Build a function that maps each row to a logical API domain.
 *
 * Resolution order:
 * 1. row.service (set from the manifest for callable symbols)
 * 2. Prefix-match the symbol root against known service names
 * 3. Fall back to the symbol root itself (part before the first dot),
 *    consolidated so that if root A is a prefix of root B both map to A.
 *    e.g. DirectoryUser & DirectoryUserWithGroups → DirectoryUser;
 *         EventSchema & EventSchemaContext → EventSchema.
 */
function buildDomainResolver(rows) {
  const services = new Set();
  for (const row of rows) {
    if (row.service) services.add(row.service);
  }
  const sortedServices = [...services].sort((a, b) => b.length - a.length);

  // Collect every root (pre-dot component) and consolidate: when one root
  // is a strict prefix of another, the longer one maps to the shorter.
  const roots = new Set();
  for (const row of rows) {
    const root = row.symbol.split('.')[0];
    if (root) roots.add(root);
  }

  const rootToDomain = new Map();
  const sortedRoots = [...roots].sort((a, b) => a.length - b.length);
  for (const root of roots) {
    let best = root;
    for (const shorter of sortedRoots) {
      if (shorter.length >= root.length) break;
      if (root.startsWith(shorter)) {
        best = shorter;
        break;
      }
    }
    rootToDomain.set(root, best);
  }

  return function deriveDomain(row) {
    if (row.service) return row.service;
    const root = row.symbol.split('.')[0];
    for (const svc of sortedServices) {
      if (root.startsWith(svc)) return svc;
    }
    return rootToDomain.get(root) ?? (root || 'Other');
  };
}

const SUPER_CATEGORIES = {
  symbol_removed: 'removed',
  symbol_renamed: 'renamed',
  symbol_added: 'added',
  parameter_removed: 'params',
  parameter_renamed: 'params',
  parameter_type_narrowed: 'params',
  parameter_requiredness_increased: 'params',
  parameter_position_changed_order_sensitive: 'params',
  parameter_added_optional_terminal: 'params',
  parameter_added_non_terminal_optional: 'params',
  constructor_position_changed_order_sensitive: 'params',
  constructor_reordered_named_friendly: 'params',
  field_type_changed: 'type_changed',
  return_type_changed: 'type_changed',
  enum_member_value_changed: 'type_changed',
};

function superCategory(category) {
  return SUPER_CATEGORIES[category] ?? 'other';
}

/**
 * Extract a compact description of a parameter change from a row,
 * parsing the formatted per-language cells for parameter and position info.
 */
function describeParamChange(row) {
  const firstEntry = Object.values(row.perLanguage)[0];
  if (!firstEntry) return categoryVerb(row.category);

  const oldParamMatch = firstEntry.previous?.match(/parameter:\s*`([^`]+)`/);
  const newParamMatch = firstEntry.now?.match(/parameter:\s*`([^`]+)`/);
  const param = oldParamMatch?.[1] ?? newParamMatch?.[1];

  if (!param) return categoryVerb(row.category);

  if (row.category.includes('removed')) return `\`${param}\` removed`;
  if (row.category.includes('renamed')) {
    const newParam = newParamMatch?.[1];
    if (newParam && newParam !== param) return `\`${param}\` → \`${newParam}\``;
    return `\`${param}\` renamed`;
  }
  if (row.category.includes('position') || row.category.includes('reordered')) {
    const oldPos = firstEntry.previous?.match(/position:\s*`(\d+)`/)?.[1];
    const newPos = firstEntry.now?.match(/position:\s*`(\d+)`/)?.[1];
    if (oldPos && newPos) return `\`${param}\` moved ${oldPos}\u2192${newPos}`;
    return `\`${param}\` reordered`;
  }
  if (row.category.includes('type')) {
    const oldType = firstEntry.previous?.match(/type:\s*`([^`]+)`/)?.[1];
    const newType = firstEntry.now?.match(/type:\s*`([^`]+)`/)?.[1];
    if (oldType && newType) return `\`${param}\` type: \`${oldType}\` \u2192 \`${newType}\``;
    return `\`${param}\` type changed`;
  }
  if (row.category.includes('required')) return `\`${param}\` now required`;
  if (row.category.includes('added')) return `\`${param}\` added`;

  return `\`${param}\` ${categoryVerb(row.category)}`;
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

/** Render breaking / soft-risk section: grouped by domain, then by change type. */
function renderDetailedSection(lines, title, rows, languages, open, deriveDomain) {
  lines.push(`<details${open ? ' open' : ''}>`);
  lines.push(`<summary><h3>${title} (${rows.length})</h3></summary>`);
  lines.push('');

  if (!deriveDomain) deriveDomain = buildDomainResolver(rows);

  const byDomain = new Map();
  for (const row of rows) {
    const domain = deriveDomain(row);
    if (!byDomain.has(domain)) byDomain.set(domain, []);
    byDomain.get(domain).push(row);
  }

  for (const [domain, domainRows] of byDomain) {
    lines.push(`#### ${domain}`);
    lines.push('');

    const removed = domainRows.filter((r) => superCategory(r.category) === 'removed');
    const renamed = domainRows.filter((r) => superCategory(r.category) === 'renamed');
    const params = domainRows.filter((r) => superCategory(r.category) === 'params');
    const typeChanged = domainRows.filter((r) => superCategory(r.category) === 'type_changed');
    const other = domainRows.filter((r) => {
      const sc = superCategory(r.category);
      return sc !== 'removed' && sc !== 'renamed' && sc !== 'params' && sc !== 'type_changed';
    });

    renderRemovedRows(lines, removed, languages);
    renderRenamedRows(lines, renamed, languages);
    renderParamChangeRows(lines, params, languages);
    renderTypeChangeRows(lines, typeChanged, languages);
    if (other.length > 0) {
      renderChangeBlocks(lines, other, languages);
    }
  }

  lines.push('</details>');
  lines.push('');
}

/** Render additive section: grouped by domain with method signatures. */
function renderCompactSection(lines, title, rows, languages, deriveDomain) {
  lines.push('<details>');
  lines.push(`<summary><h3>${title} (${rows.length})</h3></summary>`);
  lines.push('');

  // Group by domain (matches the detailed section grouping)
  if (!deriveDomain) deriveDomain = buildDomainResolver(rows);
  const byDomain = new Map();
  for (const row of rows) {
    const domain = deriveDomain(row);
    if (!byDomain.has(domain)) byDomain.set(domain, []);
    byDomain.get(domain).push(row);
  }

  function formatAdditiveLangs(row) {
    const affected = languages.filter((lang) => row.perLanguage[lang]);
    if (affected.length === languages.length && affected.every((lang) => !row.perLanguage[lang]?.sourceFile)) {
      return 'all';
    }
    return affected
      .map((lang) => {
        const sf = row.perLanguage[lang]?.sourceFile;
        return sf ? `${lang}<br>📄 ${sf}` : lang;
      })
      .join('<br>');
  }

  function renderAdditiveGroup(groupRows) {
    lines.push('| Change | Languages |');
    lines.push('| --- | --- |');
    for (const row of groupRows) {
      const kl = kindLabel(row.kind);
      const kindTag = kl ? ` _(${kl})_` : '';
      const sig = row.kind === 'callable' && row.signature ? `(${row.signature})` : '';
      lines.push(`| ${escapeCell(`\`${row.symbol}${sig}\` ${categoryVerb(row.category)}${kindTag}`)} | ${escapeCell(formatAdditiveLangs(row))} |`);
    }
    lines.push('');
  }

  for (const [domain, domainRows] of [...byDomain].sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(`#### ${domain}`);
    lines.push('');
    renderAdditiveGroup(domainRows);
  }

  lines.push('</details>');
  lines.push('');
}

// ---------------------------------------------------------------------------
// Compact sub-renderers (used by the improved renderDetailedSection)
// ---------------------------------------------------------------------------

/** Render removed rows compactly: methods as a table, types/fields in a collapsible table. */
function renderRemovedRows(lines, rows, languages) {
  if (rows.length === 0) return;

  const methods = rows.filter(
    (r) => r.kind === 'callable' || r.kind === 'constructor' || r.kind === 'service_accessor',
  );
  const others = rows.filter((r) => !methods.includes(r));

  if (methods.length > 0) {
    lines.push(`**Removed methods** (${methods.length})`);
    lines.push('');
    lines.push('| Method | Languages |');
    lines.push('| --- | --- |');
    for (const row of methods) {
      const langs = Object.keys(row.perLanguage).sort().join(', ');
      const sig = row.signature ? `(${row.signature})` : '';
      lines.push(`| \`${row.symbol}${sig}\` | ${langs} |`);
    }
    lines.push('');
  }

  if (others.length > 0) {
    const kindCounts = {};
    for (const row of others) {
      const k = kindLabel(row.kind) || 'symbol';
      kindCounts[k] = (kindCounts[k] || 0) + 1;
    }
    const kindsDesc = Object.entries(kindCounts)
      .map(([k, c]) => `${c} ${k}${c !== 1 ? 's' : ''}`)
      .join(', ');

    lines.push(`<details>`);
    lines.push(`<summary><strong>${kindsDesc} removed</strong></summary>`);
    lines.push('');
    lines.push('| Symbol | Kind | Languages |');
    lines.push('| --- | --- | --- |');
    for (const row of others) {
      const kl = kindLabel(row.kind) || 'symbol';
      const langs = Object.keys(row.perLanguage).sort().join(', ');
      lines.push(`| \`${row.symbol}\` | ${kl} | ${langs} |`);
    }
    lines.push('');
    lines.push('</details>');
    lines.push('');
  }
}

/** Render renamed rows as a compact before/after table. */
function renderRenamedRows(lines, rows, languages) {
  if (rows.length === 0) return;

  lines.push(`**Renamed** (${rows.length})`);
  lines.push('');
  lines.push('| Symbol | Before | After | Languages |');
  lines.push('| --- | --- | --- | --- |');

  for (const row of rows) {
    const langs = Object.keys(row.perLanguage).sort().join(', ');
    const firstEntry = Object.values(row.perLanguage)[0];
    const before = extractRef(firstEntry?.previous);
    const after = extractRef(firstEntry?.now);
    lines.push(
      `| \`${row.symbol}\` | ${escapeCell(before)} | ${escapeCell(after)} | ${langs} |`,
    );
  }
  lines.push('');
}

/** Render parameter changes grouped by parent method — one row per method. */
function renderParamChangeRows(lines, rows, languages) {
  if (rows.length === 0) return;

  const byMethod = new Map();
  for (const row of rows) {
    if (!byMethod.has(row.symbol)) byMethod.set(row.symbol, []);
    byMethod.get(row.symbol).push(row);
  }

  lines.push(`**Parameter changes** (${rows.length})`);
  lines.push('');
  lines.push('| Method | Changes | Languages |');
  lines.push('| --- | --- | --- |');

  for (const [method, methodRows] of byMethod) {
    const descriptions = methodRows.map((r) => describeParamChange(r));
    const langs = new Set();
    for (const r of methodRows) {
      for (const lang of Object.keys(r.perLanguage)) langs.add(lang);
    }
    lines.push(
      `| \`${method}\` | ${escapeCell(descriptions.join('; '))} | ${[...langs].sort().join(', ')} |`,
    );
  }
  lines.push('');
}

/** Render type/field/enum changes using the existing Before/After block format. */
function renderTypeChangeRows(lines, rows, languages) {
  if (rows.length === 0) return;

  lines.push(`**Type changes** (${rows.length})`);
  lines.push('');
  renderChangeBlocks(lines, rows, languages);
}

/** Render a domain-grouped summary table showing change counts per API domain. */
function renderDomainSummary(lines, rows, languages, deriveDomain) {
  if (!deriveDomain) deriveDomain = buildDomainResolver(rows);
  const domainData = new Map();

  for (const row of rows) {
    const domain = deriveDomain(row);
    if (!domainData.has(domain)) {
      domainData.set(domain, { breaking: 0, softRisk: 0, additive: 0, languages: new Set() });
    }
    const d = domainData.get(domain);
    if (row.severity === 'breaking') d.breaking++;
    else if (row.severity === 'soft-risk') d.softRisk++;
    else d.additive++;
    for (const lang of Object.keys(row.perLanguage)) d.languages.add(lang);
  }

  const sorted = [...domainData.entries()].sort((a, b) => {
    const totalA = a[1].breaking * 100 + a[1].softRisk * 10 + a[1].additive;
    const totalB = b[1].breaking * 100 + b[1].softRisk * 10 + b[1].additive;
    return totalB - totalA;
  });

  lines.push('### Changes by domain');
  lines.push('');
  lines.push('| Domain | Breaking | Soft-risk | Additive | Languages |');
  lines.push('| --- | --- | --- | --- | --- |');

  for (const [domain, data] of sorted) {
    const b = data.breaking || '\u2014';
    const s = data.softRisk || '\u2014';
    const a = data.additive || '\u2014';
    const langs =
      data.languages.size === languages.length ? 'all' : [...data.languages].sort().join(', ');
    lines.push(`| ${domain} | ${b} | ${s} | ${a} | ${langs} |`);
  }
  lines.push('');
}

// ---------------------------------------------------------------------------
// Main renderer
// ---------------------------------------------------------------------------

function renderMarkdown(languageData, options) {
  const { buildResult, runId, repo, codeDiffAvailable } = options;
  const rollup = buildRollup(languageData);
  const lines = [];

  lines.push('<!-- sdk-validation-comment -->');
  lines.push('## SDK compatibility report');
  lines.push('');

  if (buildResult !== 'success') {
    lines.push(`:x: Matrix result: \`${buildResult}\``);
    lines.push('');
  }

  if (codeDiffAvailable && runId && repo) {
    lines.push(
      `📄 Full code diff: [download report](https://github.com/${repo}/actions/runs/${runId}#artifacts) — open \`sdk-diff-report.html\` from the \`sdk-code-diff-report\` artifact.`,
    );
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

  // Build domain resolver once from all rows so type-only domains (e.g.
  // EventSchema) are correctly grouped even when they have no service field.
  const deriveDomain = buildDomainResolver(rollup.rows);

  lines.push('');

  renderDomainSummary(lines, rollup.rows, rollup.languages, deriveDomain);

  if (breaking.length > 0) {
    renderDetailedSection(lines, 'Breaking', breaking, rollup.languages, true, deriveDomain);
  }
  if (softRisk.length > 0) {
    renderDetailedSection(lines, 'Soft-risk', softRisk, rollup.languages, false, deriveDomain);
  }
  if (additive.length > 0) {
    renderCompactSection(lines, 'Additive', additive, rollup.languages, deriveDomain);
  }

  return lines.join('\n') + '\n';
}

function main() {
  const args = parseArgs(process.argv);
  const artifactDirs = listArtifactDirs(args.artifactsRoot);
  const languageData = artifactDirs.map(buildLanguageData);
  const markdown = renderMarkdown(languageData, {
    buildResult: args.buildResult,
    runId: args.runId,
    repo: args.repo,
    codeDiffAvailable: args.codeDiffAvailable,
  });
  fs.writeFileSync(args.output, markdown, 'utf8');
}

main();
