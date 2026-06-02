/**
 * Consumer-owned resolution policy for the WorkOS OpenAPI spec.
 *
 * This module is the **single source of truth** for the spec policy that
 * determines what the generated SDKs (and any other downstream consumer of
 * the resolved IR — docs snippets, postman collections, etc.) look like.
 * The spec repo's own `oagen.config.ts` consumes it to drive
 * `npx oagen generate`; the WorkOS docs build consumes it via
 * `@workos/openapi-spec/policy` so the snippet emitters produce method
 * names, mount targets, and parameter shapes that match the real SDKs.
 *
 * Adding or changing a hint here changes what every consumer sees on the
 * next release of `@workos/openapi-spec`.
 */
import { toCamelCase } from '@workos/oagen';

// ---------------------------------------------------------------------------
// Vendored type definitions
//
// `OperationHint`, `SplitHint`, and `OpenApiDocument` are inlined from
// `@workos/oagen` so the published `@workos/openapi-spec/policy` .d.mts is
// self-contained — consumers get full autocomplete without resolving types
// through `@workos/oagen`. Keep these in sync with the upstream definitions
// in oagen/src/ir/operation-hints.ts and oagen/src/parser/parse.ts; bump
// when the upstream schema gains a field this repo wants to use.
// ---------------------------------------------------------------------------
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

/**
 * NestJS-style operationId transform. Strips "Controller" and extracts the
 * action after the first underscore: `FooController_bar` -> `bar`.
 */
export function nestjsOperationIdTransform(id: string): string {
  const stripped = id.replace(/Controller/g, '');
  const idx = stripped.indexOf('_');
  return idx !== -1 ? toCamelCase(stripped.slice(idx + 1)) : toCamelCase(stripped);
}

