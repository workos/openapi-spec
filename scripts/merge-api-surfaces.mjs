#!/usr/bin/env node
/**
 * Merge two `oagen extract` API surfaces for a `--baseline-ref` generation.
 *
 * The emitters keep the parameter names and positions of the baseline surface
 * they are handed and append anything the baseline lacks after the trailing
 * options argument (oagen-emitters#284). That is right when the baseline is
 * the SDK callers compile against today — HEAD. A repair release pins
 * `baseline_ref` to an older tag because HEAD shipped a broken signature (the
 * workos-php v9.5.0 Pipes upsert methods lost every parameter, so the matrix
 * baselines PHP on v9.4.0). Handing the emitter the tag ALONE replaces HEAD's
 * whole surface with the tag's: every parameter that shipped between the tag
 * and HEAD at its spec position is then "new" and moves after `$options` —
 * `SSO::getProfileAndToken($code, $codeVerifier, …)` became
 * `($code, …, $options, $codeVerifier)` in workos-php#460 (oagen-emitters#292).
 *
 * So the tag is an overlay, not a replacement: HEAD's surface is the baseline,
 * and a method takes the tag's signature only where HEAD regressed from it —
 * a parameter the tag's signature has is missing from HEAD's, or HEAD has no
 * such method (or class) at all. Everything else — a method HEAD only added
 * parameters to, interfaces, enums, type aliases, exports — is HEAD's. The
 * same rule decides a class's constructor parameters (the Rust `new()` and
 * promoted-property constructors the extractors record there).
 *
 * CLI:  node scripts/merge-api-surfaces.mjs --head <head.json> --repair <tag.json>
 *           --output <merged.json> [--repair-label <text>]
 *       → writes the merged surface and prints one summary line to stderr
 *         naming every overlaid method, so a generation log shows exactly
 *         which signatures the repair ref still governs.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * Parameter names of the signature an emitter reads: the first overload's.
 * @param {Array<{ params?: Array<{ name: string }> }> | undefined} overloads
 * @returns {string[]}
 */
function paramNames(overloads) {
  return (overloads?.[0]?.params ?? []).map((param) => param.name);
}

/**
 * The parameters of `repair`'s signature that `head`'s lacks, by name. A
 * non-empty answer is a regression: callers of the repair ref passed those
 * arguments and HEAD cannot take them. An absent HEAD signature regressed on
 * every parameter; an absent repair signature never counts as a regression.
 * @param {Array<{ params?: Array<{ name: string }> }> | undefined} head
 * @param {Array<{ params?: Array<{ name: string }> }> | undefined} repair
 * @returns {string[]}
 */
export function missingParameters(head, repair) {
  if (!repair || repair.length === 0) return [];
  const have = new Set(paramNames(head));
  return paramNames(repair).filter((name) => !have.has(name));
}

/**
 * HEAD's surface with the repair ref's signature overlaid wherever HEAD
 * regressed from it. Neither input is mutated.
 * @param {any} head the surface extracted from the SDK's HEAD
 * @param {any} repair the surface extracted from the repair ref
 * @returns {{ surface: any, repaired: Array<{ className: string, method: string, missing: string[] }> }}
 *   `method` is the method name, or `constructor` for a class's constructor
 *   parameters; `missing` names the parameters HEAD lacked (empty when the
 *   whole method or class was missing).
 */
export function mergeApiSurfaces(head, repair) {
  const surface = structuredClone(head ?? {});
  surface.classes ??= {};
  const repaired = [];

  for (const [className, repairClass] of Object.entries(repair?.classes ?? {})) {
    const headClass = surface.classes[className];
    if (!headClass) {
      surface.classes[className] = structuredClone(repairClass);
      for (const method of Object.keys(repairClass.methods ?? {})) {
        repaired.push({ className, method, missing: [] });
      }
      if ((repairClass.constructorParams ?? []).length > 0) {
        repaired.push({ className, method: 'constructor', missing: [] });
      }
      continue;
    }

    headClass.methods ??= {};
    for (const [method, repairOverloads] of Object.entries(repairClass.methods ?? {})) {
      const headOverloads = headClass.methods[method];
      const missing = missingParameters(headOverloads, repairOverloads);
      if (missing.length === 0) continue;
      headClass.methods[method] = structuredClone(repairOverloads);
      repaired.push({ className, method, missing: headOverloads?.length ? missing : [] });
    }

    const repairCtor = repairClass.constructorParams ?? [];
    if (repairCtor.length > 0) {
      const missing = missingParameters([{ params: headClass.constructorParams ?? [] }], [{ params: repairCtor }]);
      if (missing.length > 0) {
        headClass.constructorParams = structuredClone(repairCtor);
        repaired.push({ className, method: 'constructor', missing });
      }
    }
  }

  return { surface, repaired };
}

/**
 * The one line the generation log shows for a merge.
 * @param {Array<{ className: string, method: string, missing: string[] }>} repaired
 * @param {string} label what the repair surface was extracted from
 * @returns {string}
 */
export function summarize(repaired, label) {
  if (repaired.length === 0) {
    return `merge-api-surfaces: baseline is HEAD's surface; ${label} overlays nothing (HEAD regressed on no signature)`;
  }
  const entries = repaired.map(({ className, method, missing }) =>
    missing.length > 0 ? `${className}.${method} (HEAD lacks ${missing.join(', ')})` : `${className}.${method} (missing from HEAD)`,
  );
  return `merge-api-surfaces: baseline is HEAD's surface with ${repaired.length} signature(s) overlaid from ${label}: ${entries.join('; ')}`;
}

function parseArgs(argv) {
  const args = { head: '', repair: '', output: '', repairLabel: '' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--head') args.head = argv[++i] ?? '';
    else if (arg === '--repair') args.repair = argv[++i] ?? '';
    else if (arg === '--output') args.output = argv[++i] ?? '';
    else if (arg === '--repair-label') args.repairLabel = argv[++i] ?? '';
    else {
      console.error(`merge-api-surfaces: unknown option ${arg}`);
      process.exit(2);
    }
  }
  if (!args.head || !args.repair || !args.output) {
    console.error('Usage: merge-api-surfaces.mjs --head <head.json> --repair <tag.json> --output <merged.json> [--repair-label <text>]');
    process.exit(2);
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const head = JSON.parse(readFileSync(args.head, 'utf8'));
  const repair = JSON.parse(readFileSync(args.repair, 'utf8'));
  const { surface, repaired } = mergeApiSurfaces(head, repair);
  writeFileSync(args.output, JSON.stringify(surface, null, 2));
  console.error(summarize(repaired, args.repairLabel || args.repair));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
