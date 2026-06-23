import { defineConfig } from 'tsdown';

/**
 * Build the policy module for downstream consumers (`@workos/openapi-spec/policy`).
 *
 * The published artifacts are intentionally self-contained: types are
 * inlined in `src/policy/types.ts` rather than imported from `@workos/oagen`,
 * so the published .d.mts has zero external type references. The single
 * runtime import (`toCamelCase`) stays external — the package declares
 * `@workos/oagen` as a regular dependency so consumers get it installed
 * transitively.
 *
 * The barrel at `src/policy/index.ts` consolidates the sub-files
 * (operation-hints, mount-rules, model-hints, transforms, types) into a
 * single published `dist/policy.{mjs,d.mts}` artifact.
 *
 * `services` is a second entry: the generated post-mount service roster
 * (`@workos/openapi-spec/services`). Its source `src/policy/services.generated.ts`
 * is git-ignored and produced by `generate:services` (which `build:policy` runs
 * before this) — it exists only in the published `dist/`, never in the repo. It
 * is a standalone entry (not folded into the policy barrel) so the barrel stays
 * loadable during generation, before the roster file is written.
 */
export default defineConfig({
  entry: {
    policy: 'src/policy/index.ts',
    services: 'src/policy/services.generated.ts',
  },
  format: ['esm'],
  dts: true,
  clean: true,
  target: 'node20',
  outDir: 'dist',
  deps: { neverBundle: ['@workos/oagen'] },
});