// ---------------------------------------------------------------------------
// Operation hints -- per-operation overrides for the operation resolver.
// Keyed by "METHOD /path". Only operations that need overrides are listed;
// the algorithm handles the rest.
// ---------------------------------------------------------------------------
export const operationHints: Record<string, OperationHint> = {
  // -- Radar --------------------------------------------------------------------
  'POST /radar/lists/{type}/{action}': { name: 'add_list_entry' },
  'DELETE /radar/lists/{type}/{action}': { name: 'remove_list_entry' },

  // -- SSO ----------------------------------------------------------------------
  'GET /sso/authorize': {
    name: 'get_authorization_url',
    defaults: { response_type: 'code' },
    inferFromClient: ['client_id'],
    urlBuilder: true,
  },
  'GET /sso/logout': { name: 'get_logout_url', urlBuilder: true },
  'GET /sso/profile': { name: 'get_profile' },
  'POST /sso/token': {
    name: 'get_profile_and_token',
    defaults: { grant_type: 'authorization_code' },
    inferFromClient: ['client_id', 'client_secret'],
  },

  // -- SSO / JWKS (mounted on UserManagement via mountRules) --------------------
  'GET /sso/jwks/{clientId}': { name: 'get_jwks' },

  // -- User Management -- auth --------------------------------------------------
  'GET /user_management/authorize': {
    name: 'get_authorization_url',
    defaults: { response_type: 'code' },
    inferFromClient: ['client_id'],
    urlBuilder: true,
  },
  'GET /user_management/sessions/logout': { name: 'get_logout_url', urlBuilder: true },

  // -- Admin Portal -------------------------------------------------------------
  'POST /portal/generate_link': { name: 'generate_link' },

  // -- Feature Flags -- disambiguate co-mounted list operations -----------------
  'GET /organizations/{organizationId}/feature-flags': { name: 'list_organization_feature_flags' },
  'GET /user_management/users/{userId}/feature-flags': { name: 'list_user_feature_flags' },

  // -- External ID lookups (not derivable from path) ----------------------------
  'GET /organizations/external_id/{external_id}': { name: 'get_organization_by_external_id' },
  'GET /user_management/users/external_id/{external_id}': { name: 'get_user_by_external_id' },

  // -- Authorization -- environment-scoped roles --------------------------------
  'GET /authorization/roles': { name: 'list_environment_roles' },
  'POST /authorization/roles': { name: 'create_environment_role' },
  'GET /authorization/roles/{slug}': { name: 'get_environment_role' },
  'PATCH /authorization/roles/{slug}': { name: 'update_environment_role' },
  'PUT /authorization/roles/{slug}/permissions': {
    name: 'set_environment_role_permissions',
  },
  'POST /authorization/roles/{slug}/permissions': {
    name: 'add_environment_role_permission',
  },

  // -- Authorization -- singularized/shortened names ----------------------------
  'POST /authorization/permissions': { name: 'create_permission' },
  'POST /authorization/resources': { name: 'create_resource' },
  'POST /authorization/organization_memberships/{organization_membership_id}/check': {
    name: 'check',
  },
  'GET /authorization/organization_memberships/{organization_membership_id}/resources': {
    name: 'list_resources_for_membership',
  },
  'GET /authorization/organization_memberships/{organization_membership_id}/resources/{resource_id}/permissions': {
    name: 'list_effective_permissions',
  },
  'GET /authorization/organization_memberships/{organization_membership_id}/resources/{resource_type_slug}/{external_id}/permissions':
  {
    name: 'list_effective_permissions_by_external_id',
  },
  'GET /authorization/organization_memberships/{organization_membership_id}/role_assignments': {
    name: 'list_role_assignments',
  },
  'POST /authorization/organization_memberships/{organization_membership_id}/role_assignments': {
    name: 'assign_role',
  },
  'DELETE /authorization/organization_memberships/{organization_membership_id}/role_assignments': {
    name: 'remove_role',
  },
  'DELETE /authorization/organization_memberships/{organization_membership_id}/role_assignments/{role_assignment_id}': {
    name: 'remove_role_assignment',
  },
  'POST /authorization/organizations/{organizationId}/roles': {
    name: 'create_organization_role',
  },

  // -- Authorization -- org-scoped role permissions (prefer established SDK names)
  'PUT /authorization/organizations/{organizationId}/roles/{slug}/permissions': {
    name: 'set_organization_role_permissions',
  },
  'POST /authorization/organizations/{organizationId}/roles/{slug}/permissions': {
    name: 'add_organization_role_permission',
  },
  'DELETE /authorization/organizations/{organizationId}/roles/{slug}/permissions/{permissionSlug}': {
    name: 'remove_organization_role_permission',
  },

  // -- Authorization -- resources by external ID (prefer established SDK names)
  'GET /authorization/organizations/{organization_id}/resources/{resource_type_slug}/{external_id}': {
    name: 'get_resource_by_external_id',
  },
  'PATCH /authorization/organizations/{organization_id}/resources/{resource_type_slug}/{external_id}': {
    name: 'update_resource_by_external_id',
  },
  'DELETE /authorization/organizations/{organization_id}/resources/{resource_type_slug}/{external_id}': {
    name: 'delete_resource_by_external_id',
  },

  // -- Authorization -- memberships for resource by external ID -----------------
  'GET /authorization/organizations/{organization_id}/resources/{resource_type_slug}/{external_id}/organization_memberships': {
    name: 'list_memberships_for_resource_by_external_id',
  },

  // -- Authorization -- role assignments for resource by external ID ------------
  'GET /authorization/organizations/{organization_id}/resources/{resource_type_slug}/{external_id}/role_assignments': {
    name: 'list_role_assignments_for_resource_by_external_id',
  },

  // -- Authorization -- env-scoped resource memberships -------------------------
  'GET /authorization/resources/{resource_id}/organization_memberships': { name: 'list_memberships_for_resource' },

  // -- Authorization -- env-scoped resource role assignments --------------------
  'GET /authorization/resources/{resource_id}/role_assignments': { name: 'list_role_assignments_for_resource' },

  // -- User Management -- singularized/shortened names --------------------------
  'POST /user_management/users': { name: 'create_user' },
  'POST /user_management/invitations': { name: 'send_invitation' },
  'GET /user_management/invitations/by_token/{token}': {
    name: 'find_invitation_by_token',
  },
  'POST /user_management/users/{id}/email_verification/send': {
    name: 'send_verification_email',
  },
  'POST /user_management/users/{id}/email_verification/confirm': {
    name: 'verify_email',
  },
  'POST /user_management/password_reset': { name: 'reset_password' },
  'POST /user_management/password_reset/confirm': {
    name: 'confirm_password_reset',
  },
  'GET /user_management/users/{id}/sessions': { name: 'list_sessions' },
  'GET /user_management/users/{id}/identities': { name: 'get_user_identities' },
  'POST /user_management/cors_origins': { name: 'create_cors_origin' },
  'POST /user_management/redirect_uris': { name: 'create_redirect_uri' },

  // -- Organizations -- singularized names --------------------------------------
  'POST /organizations': { name: 'create_organization' },

  // -- Directory Sync -- shortened names ----------------------------------------
  'GET /directory_groups': { name: 'list_groups' },
  'GET /directory_groups/{id}': { name: 'get_group' },
  'GET /directory_users': { name: 'list_users' },
  'GET /directory_users/{id}': { name: 'get_user' },

  // -- Audit Logs -- singularized names -----------------------------------------
  'POST /audit_logs/events': { name: 'create_event' },
  'POST /audit_logs/exports': { name: 'create_export' },
  'POST /audit_logs/actions/{actionName}/schemas': { name: 'create_schema' },

  // -- Feature Flags -- match SDK conventions -----------------------------------
  'POST /feature-flags/{slug}/targets/{resourceId}': { name: 'add_flag_target' },
  'DELETE /feature-flags/{slug}/targets/{resourceId}': {
    name: 'remove_flag_target',
  },

  // -- Organizations -- audit log config (singular fetch, not a list) -----------
  'GET /organizations/{id}/audit_log_configuration': {
    name: 'get_audit_log_configuration',
  },

  // -- Organizations -- audit logs retention (mounted on AuditLogs) -------------
  'GET /organizations/{id}/audit_logs_retention': {
    name: 'get_organization_audit_logs_retention',
    mountOn: 'AuditLogs',
  },
  'PUT /organizations/{id}/audit_logs_retention': { mountOn: 'AuditLogs' },

  // -- Union split: POST /user_management/authenticate (8 variants) -------------
  'POST /user_management/authenticate': {
    split: [
      {
        name: 'authenticate_with_password',
        targetVariant: 'PasswordSessionAuthenticateRequest',
        defaults: { grant_type: 'password' },
        inferFromClient: ['client_id', 'client_secret'],
        exposedParams: ['email', 'password', 'invitation_token', 'ip_address', 'device_id', 'user_agent'],
        optionalParams: ['invitation_token', 'ip_address', 'device_id', 'user_agent'],
      },
      {
        name: 'authenticate_with_code',
        targetVariant: 'AuthorizationCodeSessionAuthenticateRequest',
        defaults: { grant_type: 'authorization_code' },
        inferFromClient: ['client_id', 'client_secret'],
        exposedParams: ['code', 'code_verifier', 'invitation_token', 'ip_address', 'device_id', 'user_agent'],
        optionalParams: ['code_verifier', 'invitation_token', 'ip_address', 'device_id', 'user_agent'],
      },
      {
        name: 'authenticate_with_refresh_token',
        targetVariant: 'RefreshTokenSessionAuthenticateRequest',
        defaults: { grant_type: 'refresh_token' },
        inferFromClient: ['client_id', 'client_secret'],
        exposedParams: ['refresh_token', 'organization_id', 'ip_address', 'device_id', 'user_agent'],
        optionalParams: ['organization_id', 'ip_address', 'device_id', 'user_agent'],
      },
      {
        name: 'authenticate_with_magic_auth',
        targetVariant: 'MagicAuthCodeSessionAuthenticateRequest',
        defaults: { grant_type: 'urn:workos:oauth:grant-type:magic-auth:code' },
        inferFromClient: ['client_id', 'client_secret'],
        exposedParams: ['code', 'email', 'invitation_token', 'ip_address', 'device_id', 'user_agent'],
        optionalParams: ['invitation_token', 'ip_address', 'device_id', 'user_agent'],
      },
      {
        name: 'authenticate_with_email_verification',
        targetVariant: 'EmailVerificationCodeSessionAuthenticateRequest',
        defaults: { grant_type: 'urn:workos:oauth:grant-type:email-verification:code' },
        inferFromClient: ['client_id', 'client_secret'],
        exposedParams: ['code', 'pending_authentication_token', 'ip_address', 'device_id', 'user_agent'],
        optionalParams: ['ip_address', 'device_id', 'user_agent'],
      },
      {
        name: 'authenticate_with_totp',
        targetVariant: 'MFATotpSessionAuthenticateRequest',
        defaults: { grant_type: 'urn:workos:oauth:grant-type:mfa-totp' },
        inferFromClient: ['client_id', 'client_secret'],
        exposedParams: [
          'code',
          'pending_authentication_token',
          'authentication_challenge_id',
          'ip_address',
          'device_id',
          'user_agent',
        ],
        optionalParams: ['ip_address', 'device_id', 'user_agent'],
      },
      {
        name: 'authenticate_with_organization_selection',
        targetVariant: 'OrganizationSelectionSessionAuthenticateRequest',
        defaults: { grant_type: 'urn:workos:oauth:grant-type:organization-selection' },
        inferFromClient: ['client_id', 'client_secret'],
        exposedParams: ['pending_authentication_token', 'organization_id', 'ip_address', 'device_id', 'user_agent'],
        optionalParams: ['ip_address', 'device_id', 'user_agent'],
      },
      {
        name: 'authenticate_with_device_code',
        targetVariant: 'DeviceCodeSessionAuthenticateRequest',
        defaults: { grant_type: 'urn:ietf:params:oauth:grant-type:device_code' },
        inferFromClient: ['client_id'],
        exposedParams: ['device_code', 'ip_address', 'device_id', 'user_agent'],
        optionalParams: ['ip_address', 'device_id', 'user_agent'],
      },
    ],
  },

  // -- Union split: POST /connect/applications (2 variants) ---------------------
  'POST /connect/applications': {
    split: [
      {
        name: 'create_oauth_application',
        targetVariant: 'CreateOAuthApplication',
        defaults: { application_type: 'oauth' },
        exposedParams: [
          'name',
          'is_first_party',
          'description',
          'scopes',
          'redirect_uris',
          'uses_pkce',
          'organization_id',
        ],
      },
      {
        name: 'create_m2m_application',
        targetVariant: 'CreateM2MApplication',
        defaults: { application_type: 'm2m' },
        exposedParams: ['name', 'organization_id', 'description', 'scopes'],
      },
    ],
  },
};

