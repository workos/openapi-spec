#!/usr/bin/env node
//
// build-spec-changes.mjs
//
// Transform an `oagen diff` report into a per-commit changed-services manifest
// that the SDK bot reads to compute pending SDK work. Emitted to stdout (the
// spec-changes workflow POSTs it to the bot); --output writes a file instead.
//
//   manifest:
//   {
//     "sha": "abc123",
//     "parentSha": "def456",
//     "timestamp": "2026-06-18T20:00:00Z",
//     "changedServices": [
//       { "service": "Vault", "hasBreaking": false },
//       { "service": "UserManagement", "hasBreaking": true }
//     ]
//   }
//
// Service names are POST-MOUNT (PascalCase) so they match exactly what the
// SDK bot offers and what `oagen generate --services <name>` accepts. The
// mapping uses the SAME `mountRules` the generator uses (imported from the
// built policy bundle), never a re-encoded copy.
//
//   - operation-*/service-* changes carry an IR service name directly.
//   - model-*/enum-* changes carry only a symbol name; their owning services
//     are resolved from the IR (a shared model surfaces every service that
//     references it, transitively). This needs --old-ir/--new-ir; without them
//     model/enum changes cannot be attributed and are reported on stderr.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import {
  buildIndexes,
  entriesFromGroups,
  factsFromDiff,
  groupFacts,
} from "./sdk-release-metadata.mjs";
import { scopesForStaged } from "./render-changelog-preview.mjs";

const BREAKING = "breaking";

// ── arg parsing ────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = {
    report: "",
    oldIr: "",
    newIr: "",
    sha: "",
    parentSha: "",
    timestamp: "",
    commitMessage: "",
    prNumber: "",
    prUrl: "",
    output: "",
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--report") args.report = argv[++i] ?? "";
    else if (arg === "--old-ir") args.oldIr = argv[++i] ?? "";
    else if (arg === "--new-ir") args.newIr = argv[++i] ?? "";
    else if (arg === "--sha") args.sha = argv[++i] ?? "";
    else if (arg === "--parent-sha") args.parentSha = argv[++i] ?? "";
    else if (arg === "--timestamp") args.timestamp = argv[++i] ?? "";
    else if (arg === "--commit-message") args.commitMessage = argv[++i] ?? "";
    else if (arg === "--pr-number") args.prNumber = argv[++i] ?? "";
    else if (arg === "--pr-url") args.prUrl = argv[++i] ?? "";
    else if (arg === "--output") args.output = argv[++i] ?? "";
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!args.report) {
    throw new Error(
      "Usage: build-spec-changes.mjs --report <oagen-diff.json> [--old-ir <ir.json>] " +
        "[--new-ir <ir.json>] [--sha <sha>] [--parent-sha <sha>] [--timestamp <iso>] [--output <file>]",
    );
  }
  return args;
}

function readJson(path, fallback) {
  if (!path || !existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, "utf8"));
}

// ── post-mount mapping ───────────────────────────────────────────────────────
// A source IR service name maps to its post-mount target via mountRules; a
// service that is not remounted keeps its own (already post-mount) name.
function toPostMount(serviceName, mountRules) {
  if (!serviceName) return null;
  return mountRules[serviceName] ?? serviceName;
}

// ── model/enum → owning-services index ───────────────────────────────────────
// Mirrors the reachability walk in scripts/sdk-release-metadata.mjs
// (buildIndexes): seed each operation's referenced models/enums, chase model
// fields transitively, and attribute every reachable symbol to the operation's
// post-mount service. Built over BOTH IRs so a removed model (present only in
// the old IR) is still attributable.
export function buildSymbolOwners(irs, mountRules) {
  const modelByName = new Map();
  for (const ir of irs.filter(Boolean)) {
    for (const model of ir.models ?? []) modelByName.set(model.name, model);
  }

  const owners = new Map(); // "model:Name" | "enum:Name" -> Set<postMountService>
  const add = (kind, name, service) => {
    if (!name || !service) return;
    const key = `${kind}:${name}`;
    if (!owners.has(key)) owners.set(key, new Set());
    owners.get(key).add(service);
  };

  const collectTypeRefs = (type, out) => {
    if (!type || typeof type !== "object") return;
    if (type.kind === "model" && type.name) out.models.add(type.name);
    if (type.kind === "enum" && type.name) out.enums.add(type.name);
    if (type.inner) collectTypeRefs(type.inner, out);
    if (type.items) collectTypeRefs(type.items, out);
    if (type.values) collectTypeRefs(type.values, out);
    for (const variant of type.variants ?? []) collectTypeRefs(variant, out);
  };

  const collectModelClosure = (modelName, out, seen = new Set()) => {
    if (!modelName || seen.has(modelName)) return;
    seen.add(modelName);
    out.models.add(modelName);
    const model = modelByName.get(modelName);
    if (!model) return;
    for (const field of model.fields ?? []) {
      const nested = { models: new Set(), enums: new Set() };
      collectTypeRefs(field.type, nested);
      for (const enumName of nested.enums) out.enums.add(enumName);
      for (const nestedModel of nested.models)
        collectModelClosure(nestedModel, out, seen);
    }
  };

  for (const ir of irs.filter(Boolean)) {
    for (const service of ir.services ?? []) {
      const postMount = toPostMount(service.name, mountRules);
      for (const operation of service.operations ?? []) {
        const direct = { models: new Set(), enums: new Set() };
        for (const param of [
          ...(operation.pathParams ?? []),
          ...(operation.queryParams ?? []),
          ...(operation.headerParams ?? []),
        ]) {
          collectTypeRefs(param.type, direct);
        }
        collectTypeRefs(operation.requestBody, direct);
        collectTypeRefs(operation.response, direct);
        for (const response of operation.successResponses ?? [])
          collectTypeRefs(response.type, direct);
        for (const error of operation.errors ?? [])
          collectTypeRefs(error.type, direct);

        const all = { models: new Set(), enums: new Set(direct.enums) };
        for (const modelName of direct.models)
          collectModelClosure(modelName, all);
        for (const modelName of all.models) add("model", modelName, postMount);
        for (const enumName of all.enums) add("enum", enumName, postMount);
      }
    }
  }

  return owners;
}

