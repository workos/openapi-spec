import { defineConfig } from 'tsdown';

/**
 * Build the policy module for downstream consumers (`@workos/openapi-spec/policy`).
 *
 * The published artifacts are intentionally self-contained: types are
 * inlined in `src/policy.ts` (see the "Vendored type definitions" block)
 * rather than imported from `@workos/oagen`, so the published .d.mts has
 * zero external type references. The single runtime import (`toCamelCase`)
 * stays external — the package declares `@workos/oagen` as a regular
 * dependency so consumers get it installed transitively.
 */
export default defineConfig({
  entry: { policy: 'src/policy.ts' },
  format: ['esm'],
  dts: true,
  clean: true,
  target: 'node20',
  outDir: 'dist',
  deps: { neverBundle: ['@workos/oagen'] },
});
