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

function titleCaseCategory(category) {
  return String(category)
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
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

function formatSymbolReference(symbol) {
  if (!symbol?.fqName) return '';
  if (symbol.kind === 'callable' || symbol.kind === 'constructor') return `\`${symbol.fqName}(...)\``;
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
    lines.push(`\`${manifestEntry.service}.${manifestEntry.sdkMethod}(...)\``);
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
        symbol: change.symbol,
        perLanguage: {},
      };

      row.severity = highestSeverity(row.severity, change.severity);
      if (!row.routeKey && routeKey) row.routeKey = routeKey;
      if (!row.operationId && meta.operationId) row.operationId = meta.operationId;
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

  return {
    languages,
    missingLanguages,
    rows: [...rows.values()].sort((left, right) => {
      const severityOrder = { breaking: 0, 'soft-risk': 1, additive: 2 };
      const severityDiff = severityOrder[left.severity] - severityOrder[right.severity];
      if (severityDiff !== 0) return severityDiff;
      return `${left.routeKey} ${left.symbol}`.localeCompare(`${right.routeKey} ${right.symbol}`);
    }),
  };
}

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

  const groupedRows = new Map();
  for (const row of rollup.rows) {
    const entries = groupedRows.get(row.category) ?? [];
    entries.push(row);
    groupedRows.set(row.category, entries);
  }

  lines.push('');

  for (const [category, rows] of groupedRows) {
    lines.push(`### ${titleCaseCategory(category)}`);
    lines.push('');

    for (const row of rows) {
      if (row.routeKey) {
        lines.push(`#### \`${row.routeKey}\``);
      } else {
        lines.push(`#### \`${row.symbol}\``);
      }
      lines.push('');
      lines.push(row.detail || row.symbol);
      lines.push('');

      if (row.operationId) {
        lines.push(`operationId: \`${row.operationId}\``);
        lines.push('');
      }

      lines.push('| Language | Previous | Now |');
      lines.push('| --- | --- | --- |');
      for (const language of rollup.languages) {
        const entry = row.perLanguage[language];
        lines.push(`| ${language} | ${escapeCell(entry?.previous ?? '—')} | ${escapeCell(entry?.now ?? '—')} |`);
      }
      lines.push('');
    }
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
