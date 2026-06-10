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
      ownedServices: ['Groups', 'Webhooks', 'Radar', 'Connect', 'Vault', 'Widgets'],
      regenerateOwnedTests: true,
      operationOverrides: nodeOperationOverrides,
    },
  },
  transformSpec,
};
export default config;