// ── per-change classification ────────────────────────────────────────────────
// oagen sets a rolled-up `classification` on every change; we trust it but also
// treat any `*-removed` kind and any breaking sub-change as breaking, so the
// flag is robust even if the rollup ever regresses.
export function isBreaking(change) {
  if (!change || typeof change !== "object") return false;
  if (change.classification === BREAKING) return true;
  if (typeof change.kind === "string" && change.kind.endsWith("-removed"))
    return true;
  for (const key of ["fieldChanges", "paramChanges", "valueChanges"]) {
    for (const sub of change[key] ?? []) {
      if (sub?.classification === BREAKING) return true;
    }
  }
  return false;
}

// Post-mount services a single diff change affects.
export function servicesForChange(change, owners, mountRules) {
  const kind = typeof change?.kind === "string" ? change.kind : "";
  if (kind.startsWith("operation-")) {
    const service = toPostMount(change.serviceName, mountRules);
    return service ? [service] : [];
  }
  if (kind.startsWith("service-")) {
    const service = toPostMount(change.name, mountRules);
    return service ? [service] : [];
  }
  if (kind.startsWith("model-")) {
    return [...(owners.get(`model:${change.name}`) ?? [])];
  }
  if (kind.startsWith("enum-")) {
    return [...(owners.get(`enum:${change.name}`) ?? [])];
  }
  return [];
}

// ── changed endpoints (dashboard drill-in) ────────────────────────────────────
// The endpoints that changed, grouped by post-mount service, each with the
// canonical breaking flag. Method/path come from the IR (operations carry
// httpMethod + path); the diff report only names serviceName.operationName.
// Kept separate from buildSpecChanges so the lean changedServices rollup the
// bot's pending logic depends on stays shape-stable; the CLI merges these in.
export function buildChangedEndpoints({ report, irs = [], mountRules = {} }) {
  const opByKey = new Map(); // "ServiceName.opName" -> { method, path }
  for (const ir of irs.filter(Boolean)) {
    for (const service of ir.services ?? []) {
      for (const op of service.operations ?? []) {
        if (op.httpMethod && op.path) {
          opByKey.set(`${service.name}.${op.name}`, {
            method: String(op.httpMethod).toUpperCase(),
            path: op.path,
          });
        }
      }
    }
  }

  const byService = new Map(); // postMountService -> Map<"METHOD path", endpoint>
  for (const change of report.changes ?? []) {
    const kind = typeof change?.kind === "string" ? change.kind : "";
    if (!kind.startsWith("operation-")) continue;
    const ep = opByKey.get(`${change.serviceName}.${change.operationName}`);
    if (!ep) continue;
    const service = toPostMount(change.serviceName, mountRules);
    if (!service) continue;
    if (!byService.has(service)) byService.set(service, new Map());
    const endpoints = byService.get(service);
    const key = `${ep.method} ${ep.path}`;
    const breaking = isBreaking(change);
    const existing = endpoints.get(key);
    if (!existing) endpoints.set(key, { method: ep.method, path: ep.path, breaking, kind });
    else if (breaking) existing.breaking = true;
  }

  const out = new Map();
  for (const [service, endpoints] of byService) out.set(service, [...endpoints.values()]);
  return out;
}

