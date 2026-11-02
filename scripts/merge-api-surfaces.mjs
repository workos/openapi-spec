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
 * That is `--mode overlay`, the default. `--mode restore` is for a release
 * whose own positional order was the break (workos-kotlin v7.5.0 inserted
 * parameters ahead of v7.4.0's on eight methods, oagen-emitters#297): the
 * tag's signature wins for every method and constructor the tag has, not only
 * where HEAD lost parameters, so every parameter shipped since the tag moves
 * after the options argument. Methods the tag lacks, and everything that is
 * not a signature, stay HEAD's either way, which is what handing the emitter
 * the tag alone would lose.
 *
 * CLI:  node scripts/merge-api-surfaces.mjs --head <head.json> --repair <tag.json>
 *           --output <merged.json> [--repair-label <text>] [--mode overlay|restore]
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

export const MODES = ['overlay', 'restore'];

/**
 * Whether the repair signature replaces HEAD's: in overlay mode only when HEAD
 * lacks a parameter, in restore mode whenever the parameter names or their
 * order differ.
 */
function takesRepair(mode, headOverloads, repairOverloads, missing) {
  if (missing.length > 0) return true;
  return mode === 'restore' && paramNames(headOverloads).join(',') !== paramNames(repairOverloads).join(',');
}

/**
 * HEAD's surface with the repair ref's signatures overlaid: wherever HEAD
 * regressed from the repair ref (`overlay`), or wherever the repair ref has
 * the method at all and its signature differs (`restore`). Neither input is
 * mutated.
 * @param {any} head the surface extracted from the SDK's HEAD
 * @param {any} repair the surface extracted from the repair ref
 * @param {{ mode?: 'overlay' | 'restore' }} [options]
 * @returns {{ surface: any, repaired: Array<{ className: string, method: string, missing: string[] }> }}
 *   `method` is the method name, or `constructor` for a class's constructor
 *   parameters; `missing` names the parameters HEAD lacked (empty when the
 *   whole method or class was missing, or when restore mode only reordered).
 */
export function mergeApiSurfaces(head, repair, { mode = 'overlay' } = {}) {
  if (!MODES.includes(mode)) throw new Error(`merge-api-surfaces: unknown mode ${mode}`);
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
      if (repairOverloads.length === 0) continue;
      const headOverloads = headClass.methods[method];
      // A method HEAD does not have at all is a regression whatever its
      // arity — a zero-argument method has no parameter to be missing.
      if (!headOverloads || headOverloads.length === 0) {
        headClass.methods[method] = structuredClone(repairOverloads);
        repaired.push({ className, method, missing: [] });
        continue;
      }
      const missing = missingParameters(headOverloads, repairOverloads);
      if (!takesRepair(mode, headOverloads, repairOverloads, missing)) continue;
      headClass.methods[method] = structuredClone(repairOverloads);
      repaired.push({ className, method, missing });
    }

    const repairCtor = repairClass.constructorParams ?? [];
    if (repairCtor.length > 0) {
      const headCtor = [{ params: headClass.constructorParams ?? [] }];
      const missing = missingParameters(headCtor, [{ params: repairCtor }]);
      if (takesRepair(mode, headCtor, [{ params: repairCtor }], missing)) {
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
 * @param {'overlay' | 'restore'} [mode]
 * @returns {string}
 */
export function summarize(repaired, label, mode = 'overlay') {
  const verb = mode === 'restore' ? 'restored from' : 'overlaid from';
  if (repaired.length === 0) {
    return mode === 'restore'
      ? `merge-api-surfaces: baseline is HEAD's surface; ${label} restores nothing (every signature it has matches HEAD's)`
      : `merge-api-surfaces: baseline is HEAD's surface; ${label} overlays nothing (HEAD regressed on no signature)`;
  }
  const entries = repaired.map(({ className, method, missing }) =>
    missing.length > 0
      ? `${className}.${method} (HEAD lacks ${missing.join(', ')})`
      : mode === 'restore'
        ? `${className}.${method} (HEAD reordered)`
        : `${className}.${method} (missing from HEAD)`,
  );
  const scope = mode === 'restore' ? ' (restore mode: the tag wins wherever it has the method)' : '';
  return `merge-api-surfaces: baseline is HEAD's surface with ${repaired.length} signature(s) ${verb} ${label}${scope}: ${entries.join('; ')}`;
}

function parseArgs(argv) {
  const args = { head: '', repair: '', output: '', repairLabel: '', mode: 'overlay' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--head') args.head = argv[++i] ?? '';
    else if (arg === '--repair') args.repair = argv[++i] ?? '';
    else if (arg === '--output') args.output = argv[++i] ?? '';
    else if (arg === '--repair-label') args.repairLabel = argv[++i] ?? '';
    else if (arg === '--mode') args.mode = argv[++i] ?? '';
    else {
      console.error(`merge-api-surfaces: unknown option ${arg}`);
      process.exit(2);
    }
  }
  if (!args.head || !args.repair || !args.output || !MODES.includes(args.mode)) {
    console.error(
      'Usage: merge-api-surfaces.mjs --head <head.json> --repair <tag.json> --output <merged.json> [--repair-label <text>] [--mode overlay|restore]',
    );
    process.exit(2);
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const head = JSON.parse(readFileSync(args.head, 'utf8'));
  const repair = JSON.parse(readFileSync(args.repair, 'utf8'));
  const { surface, repaired } = mergeApiSurfaces(head, repair, { mode: args.mode });
  writeFileSync(args.output, JSON.stringify(surface, null, 2));
  console.error(summarize(repaired, args.repairLabel || args.repair, args.mode));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
