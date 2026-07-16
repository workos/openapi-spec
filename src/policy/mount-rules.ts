/**
 * Service-level remounting. Maps IR service name → target service/namespace
 * (PascalCase). All operations in the source service are mounted on the
 * target unless overridden per-operation in {@link operationHints}.
 *
 * Keys may be exact service names or trailing-`*` prefix patterns
 * (requires @workos/oagen >= 0.25.0). Precedence: an exact key always wins;
 * among wildcards the longest prefix wins. Matching is plain `startsWith` —
 * no regex. Note that a wildcard also absorbs future spec tags under its
 * prefix, so review `oagen diff` output when tags are added: a new tag that
 * does not belong to its prefix family (cf. UserManagementDataProviders →
 * Pipes) needs its own exact entry here.
 */
export const mountRules: Record<string, string> = {
  // Client API token -> ClientApi
  // The `client` tag mounts a `Client` service (accessor `client`, Rust module
  // `client`, Ruby class `WorkOS::Client`) that collides with each SDK's
  // built-in client primitive: Rust's `mod client`, Ruby's core
  // `WorkOS::Client`, and Go's aggregator. The emitters' collision-avoidance
  // (shared/service-name-collision.ts) only reserves model/enum names, not the
  // SDK client itself, so generation silently diverges (Go: undefined
  // `ClientService`; Rust: `client::CreateTokenParams` resolves to the HTTP
  // client; Ruby: `create_token` arity mismatch). Remounting on `ClientApi`
  // (accessor `client_api`, "Client API token") sidesteps the collision in
  // every language. The endpoint is net-new, so there is no compat baseline.
  Client: 'ClientApi',

  // MFA sub-services -> MultiFactorAuth
  MultiFactorAuthChallenges: 'MultiFactorAuth',

  // RBAC permissions -> Authorization
  Permissions: 'Authorization',

  // Connect sub-services -> Connect
  WorkosConnect: 'Connect',
  Applications: 'Connect',
  ApplicationClientSecrets: 'Connect',

  // SSO connections -> SSO
  Connections: 'SSO',

  // Directory Sync sub-services -> DirectorySync
  // ("Director*", not "Directory*": the prefix must also cover "Directories")
  'Director*': 'DirectorySync',

  // Feature flag sub-services -> FeatureFlags
  FeatureFlagsTargets: 'FeatureFlags',
  OrganizationsFeatureFlags: 'FeatureFlags',
  UserManagementUsersFeatureFlags: 'FeatureFlags',

  // Org API keys -> ApiKeys
  OrganizationsApiKeys: 'ApiKeys',

  // User Management sub-services -> UserManagement, except the
  // OrganizationMembership family (longer wildcard prefix wins) and the three
  // exact entries below/above (exact always beats a wildcard):
  // UserManagementUsersFeatureFlags, UserManagementDataProviders,
  // UserManagementMultiFactorAuthentication.
  'UserManagement*': 'UserManagement',
  'UserManagementOrganizationMembership*': 'OrganizationMembership',

  // Pipes / Data Providers -> Pipes
  UserManagementDataProviders: 'Pipes',

  // User Management MFA -> MultiFactorAuth
  UserManagementMultiFactorAuthentication: 'MultiFactorAuth',
};