// ── build the manifest ───────────────────────────────────────────────────────
export function buildSpecChanges({
  report,
  irs = [],
  sha = "",
  parentSha = "",
  timestamp = "",
  mountRules = {},
}) {
  const owners = buildSymbolOwners(irs, mountRules);
  const byService = new Map(); // postMountService -> hasBreaking
  let unattributedSymbolChanges = 0;

  const touch = (service, breaking) => {
    byService.set(service, (byService.get(service) ?? false) || breaking);
  };

  for (const change of report.changes ?? []) {
    const services = servicesForChange(change, owners, mountRules);
    const kind = typeof change?.kind === "string" ? change.kind : "";
    if (
      services.length === 0 &&
      (kind.startsWith("model-") || kind.startsWith("enum-"))
    ) {
      unattributedSymbolChanges += 1;
    }
    const breaking = isBreaking(change);
    for (const service of services) touch(service, breaking);
  }

  // Behavior changes (e.g. a removed server-side query-param default) are
  // service-scoped and always breaking. oagen emits them as a separate
  // top-level array; fold them into the same per-service rollup.
  for (const behaviorChange of report.behaviorChanges ?? []) {
    const service = toPostMount(behaviorChange.serviceName, mountRules);
    if (service) touch(service, true);
  }

  const changedServices = [...byService.entries()]
    .map(([service, hasBreaking]) => ({ service, hasBreaking }))
    .sort((a, b) => a.service.localeCompare(b.service));

  return {
    manifest: { sha, parentSha, timestamp, changedServices },
    unattributedSymbolChanges,
  };
}

// ── CLI entrypoint ────────────────────────────────────────────────────────────
async function loadPolicy() {
  try {
    const mod = await import(new URL("../dist/policy.mjs", import.meta.url));
    return { mountRules: mod.mountRules ?? {}, operationHints: mod.operationHints ?? {} };
  } catch (err) {
    throw new Error(
      `Failed to import policy from dist/policy.mjs (${err.message}). ` +
        "Run `npm run build:policy` first — dist/ is git-ignored and is not built by `npm ci`.",
    );
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const report = readJson(args.report, null);
  if (!report)
    throw new Error(`Diff report not found or empty: ${args.report}`);

  const irs = [readJson(args.oldIr, null), readJson(args.newIr, null)];
  const { mountRules, operationHints } = await loadPolicy();
  const timestamp = args.timestamp || new Date().toISOString();

  const { manifest, unattributedSymbolChanges } = buildSpecChanges({
    report,
    irs,
    sha: args.sha,
    parentSha: args.parentSha,
    timestamp,
    mountRules,
  });

  // Enrich the emitted manifest (the bot reads these; the lean buildSpecChanges
  // rollup above is intentionally left untouched): per-service changed endpoints,
  // per-service changelog entries, and the originating commit/PR.
  const endpointsByService = buildChangedEndpoints({ report, irs, mountRules });

  // This commit's changelog entries, computed from the SAME diff report + IRs
  // via the exact pipeline the changelog renderer uses (facts -> groups ->
  // entries) — no extra `oagen` run, no git. Entries are scoped per service the
  // same way the renderer scopes a staged set (scopesForStaged), so the SDK bot
  // renders the "Generate staged" preview straight from D1, with no on-demand
  // changelog-preview workflow dispatch.
  const indexes = buildIndexes(irs);
  const allEntries = entriesFromGroups(groupFacts(factsFromDiff(report, indexes)), []);
  manifest.changedServices = manifest.changedServices.map((s) => {
    const scopes = scopesForStaged([s.service], mountRules, operationHints);
    return {
      ...s,
      changedEndpoints: endpointsByService.get(s.service) ?? [],
      entries: allEntries.filter((e) => scopes.has(e.scope)),
    };
  });
  if (args.commitMessage) manifest.commitMessage = args.commitMessage;
  if (args.prNumber && /^\d+$/.test(args.prNumber)) manifest.prNumber = Number(args.prNumber);
  if (args.prUrl) manifest.prUrl = args.prUrl;

  if (unattributedSymbolChanges > 0) {
    const reason = irs.some(Boolean)
      ? "these models/enums are referenced by no operation (orphaned) or absent from the supplied IR"
      : "no --old-ir/--new-ir supplied, so model/enum changes cannot be attributed to services";
    process.stderr.write(
      `warning: ${unattributedSymbolChanges} model/enum change(s) were not attributed to any service ` +
        `(${reason}).\n`,
    );
  }

  const json = `${JSON.stringify(manifest, null, 2)}\n`;
  if (args.output) {
    mkdirSync(dirname(args.output), { recursive: true });
    writeFileSync(args.output, json, "utf8");
    process.stderr.write(
      `Wrote ${args.output} (${manifest.changedServices.length} changed service(s))\n`,
    );
  } else {
    process.stdout.write(json);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  });
}