// ---------------------------------------------------------------------------
// Mount rules -- service-level remounting. Maps IR service name -> target
// service/namespace (PascalCase). All operations in the source service are
// mounted on the target unless overridden per-operation in operationHints.
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Model placement hints — used by emitters that call `assignModelsToServices`
// so hinted models land in the configured service instead of the default
// first-reference winner.
// ---------------------------------------------------------------------------
export const modelHints: Record<string, string> = {
  // `UserlandUser` (→ `User`) is referenced from both UserManagement and
  // Authorization paths; pin it to the IR service that mounts onto
  // UserManagement so hand-written imports in existing SDKs keep resolving.
  User: 'UserManagementUsers',
  UserOrganizationMembershipBaseListData: 'Groups',
  // Keep this family pinned for non-Node SDKs that rely on existing
  // user-management model placement. Node freshens newly-adopted API key
  // method models in the emitter, so this global hint does not force the
  // generated Node user API key payloads into UserManagement.
  UserApiKeyOwner: 'UserManagementUsers',
};

// ---------------------------------------------------------------------------
// Schema name transform — explicit renames + suffix stripping applied during
// IR extraction. Keeps Dto/Json/Urn… schema names consistent with the names
// already exposed by the SDKs.
// ---------------------------------------------------------------------------
const COLLISION_RENAMES: Record<string, string> = {
  Error: 'ErrorResponse',
  Object: 'VaultObject',
  OrganizationDto: 'OrganizationInput',
  RedirectUriDto: 'RedirectUriInput',
  AuditLogSchemaDto: 'AuditLogSchemaInput',
  AuditLogSchemaActorDto: 'AuditLogSchemaActorInput',
  AuditLogSchemaTargetDto: 'AuditLogSchemaTargetInput',
  // Generic list-derived names that need domain-specific identifiers
  ListData: 'Role',
  ListModel: 'RoleList',
  // Double-List naming artifact
  EventListListMetadata: 'EventListMetadata',
  RadarAction: 'RadarListAction',
  RadarType: 'RadarListType',
};

