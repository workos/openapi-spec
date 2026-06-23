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

  return spec;
}
