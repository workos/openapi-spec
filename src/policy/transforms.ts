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