export function schemaNameTransform(name: string): string {
  if (COLLISION_RENAMES[name]) return COLLISION_RENAMES[name];
  return name
    .replace(/Dto/g, '')
    .replace(/DTO/g, '')
    .replace(/Json$/, '')
    .replace(/^Urn(?:IetfParams|Workos)O[Aa]uthGrantType/, '');
}

// ---------------------------------------------------------------------------
// Pre-IR spec overlay -- patch around upstream spec quirks that would otherwise
// emit breaking SDK changes. See docs/breaking-change-playbook.md and the
// oagen `transformSpec` docs for usage. Reach for this only when the upstream
// fix can't land in time AND the change is genuinely additive.
// ---------------------------------------------------------------------------
export function transformSpec(spec: OpenApiDocument): OpenApiDocument {
  const components = (spec as { components?: { schemas?: Record<string, Record<string, unknown>> } }).components;
  const schemas = components?.schemas;
  const paths = (spec as { paths?: Record<string, Record<string, unknown>> }).paths;
  if (!schemas || !paths) return spec;

  // -- Fork: UserlandUserOrganizationMembershipBase{,List} --------------------
  // Upstream forked the existing `…BaseList` into `…BaseWithUserList` to add
  // a `user` field on the inline list-item shape. That fork renames the
  // generated list-data type in dotnet/go/ruby, breaking compat. Re-point the
  // forked $refs at the original list and merge the new `user` field
  // additively into the original's inline item shape.
  const forkedListRef = '#/components/schemas/UserlandUserOrganizationMembershipBaseWithUserList';
  const originalListRef = '#/components/schemas/UserlandUserOrganizationMembershipBaseList';
  for (const pathItem of Object.values(paths)) {
    for (const op of Object.values(pathItem)) {
      const responses = (op as { responses?: Record<string, { content?: Record<string, { schema?: { $ref?: string } }> }> })
        .responses;
      const schema = responses?.['200']?.content?.['application/json']?.schema;
      if (schema?.$ref === forkedListRef) {
        schema.$ref = originalListRef;
      }
    }
  }
  const baseList = schemas['UserlandUserOrganizationMembershipBaseList'];
  const itemProps = (
    baseList as
    | {
      properties?: {
        data?: { items?: { properties?: Record<string, unknown>; required?: string[] } };
      };
    }
    | undefined
  )?.properties?.data?.items;
  if (itemProps?.properties && !itemProps.properties.user) {
    itemProps.properties.user = {
      $ref: '#/components/schemas/UserlandUser',
      description: 'The user that belongs to the organization through this membership.',
    } as unknown as Record<string, unknown>;
    if (itemProps.required && !itemProps.required.includes('user')) {
      itemProps.required.push('user');
    }
  }
  delete schemas['UserlandUserOrganizationMembershipBaseWithUser'];
  delete schemas['UserlandUserOrganizationMembershipBaseWithUserList'];

  // -- Rename: JwtTemplate -> JwtTemplateResponse -----------------------------
  // Upstream renamed the response schema. Existing SDKs already expose the
  // type as `JwtTemplateResponse`/`JWTTemplateResponse`; preserve that name.
  if (schemas['JwtTemplate'] && !schemas['JwtTemplateResponse']) {
    schemas['JwtTemplateResponse'] = schemas['JwtTemplate'];
    delete schemas['JwtTemplate'];
    const oldRef = '#/components/schemas/JwtTemplate';
    const newRef = '#/components/schemas/JwtTemplateResponse';
    for (const pathItem of Object.values(paths)) {
      for (const op of Object.values(pathItem)) {
        const responses = (op as { responses?: Record<string, { content?: Record<string, { schema?: { $ref?: string } }> }> })
          .responses;
        for (const response of Object.values(responses ?? {})) {
          const schema = response.content?.['application/json']?.schema;
          if (schema?.$ref === oldRef) schema.$ref = newRef;
        }
      }
    }
  }

  return spec;
}
