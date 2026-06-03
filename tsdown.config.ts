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
 */
export default defineConfig({
  entry: { policy: 'src/policy/index.ts' },
  format: ['esm'],
  dts: true,
  clean: true,
  target: 'node20',
  outDir: 'dist',
  deps: { neverBundle: ['@workos/oagen'] },
});
