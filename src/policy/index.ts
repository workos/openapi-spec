/**
 * Consumer-owned resolution policy for the WorkOS OpenAPI spec.
 *
 * Single source of truth for the policy that determines what the generated
 * SDKs (and any other downstream consumer of the resolved IR — docs
 * snippets, postman collections, etc.) look like. The spec repo's own
 * `oagen.config.ts` consumes this barrel to drive `npx oagen generate`;
 * the WorkOS docs build consumes it via `@workos/openapi-spec/policy` so
 * the snippet emitters produce method names, mount targets, and parameter
 * shapes that match the real SDKs.
 *
 * Adding or changing a hint here changes what every consumer sees on the
 * next release of `@workos/openapi-spec`.
 */
export type { OpenApiDocument, OperationHint, SplitHint } from './types.js';
export { operationHints } from './operation-hints.js';
export { mountRules } from './mount-rules.js';
export { modelHints } from './model-hints.js';
export { nestjsOperationIdTransform, schemaNameTransform, transformSpec } from './transforms.js';
