/**
 * Service-level remounting. Maps IR service name → target service/namespace
 * (PascalCase). All operations in the source service are mounted on the
 * target unless overridden per-operation in {@link operationHints}.
 */
export const mountRules: Record<string, string> = {
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
  Directories: 'DirectorySync',
  DirectoryGroups: 'DirectorySync',
  DirectoryUsers: 'DirectorySync',

  // Feature flag sub-services -> FeatureFlags
  FeatureFlagsTargets: 'FeatureFlags',
  OrganizationsFeatureFlags: 'FeatureFlags',
  UserManagementUsersFeatureFlags: 'FeatureFlags',

  // Org API keys -> ApiKeys
  OrganizationsApiKeys: 'ApiKeys',

  // User Management sub-services -> UserManagement
  UserManagementSessionTokens: 'UserManagement',
  UserManagementAuthentication: 'UserManagement',
  UserManagementCorsOrigins: 'UserManagement',
  UserManagementUsers: 'UserManagement',
  UserManagementInvitations: 'UserManagement',
  UserManagementJWTTemplate: 'UserManagement',
  UserManagementMagicAuth: 'UserManagement',
  UserManagementOrganizationMembership: 'OrganizationMembership',
  UserManagementOrganizationMembershipGroups: 'OrganizationMembership',
  UserManagementRedirectUris: 'UserManagement',
  UserManagementUsersAuthorizedApplications: 'UserManagement',

  // Pipes / Data Providers -> Pipes
  UserManagementDataProviders: 'Pipes',

  // User Management MFA -> MultiFactorAuth
  UserManagementMultiFactorAuthentication: 'MultiFactorAuth',
};
