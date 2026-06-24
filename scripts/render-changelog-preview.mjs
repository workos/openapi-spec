#!/usr/bin/env node
//
// render-changelog-preview.mjs
//
// Render the changelog scoped to a staged service set, using the SAME
// renderChangelogMarkdown logic generate-prs.yml uses — so the dashboard's
// "Generate staged" preview matches what would ship. Reads the `entries` JSON
// from `sdk-release-metadata.mjs --format json` and keeps only the entries whose
// scope belongs to one of the requested services, then prints markdown.
//
//   node scripts/render-changelog-preview.mjs --entries <entries.json> --services "SSO,Vault"

import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { publicScopeFromService, renderChangelogMarkdown } from "./sdk-release-metadata.mjs";

function parseArgs(argv) {
  const args = { entries: "", services: "" };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--entries") args.entries = argv[++i] ?? "";
    else if (arg === "--services") args.services = argv[++i] ?? "";
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!args.entries) {
    throw new Error("Usage: render-changelog-preview.mjs --entries <entries.json> [--services <csv>]");
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv);
  const entries = existsSync(args.entries) ? JSON.parse(readFileSync(args.entries, "utf8")) : [];
  const staged = String(args.services ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const scopes = new Set(staged.map((s) => publicScopeFromService(s)));
  // Scope to the staged services; with none given, render everything.
  const filtered = staged.length ? entries.filter((e) => scopes.has(e.scope)) : entries;
  process.stdout.write(renderChangelogMarkdown(filtered, {}));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }
}
