/**
 * Vendored type definitions for the policy module.
 *
 * `OperationHint`, `SplitHint`, and `OpenApiDocument` are inlined from
 * `@workos/oagen` so the published `@workos/openapi-spec/policy` .d.mts is
 * self-contained — consumers get full autocomplete without resolving types
 * through `@workos/oagen`. Keep these in sync with the upstream definitions
 * in `oagen/src/ir/operation-hints.ts` and `oagen/src/parser/parse.ts`; bump
 * when the upstream schema gains a field this repo wants to use.
 */
export type OpenApiDocument = Record<string, unknown>;

export interface SplitHint {
  /** Wrapper method name (snake_case). */
  name: string;
  /** The discriminated union variant model name (e.g. 'PasswordSessionAuthenticateRequest'). */
  targetVariant: string;
  /** Constant body fields injected by the wrapper. */
  defaults?: Record<string, string | number | boolean>;
  /** Fields the SDK reads from client config at runtime. */
  inferFromClient?: string[];
  /** Only these body fields are exposed as method params. */
  exposedParams?: string[];
  /** Subset of exposedParams that should be emitted as optional. */
  optionalParams?: string[];
}

export interface OperationHint {
  /** Override the algorithm-derived method name. */
  name?: string;
  /** Remount this operation to a different service/namespace (PascalCase). */
  mountOn?: string;
  /** Split a union-body operation into N typed wrapper methods. */
  split?: SplitHint[];
  /** Inject constant body defaults (e.g. { grant_type: 'password' }). */
  defaults?: Record<string, string | number | boolean>;
  /** Fields the SDK reads from client config at runtime (e.g. ['client_id']). */
  inferFromClient?: string[];
  /**
   * Marks this operation as a URL builder rather than a real HTTP call.
   * Emitters generate a method that returns the constructed URL (typically
   * as a string) without performing any I/O. Used for OAuth-style redirect
   * endpoints such as /sso/authorize and /user_management/sessions/logout.
   */
  urlBuilder?: boolean;
}
