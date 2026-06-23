import { toCamelCase } from '@workos/oagen';
import type { OpenApiDocument } from './types.js';

/**
 * NestJS-style operationId transform. Strips "Controller" and extracts the
 * action after the first underscore: `FooController_bar` -> `bar`.
 */
export function nestjsOperationIdTransform(id: string): string {
  const stripped = id.replace(/Controller/g, '');
  const idx = stripped.indexOf('_');
  return idx !== -1 ? toCamelCase(stripped.slice(idx + 1)) : toCamelCase(stripped);
}

/**
 * Explicit renames plus suffix stripping applied during IR schema extraction.
 * Keeps `Dto`/`Json`/`Urn…` schema names consistent with the names already
 * exposed by the published SDKs.
 */
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

/**
 * Pre-IR spec overlay — patch around upstream spec quirks that would otherwise
 * emit breaking SDK changes. See docs/breaking-change-playbook.md and the
 * oagen `transformSpec` docs for usage. Reach for this only when the upstream
 * fix can't land in time AND the change is genuinely additive.
 */
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

  // -- Pipes: access token `expires_at` is missing `format: date-time` -------
  // The schema documents an ISO-8601 timestamp (description and example) and
  // the published Node SDK already exposes the field as `Date | null`.
  // Without the format hint the Node emitter keeps the baseline `Date` type
  // on the interface but skips the `new Date(...)` conversion in the
  // generated serializer, producing invalid TypeScript (TS2322).
  const tokenResponse = schemas['DataIntegrationAccessTokenResponse'] as
    | {
      oneOf?: Array<{
        properties?: {
          access_token?: { properties?: { expires_at?: Record<string, unknown> } };
          error?: { enum?: string[] };
        };
      }>;
    }
    | undefined;
  for (const variant of tokenResponse?.oneOf ?? []) {
    const expiresAt = variant.properties?.access_token?.properties?.expires_at;
    if (expiresAt && expiresAt.format === undefined) {
      expiresAt.format = 'date-time';
    }
    // The published SDK union is `'not_installed' | 'needs_reauthorization'`.
    // Keep the enum in that order so the generated const-object interns the
    // string literal types in the same order TypeScript renders for the
    // existing hand-written union — otherwise the compat snapshot reports a
    // (purely cosmetic) union-member reorder as a type change. Wire values
    // are unchanged; enum order carries no wire semantics.
    const errorEnum = variant.properties?.error?.enum;
    if (
      Array.isArray(errorEnum) &&
      errorEnum.length === 2 &&
      errorEnum[0] === 'needs_reauthorization' &&
      errorEnum[1] === 'not_installed'
    ) {
      errorEnum.reverse();
    }
  }

  // -- Pipes: token endpoint path param `slug` -> `provider` ------------------
  // The published Node SDK exposes the token method as
  // `getAccessToken({ provider, ... })`. Upstream names the path parameter
  // `slug` (consistent with the newer authorize/connected-account endpoints),
  // but renaming it for this one endpoint preserves the established `provider`
  // argument name. The newer endpoints keep the spec's `slug`. The wire path is
  // unchanged — the placeholder name does not affect the request URL, only the
  // generated argument/field name.
  const slugTokenPath = '/data-integrations/{slug}/token';
  const providerTokenPath = '/data-integrations/{provider}/token';
  const tokenPathItem = paths[slugTokenPath] as
    | Record<string, { parameters?: Array<{ name?: string; in?: string }> }>
    | undefined;
  if (tokenPathItem && !paths[providerTokenPath]) {
    for (const [key, member] of Object.entries(tokenPathItem)) {
      // Path-item-level shared params live under `parameters`; operation-level
      // params live under each HTTP verb. Handle both.
      const params = key === 'parameters' ? (member as unknown as Array<{ name?: string; in?: string }>) : member?.parameters;
      for (const param of params ?? []) {
        if (param.in === 'path' && param.name === 'slug') {
          param.name = 'provider';
        }
      }
    }
    paths[providerTokenPath] = tokenPathItem as unknown as Record<string, unknown>;
    delete paths[slugTokenPath];
  }

  // -- Pipes: token request `organization_id` is nullable for compat ---------
  // The published Node SDK types `getAccessToken`'s `organizationId` as
  // `string | null`, and the generated method reuses that baseline options
  // type. Mark the request body field nullable so the generated request type
  // (and its serializer) accept `string | null` too — otherwise passing the
  // baseline-typed options into the serializer fails to type-check. `null` is
  // wire-equivalent to omitting the field.
  const tokenRequestSchema = (
    paths[providerTokenPath] as
    | {
      post?: {
        requestBody?: {
          content?: Record<string, { schema?: { properties?: Record<string, Record<string, unknown>> } }>;
        };
      };
    }
    | undefined
  )?.post?.requestBody?.content?.['application/json']?.schema;
  const orgIdProp = tokenRequestSchema?.properties?.organization_id;
  if (orgIdProp && orgIdProp.type === 'string') {
    orgIdProp.type = ['string', 'null'];
  }

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

  // -- OrganizationDomain: collapse the duplicate StandAlone shape ------------
  // Upstream models the same organization-domain resource two ways: GET
  // `/organization_domains/{id}` and POST `…/verify` return the named
  // `OrganizationDomainStandAlone` component, while POST `/organization_domains`
  // (create) returns an *inline* object that is byte-for-byte identical to it.
  // Because one is a `$ref` and the other is inline, oagen emits two parallel
  // types (`OrganizationDomain` from the inline create response,
  // `OrganizationDomainStandAlone` from the component) with two parallel —
  // and TypeScript-incompatible — `state`/`verification_strategy` enum types.
  // The published SDKs only ever exposed a single `OrganizationDomain`.
  //
  // Rename the component to `OrganizationDomain` (the established public name;
  // there is no bare `OrganizationDomain` component to collide with) and
  // re-point both the GET/verify `$ref`s and the inline create response at it,
  // so every method returns one `OrganizationDomain` type. This is additive for
  // SDKs that have not adopted the resource yet (`OrganizationDomainStandAlone`
  // is net-new in this spec) and compat-preserving for those that have. The
  // durable fix is upstream: the create controller should return the typed
  // entity (a `$ref`) instead of an inline DTO, and the class should be named
  // `OrganizationDomain`.
  if (schemas['OrganizationDomainStandAlone'] && !schemas['OrganizationDomain']) {
    schemas['OrganizationDomain'] = schemas['OrganizationDomainStandAlone'];
    delete schemas['OrganizationDomainStandAlone'];
    const oldRef = '#/components/schemas/OrganizationDomainStandAlone';
    const newRef = '#/components/schemas/OrganizationDomain';
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
    // The create response is inline (not a `$ref`), so the loop above misses
    // it. Replace the inline schema with the shared component reference,
    // discarding the duplicate inline shape (and its `x-inline-with-overrides`
    // marker) entirely.
    const createJson = (
      paths['/organization_domains'] as
      | { post?: { responses?: Record<string, { content?: Record<string, { schema?: { $ref?: string } }> }> } }
      | undefined
    )?.post?.responses?.['201']?.content?.['application/json'];
    if (createJson && !createJson.schema?.$ref) {
      createJson.schema = { $ref: newRef };
    }
  }

  // -- GroupRoleAssignmentList: collapse inline list_metadata to shared $ref --
  // Upstream defines `GroupRoleAssignmentList.list_metadata` as an inline
  // object that is byte-for-byte identical (modulo the `example` strings) to
  // `AuthorizationPermissionList.list_metadata`. Both resources live in the
  // `authorization` namespace, so the structural-dedup pass in the python and
  // dotnet emitters collapses the two anonymous metadata models and emits a
  // broken cross-reference for the loser:
  //   - python: group_role_assignment_list_list_metadata.py imports
  //     `workos.common.models.authorization_permission_list_list_metadata`,
  //     a module that is never generated (reportMissingImports).
  //   - dotnet: GroupRoleAssignmentList.cs references the deduped-away type
  //     `GroupRoleAssignmentListListMetadata` (CS0246).
  // `GroupRoleAssignmentList` is net-new in this spec, so re-pointing its
  // metadata at the shared `ListMetadata` component is purely additive (no
  // compat baseline) and stops a per-list metadata model from being generated
  // at all — the same shape `ObjectListResponse` already uses. The durable fix
  // is upstream (the NestJS DTO should reference the shared ListMetadata class)
  // plus hardening the emitter dedup to emit correct cross-module import paths.
  if (schemas['ListMetadata']) {
    const groupRoleList = schemas['GroupRoleAssignmentList'] as
      | { properties?: { list_metadata?: { $ref?: string; properties?: unknown } } }
      | undefined;
    const listMetadata = groupRoleList?.properties?.list_metadata;
    if (listMetadata && !listMetadata.$ref && listMetadata.properties) {
      groupRoleList!.properties!.list_metadata = {
        $ref: '#/components/schemas/ListMetadata',
      };
    }
  }

  // -- OrganizationDomain: collapse the duplicate StandAlone shape ------------
  // Upstream models the same organization-domain resource two ways: GET
  // `/organization_domains/{id}` and POST `…/verify` return the named
  // `OrganizationDomainStandAlone` component, while POST `/organization_domains`
  // (create) returns an *inline* object that is byte-for-byte identical to it.
  // Because one is a `$ref` and the other is inline, oagen emits two parallel
  // types (`OrganizationDomain` from the inline create response,
  // `OrganizationDomainStandAlone` from the component) with two parallel —
  // and TypeScript-incompatible — `state`/`verification_strategy` enum types.
  // The published SDKs only ever exposed a single `OrganizationDomain`.
  //
  // Rename the component to `OrganizationDomain` (the established public name;
  // there is no bare `OrganizationDomain` component to collide with) and
  // re-point both the GET/verify `$ref`s and the inline create response at it,
  // so every method returns one `OrganizationDomain` type. This is additive for
  // SDKs that have not adopted the resource yet (`OrganizationDomainStandAlone`
  // is net-new in this spec) and compat-preserving for those that have. The
  // durable fix is upstream: the create controller should return the typed
  // entity (a `$ref`) instead of an inline DTO, and the class should be named
  // `OrganizationDomain`.
  if (schemas['OrganizationDomainStandAlone'] && !schemas['OrganizationDomain']) {
    schemas['OrganizationDomain'] = schemas['OrganizationDomainStandAlone'];
    delete schemas['OrganizationDomainStandAlone'];
    const oldRef = '#/components/schemas/OrganizationDomainStandAlone';
    const newRef = '#/components/schemas/OrganizationDomain';
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
    // The create response is inline (not a `$ref`), so the loop above misses
    // it. Replace the inline schema with the shared component reference,
    // discarding the duplicate inline shape (and its `x-inline-with-overrides`
    // marker) entirely.
    const createJson = (
      paths['/organization_domains'] as
      | { post?: { responses?: Record<string, { content?: Record<string, { schema?: { $ref?: string } }> }> } }
      | undefined
    )?.post?.responses?.['201']?.content?.['application/json'];
    if (createJson && !createJson.schema?.$ref) {
      createJson.schema = { $ref: newRef };
    }
  }

  return spec;
}
