#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, html } from 'diff2html';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TEST_PATTERNS = {
  dotnet: [/(^|\/)Tests?\//, /Tests?\.cs$/i, /\.Tests?\.csproj$/i],
  go: [/_test\.go$/],
  php: [/(^|\/)tests?\//i],
  python: [/(^|\/)tests?\//, /(^|\/)test_[^/]+\.py$/, /[^/]+_test\.py$/, /(^|\/)conftest\.py$/],
  ruby: [/(^|\/)spec\//, /(^|\/)test\//, /_spec\.rb$/, /_test\.rb$/],
};

function parseArgs(argv) {
  const args = { artifactsRoot: '', output: '', languages: [] };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--artifacts-root') args.artifactsRoot = argv[++i] ?? '';
    else if (arg === '--output') args.output = argv[++i] ?? '';
    else if (arg === '--languages') args.languages = (argv[++i] ?? '').split(',').filter(Boolean);
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!args.artifactsRoot || !args.output || args.languages.length === 0) {
    throw new Error('Usage: build-sdk-diff-report.mjs --artifacts-root <dir> --output <file> --languages <csv>');
  }
  return args;
}

function stripLangPrefix(language, filePath) {
  const prefix = `${language}/`;
  return filePath.startsWith(prefix) ? filePath.slice(prefix.length) : filePath;
}

function categorizeFile(language, filePath) {
  const stripped = stripLangPrefix(language, filePath);
  if (stripped.endsWith('.oagen-manifest.json')) return 'manifest';
  const patterns = TEST_PATTERNS[language] ?? [];
  if (patterns.some((p) => p.test(stripped))) return 'test';
  return 'code';
}

function effectiveName(file) {
  if (file.newName && file.newName !== '/dev/null') return file.newName;
  return file.oldName ?? '';
}

function renderLanguageBody(language, diffText) {
  const trimmed = diffText.trim();
  if (!trimmed) {
    return { fileCount: 0, counts: { code: 0, test: 0, manifest: 0 }, body: '<p class="empty">No changes for this language.</p>' };
  }

  const files = parse(trimmed);
  if (files.length === 0) {
    return { fileCount: 0, counts: { code: 0, test: 0, manifest: 0 }, body: '<p class="empty">No changes for this language.</p>' };
  }

  const counts = { code: 0, test: 0, manifest: 0 };
  const blocks = [];

  for (const file of files) {
    const filePath = effectiveName(file);
    const category = categorizeFile(language, filePath);
    counts[category] += 1;

    const fileHtml = html([file], {
      outputFormat: 'side-by-side',
      drawFileList: false,
      matching: 'lines',
    });

    blocks.push(`<div class="diff-file" data-category="${category}">${fileHtml}</div>`);
  }

  return { fileCount: files.length, counts, body: blocks.join('\n') };
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function readDiff(artifactsRoot, language) {
  const diffPath = path.join(artifactsRoot, `oagen-diagnostics-${language}`, 'sdk-code.diff');
  if (!fs.existsSync(diffPath)) return '';
  return fs.readFileSync(diffPath, 'utf8');
}

function readDiff2HtmlCss() {
  return fs.readFileSync(
    path.join(__dirname, '..', 'node_modules', 'diff2html', 'bundles', 'css', 'diff2html.min.css'),
    'utf8',
  );
}

function buildHtml(languageReports) {
  const css = readDiff2HtmlCss();
  const sortedLanguages = [...languageReports].sort((a, b) => a.language.localeCompare(b.language));

  const tabs = sortedLanguages
    .map((entry, idx) => {
      const totals = `${entry.fileCount} file${entry.fileCount === 1 ? '' : 's'}`;
      return `<button type="button" class="tab${idx === 0 ? ' active' : ''}" data-tab="${escapeHtml(entry.language)}">${escapeHtml(entry.language)} <span class="tab-count">${totals}</span></button>`;
    })
    .join('\n');

  const panels = sortedLanguages
    .map((entry, idx) => {
      const summary = `<p class="lang-summary">code: <strong>${entry.counts.code}</strong> · tests: <strong>${entry.counts.test}</strong> · manifest: <strong>${entry.counts.manifest}</strong></p>`;
      const emptyFiltered = '<p class="empty-filtered">All files in this language are hidden by the current filters.</p>';
      return `<section class="tab-panel${idx === 0 ? ' active' : ''}" data-panel="${escapeHtml(entry.language)}">${summary}${entry.body}${emptyFiltered}</section>`;
    })
    .join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>WorkOS SDK code diff report</title>
<style>${css}</style>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; margin: 0; background: #fafbfc; color: #1f2328; }
  header { padding: 16px 24px; background: #fff; border-bottom: 1px solid #d0d7de; position: sticky; top: 0; z-index: 10; }
  header h1 { font-size: 18px; margin: 0 0 12px; }
  .controls { display: flex; flex-wrap: wrap; gap: 16px; align-items: center; }
  .filters { display: flex; gap: 12px; align-items: center; font-size: 13px; }
  .filters label { display: inline-flex; gap: 6px; align-items: center; cursor: pointer; user-select: none; }
  .tabs { display: flex; gap: 4px; flex-wrap: wrap; padding: 0 24px; background: #fff; border-bottom: 1px solid #d0d7de; }
  .tab { background: transparent; border: none; padding: 10px 16px; font-size: 13px; cursor: pointer; border-bottom: 2px solid transparent; color: #57606a; }
  .tab:hover { color: #1f2328; }
  .tab.active { color: #1f2328; border-bottom-color: #fd8c73; font-weight: 600; }
  .tab-count { color: #8c959f; font-weight: 400; font-size: 11px; margin-left: 4px; }
  main { padding: 16px 24px; }
  .tab-panel { display: none; }
  .tab-panel.active { display: block; }
  .lang-summary { font-size: 13px; color: #57606a; margin: 0 0 12px; }
  .diff-file { margin-bottom: 16px; }
  body.hide-test .diff-file[data-category="test"] { display: none; }
  body.hide-manifest .diff-file[data-category="manifest"] { display: none; }
  body.hide-code .diff-file[data-category="code"] { display: none; }
  .empty { color: #57606a; font-style: italic; }
  .empty-filtered { display: none; color: #57606a; font-style: italic; padding: 24px; text-align: center; }
  .tab-panel.all-hidden .empty-filtered { display: block; }
</style>
</head>
<body>
<header>
  <h1>WorkOS SDK code diff report</h1>
  <div class="controls">
    <div class="filters">
      <strong>Show:</strong>
      <label><input type="checkbox" data-filter="code" checked> code</label>
      <label><input type="checkbox" data-filter="test" checked> tests</label>
      <label><input type="checkbox" data-filter="manifest" checked> manifest</label>
    </div>
  </div>
</header>
<nav class="tabs">${tabs}</nav>
<main>
${panels}
</main>
<script>
(function () {
  const tabs = document.querySelectorAll('.tab');
  const panels = document.querySelectorAll('.tab-panel');
  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      const target = tab.dataset.tab;
      tabs.forEach((t) => t.classList.toggle('active', t === tab));
      panels.forEach((p) => p.classList.toggle('active', p.dataset.panel === target));
      updateEmptyState();
    });
  });

  const filters = document.querySelectorAll('input[data-filter]');
  filters.forEach((cb) => {
    cb.addEventListener('change', () => {
      document.body.classList.toggle('hide-' + cb.dataset.filter, !cb.checked);
      updateEmptyState();
    });
  });

  function updateEmptyState() {
    panels.forEach((panel) => {
      if (!panel.classList.contains('active')) { panel.classList.remove('all-hidden'); return; }
      const files = panel.querySelectorAll('.diff-file');
      if (files.length === 0) { panel.classList.remove('all-hidden'); return; }
      const visible = Array.from(files).some((f) => getComputedStyle(f).display !== 'none');
      panel.classList.toggle('all-hidden', !visible);
    });
  }
})();
</script>
</body>
</html>
`;
}

function main() {
  const args = parseArgs(process.argv);
  const reports = [];

  for (const language of args.languages) {
    const diff = readDiff(args.artifactsRoot, language);
    const rendered = renderLanguageBody(language, diff);
    reports.push({ language, ...rendered });
  }

  const html = buildHtml(reports);
  fs.writeFileSync(args.output, html, 'utf8');

  const totals = reports.reduce(
    (acc, r) => {
      acc.files += r.fileCount;
      return acc;
    },
    { files: 0 },
  );

  const reportExists = totals.files > 0;
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `report-exists=${reportExists}\n`);
  }
  console.log(`Wrote ${args.output} (${totals.files} files across ${reports.length} languages)`);
}

main();
