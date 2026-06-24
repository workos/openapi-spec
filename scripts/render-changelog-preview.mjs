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

// The changelog scopes for a set of staged POST-mount service names.
// publicScopeFromService is defined over PRE-mount (IR) names; for post-mount
// names it coincides for all but the mounted ones — e.g. IR `Client` mounts to
// `ClientApi`, but its changelog scope is `client`, not `client_api`. So union
// each post-mount name's own scope with the scopes of every IR name that mounts
// to it, using the same mountRules the producer/generator use (no drift).
export function scopesForStaged(staged, mountRules = {}) {
  const scopes = new Set();
  for (const s of staged) scopes.add(publicScopeFromService(s));
  for (const [pre, post] of Object.entries(mountRules)) {
    if (staged.includes(post)) scopes.add(publicScopeFromService(pre));
  }
  return scopes;
}

async function loadMountRules() {
  try {
    const mod = await import(new URL("../dist/policy.mjs", import.meta.url));
    return mod.mountRules ?? {};
  } catch {
    // Fall back to post-mount-name scopes only (the workflow builds dist/policy
    // first, so this only degrades a local run without `npm run build:policy`).
    return {};
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const entries = existsSync(args.entries) ? JSON.parse(readFileSync(args.entries, "utf8")) : [];
  const staged = String(args.services ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  // With no staged set, render everything.
  if (staged.length === 0) {
    process.stdout.write(renderChangelogMarkdown(entries, {}));
    return;
  }
  const scopes = scopesForStaged(staged, await loadMountRules());
  const filtered = entries.filter((e) => scopes.has(e.scope));
  process.stdout.write(renderChangelogMarkdown(filtered, {}));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  });
}
