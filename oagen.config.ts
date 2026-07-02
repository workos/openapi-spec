import type { OagenConfig } from '@workos/oagen';
import { workosEmittersPlugin } from '@workos/oagen-emitters';
import { createRequire } from 'node:module';
import {
  modelHints,
  mountRules,
  nestjsOperationIdTransform,
  operationHints,
  schemaNameTransform,
  transformSpec,
} from './src/policy/index.js';

const require = createRequire(import.meta.url);
const nodeOperationOverrides = require('./operationOverrides.node.json') as Record<
  string,
  {
    methodName?: string;
    mountOn?: string;
    optionsType?: string;
    bodyFieldMap?: Record<string, string>;
    returnType?: string;
    returnDataProperty?: string;
    returnTypeImports?: string[];
    returnExpression?: string;
  }
>;

const config: OagenConfig = {
  ...workosEmittersPlugin,
  docUrl: 'https://workos.com/docs',
  operationIdTransform: nestjsOperationIdTransform,
  schemaNameTransform,
  operationHints,
  mountRules,
  modelHints,
  emitterOptions: {
    node: {
      // Existing workos-node services remain hand-maintained unless their
      // files were already oagen-managed. Missing generated surfaces are
      // adopted from the spec automatically so new APIs don't require a
      // service-by-service allowlist.
      adoptMissingServices: true,
      ownedServices: ['Groups', 'Webhooks', 'Radar', 'Connect', 'Vault', 'AdminPortal', 'MultiFactorAuth', 'Widgets', 'OrganizationDomains', 'Pipes', 'DirectorySync', 'AuditLogs', 'Organizations'],
      // DirectorySync exposes custom-attributes generics the OpenAPI spec
      // cannot express (e.g. `DirectoryUserWithGroups<TCustomAttributes>`).
      // Keep these hand-written declarations authoritative: the emitter skips
      // generating them and routes imports/barrel exports to the existing file.
      handOwnedTypes: [
        'DefaultCustomAttributes',
        'DirectoryUser',
        'DirectoryUserResponse',
        'DirectoryUserWithGroups',
        'DirectoryUserWithGroupsResponse',
        // Event-payload shapes (directory.* webhook events) the spec does not
        // model; kept in hand-owned event-directory.{interface,serializer}.ts.
        'EventDirectory',
        'EventDirectoryResponse',
      ],
      regenerateOwnedTests: true,
      operationOverrides: nodeOperationOverrides,
      // The spec reports raw directory states (linked/unlinked/...), but the
      // Node SDK has always surfaced linked→active / unlinked→inactive. Generate
      // that translation: the emitter emits the domain type (DirectoryState),
      // the raw-wire companion (DirectoryStateResponse), the wire→domain
      // deserializer, and tests — instead of hand-owning it.
      enumValueRemaps: {
        DirectoryState: { linked: 'active', unlinked: 'inactive' },
      },
    },
  },
  transformSpec,
};
export default config;
