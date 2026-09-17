#!/usr/bin/env node
/**
 * Canonicalize a `--services` list to the post-mount service names that
 * `oagen generate` accepts.
 *
 * Callers (dashboards, manual dispatches) sometimes pass a raw *pre-mount* spec
 * tag — e.g. `UserManagementRedirectUris`, whose operations mount onto
 * `UserManagement`. `oagen generate --services` only accepts post-mount names
 * and hard-fails on anything else ("Unknown --services: …"), so a single stale
 * tag fails the whole generation job.
 *
 * The raw→post-mount mapping is read from `oagen resolve` (same `oagen.config.ts`
 * — mountRules, hints — that `oagen generate` applies), so this producer can
 * never disagree with the validator. A name that is already post-mount, or that
 * oagen has never heard of (a genuine typo), passes through unchanged — so real
 * unknown-service typos still fail loudly at generation.
 *
 * A selection that names EVERY post-mount service prints an empty list, so the
 * caller falls through to full (unscoped) generation. `oagen generate --services`
 * deliberately disables pruning so unselected services' files survive — but when
 * everything is selected there is nothing to protect, and pruning is what
 * deletes the orphaned resource + test files a mount rule leaves behind (e.g.
 * `OrganizationsDataProviders` folding onto `Pipes`: the client drops the old
 * accessor, and a scoped run would leave its test on disk calling it).
 *
 * CLI:  node scripts/canonicalize-services.mjs --spec <path> --services <csv>
 *       → prints the canonical, de-duplicated CSV to stdout.
 * On any resolve failure it warns on stderr and echoes the input unchanged, so
 * the guardrail can only help, never introduce a new failure mode.
 */
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

/**
 * Index `oagen resolve` output into the two facts canonicalization needs.
 * `mountOn` is *per operation*, so a raw tag can have some operations remounted
 * away while others stay — which means a name can be BOTH a valid post-mount
 * service in its own right AND the source tag of some remounted operations
 * (e.g. `Organizations`: most ops stay, an org-scoped audit-logs endpoint
 * remounts onto `AuditLogs`). So we track:
 *   - postMount:    every valid post-mount service name (`op.mountOn || op.service`)
 *   - targetsByTag: raw service tag → the sorted set of post-mount services its
 *                   operations land on
 * @param {Array<{ service?: string; mountOn?: string | null }>} operations
 * @returns {{ postMount: Set<string>, targetsByTag: Map<string, string[]> }}
 */
export function buildServiceIndex(operations) {
  const postMount = new Set();
  const targetSets = new Map();
  for (const op of operations) {
    if (!op || !op.service) continue;
    const target = op.mountOn || op.service;
    postMount.add(target);
    if (!targetSets.has(op.service)) targetSets.set(op.service, new Set());
    targetSets.get(op.service).add(target);
  }
  const targetsByTag = new Map();
  for (const [tag, set] of targetSets) {
    targetsByTag.set(tag, [...set].sort((a, b) => a.localeCompare(b)));
  }
  return { postMount, targetsByTag };
}

/**
 * Canonicalize each input service to the post-mount name(s) oagen accepts,
 * de-duplicating while preserving first-seen order.
 *   - already a valid post-mount service → kept as-is
 *   - a pure pre-mount tag (never itself a post-mount target) → replaced by the
 *     post-mount service(s) its operations land on
 *   - anything oagen has never seen → passed through unchanged, so genuine
 *     typos still fail loudly at `oagen generate`
 * @param {string[]} services
 * @param {{ postMount: Set<string>, targetsByTag: Map<string, string[]> }} index
 * @returns {string[]}
 */
export function canonicalizeServices(services, index) {
  const seen = new Set();
  const out = [];
  const add = (name) => {
    if (seen.has(name)) return;
    seen.add(name);
    out.push(name);
  };
  for (const raw of services) {
    const name = raw.trim();
    if (!name) continue;
    if (index.postMount.has(name)) {
      add(name);
    } else if (index.targetsByTag.has(name)) {
      for (const target of index.targetsByTag.get(name)) add(target);
    } else {
      add(name);
    }
  }
  return out;
}

/**
 * True when `canonical` is exactly the full set of post-mount services — the
 * caller selected everything. Set equality, not superset: an unknown name
 * riding along keeps the run scoped so `oagen generate` still rejects the typo.
 * @param {string[]} canonical
 * @param {{ postMount: Set<string> }} index
 * @returns {boolean}
 */
export function coversAllServices(canonical, index) {
  if (index.postMount.size === 0) return false;
  const selected = new Set(canonical);
  if (selected.size !== index.postMount.size) return false;
  for (const name of index.postMount) if (!selected.has(name)) return false;
  return true;
}

/** Parse a comma-separated services string into trimmed, non-empty names. */
export function parseCsv(csv) {
  return (csv ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function resolveOperations(spec) {
  const raw = execFileSync(
    "npx",
    ["oagen", "resolve", "--spec", spec, "--format", "json"],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "inherit"] },
  );
  const ops = JSON.parse(raw);
  if (!Array.isArray(ops)) throw new Error("oagen resolve did not return an array");
  return ops;
}

function main(argv) {
  let spec = "spec/open-api-spec.yaml";
  let servicesCsv = "";
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--spec") spec = argv[++i];
    else if (argv[i] === "--services") servicesCsv = argv[++i];
  }

  const input = parseCsv(servicesCsv);
  if (input.length === 0) {
    process.stdout.write("");
    return;
  }

  try {
    const index = buildServiceIndex(resolveOperations(spec));
    const canonical = canonicalizeServices(input, index);
    if (coversAllServices(canonical, index)) {
      process.stderr.write(
        `canonicalize-services: selection covers all ${index.postMount.size} services; ` +
          "running unscoped so oagen prunes orphaned files\n",
      );
      process.stdout.write("");
      return;
    }
    process.stdout.write(canonical.join(","));
  } catch (err) {
    // Degrade to today's behaviour: pass the list through untouched so
    // `oagen generate` still runs (and still validates the names itself).
    process.stderr.write(
      `canonicalize-services: could not resolve post-mount names (${err.message}); ` +
        "passing --services through unchanged\n",
    );
    process.stdout.write(input.join(","));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv);
}
