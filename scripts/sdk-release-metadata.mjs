#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCOPE_LABELS = {
  admin_portal: 'admin portal',
  api_keys: 'API key',
  audit_logs: 'audit log',
  authorization: 'authorization',
  connect: 'Connect',
  directory_sync: 'directory sync',
  events: 'events',
  feature_flags: 'feature flag',
  fga: 'FGA',
  groups: 'groups',
  multi_factor_auth: 'MFA',
  organization_domains: 'organization domain',
  organization_membership: 'organization membership',
  organizations: 'organization',
  passwordless: 'passwordless',
  pipes: 'Pipes',
  radar: 'radar',
  roles: 'roles',
  sso: 'SSO',
  user_management: 'user management',
  vault: 'vault',
  webhooks: 'webhook',
  widgets: 'widget',
  client: 'client',
  sdk: 'SDK',
};

const SCOPE_DOC_URLS = {
  admin_portal: 'https://workos.com/docs/reference/admin-portal',
  api_keys: 'https://workos.com/docs/reference/authkit/api-keys',
  audit_logs: 'https://workos.com/docs/reference/audit-logs',
  authorization: 'https://workos.com/docs/reference/fga',
  connect: 'https://workos.com/docs/reference/workos-connect/standalone',
  directory_sync: 'https://workos.com/docs/reference/directory-sync',
  events: 'https://workos.com/docs/reference/events',
  feature_flags: 'https://workos.com/docs/reference/feature-flags',
  fga: 'https://workos.com/docs/reference/fga',
  groups: 'https://workos.com/docs/reference/groups',
  multi_factor_auth: 'https://workos.com/docs/reference/authkit/mfa',
  organization_domains: 'https://workos.com/docs/reference/domain-verification',
  organization_membership: 'https://workos.com/docs/reference/authkit/organization-membership',
  organizations: 'https://workos.com/docs/reference/organization',
  pipes: 'https://workos.com/docs/reference/pipes',
  radar: 'https://workos.com/docs/reference/radar',
  sso: 'https://workos.com/docs/reference/sso',
  user_management: 'https://workos.com/docs/reference/authkit/user',
  vault: 'https://workos.com/docs/reference/vault',
  webhooks: 'https://workos.com/docs/reference/webhooks',
  widgets: 'https://workos.com/docs/reference/widgets',
  client: 'https://workos.com/docs/reference',
};

const SERVICE_SCOPE_OVERRIDES = new Map(
  Object.entries({
    ApplicationClientSecrets: 'connect',
    Applications: 'connect',
    Connections: 'sso',
    Directories: 'directory_sync',
    DirectoryGroups: 'directory_sync',
    DirectoryUsers: 'directory_sync',
    FeatureFlagsTargets: 'feature_flags',
    MultiFactorAuthChallenges: 'multi_factor_auth',
    OrganizationsApiKeys: 'api_keys',
    OrganizationsFeatureFlags: 'feature_flags',
    Permissions: 'authorization',
    PipesProvider: 'pipes',
    UserManagementAuthentication: 'user_management',
    UserManagementCorsOrigins: 'user_management',
    UserManagementDataProviders: 'pipes',
    UserManagementInvitations: 'user_management',
    UserManagementJWTTemplate: 'user_management',
    UserManagementMagicAuth: 'user_management',
    UserManagementMultiFactorAuthentication: 'multi_factor_auth',
    UserManagementOrganizationMembership: 'organization_membership',
    UserManagementOrganizationMembershipGroups: 'organization_membership',
    UserManagementRedirectUris: 'user_management',
    UserManagementSessionTokens: 'user_management',
    UserManagementUsers: 'user_management',
    UserManagementUsersAuthorizedApplications: 'user_management',
    UserManagementUsersFeatureFlags: 'feature_flags',
    WorkosConnect: 'connect',
  }),
);

function printHelp() {
  process.stdout.write(`Usage:
  node scripts/sdk-release-metadata.mjs --diff-report <file> --old-ir <file> --new-ir <file> [options]
  node scripts/sdk-release-metadata.mjs --spec-commit <sha> [options]

Build deterministic SDK release metadata from structured OpenAPI and compat diffs.

Inputs:
  --diff-report <file>   JSON output from "oagen diff".
  --old-ir <file>        JSON output from "oagen parse" for the previous spec.
  --new-ir <file>        JSON output from "oagen parse" for the current spec.
  --compat-report <file> Optional SDK compat report JSON. When omitted and
                         --sdk-repo is given, one is derived from the checkout
                         (baseline ref vs current tree) without regenerating.
  --changed-files <file> Optional newline-delimited SDK file list for file attribution.

Commit convenience:
  --spec-commit <sha>    Use the spec state at this openapi-spec commit, then diff
                         against the previous spec-changing commit.
  --openapi-repo <path>  openapi-spec checkout for --spec-commit. Defaults to cwd.
  --spec-path <path>     Spec path in the repo. Defaults to spec/open-api-spec.yaml.
  --sdk-repo <path>      SDK checkout used to derive changed files and, when
                         --compat-report is omitted, an SDK compat report.
  --sdk-base <rev>       Diff base for --sdk-repo. Defaults to origin/main...HEAD.
  --lang <language>      SDK language for compat extraction. Inferred from the
                         --sdk-repo basename (e.g. workos-python → python).

Output:
  --format json          Default. Emits entries consumed by generate-prs.yml.
                         Includes scope_sources/scope_candidates provenance.
  --format changelog     Emits markdown sections for manual .changelog-pending repair.
                         Known scopes include docs_url metadata and render as
                         docs links in changelog markdown.
  --strict-scopes        Fail when a user-facing entry resolves to sdk or lacks
                         docs_url metadata.
  --pr-number <number>   Optional, changelog format only. Adds a linked PR heading.
  --pr-url <url>         Optional, changelog format only. Adds a linked PR heading.
  --output <file>        Write output to a file instead of stdout.

Examples:
  node scripts/sdk-release-metadata.mjs --spec-commit dee95fc --sdk-repo ../backend/workos-dotnet

  node scripts/sdk-release-metadata.mjs \\
    --spec-commit dee95fc \\
    --sdk-repo ../backend/workos-dotnet \\
    --format changelog \\
    --pr-number 263 \\
    --pr-url https://github.com/workos/workos-dotnet/pull/263
`);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-h') {
      args.help = 'true';
      continue;
    }
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const value = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
    args[key] = value;
  }
  return args;
}

function readJson(path, fallback) {
  if (!path || !existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, 'utf8'));
}

function readLines(path) {
  if (!path || !existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function changedFilesFromArgs(args) {
  if (args['changed-files']) return readLines(args['changed-files']);
  if (!args['sdk-repo']) return [];
  const base = args['sdk-base'] ?? 'origin/main...HEAD';
  return run('git', ['-C', args['sdk-repo'], 'diff', '--name-only', base])
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function run(command, args, opts = {}) {
  try {
    return execFileSync(command, args, {
      cwd: opts.cwd,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    if (opts.allowExitCodes?.includes(err.status)) return err.stdout;
    throw err;
  }
}

function git(repo, args) {
  return run('git', ['-C', repo, ...args]).trim();
}

function prepareSpecInputs(args) {
  if (!args['spec-commit']) return args;

  const repo = args['openapi-repo'] ?? process.cwd();
  const specPath = args['spec-path'] ?? 'spec/open-api-spec.yaml';
  const commit = args['spec-commit'];
  const tmp = mkdtempSync(join(tmpdir(), 'sdk-release-metadata-'));

  try {
    const currentSpecCommit = git(repo, ['log', '--format=%H', '-n', '1', commit, '--', specPath]);
    if (!currentSpecCommit) {
      throw new Error(`No spec commit found at or before ${commit} for ${specPath}`);
    }
    const previousCommit = git(repo, ['log', '--format=%H', '-n', '1', `${currentSpecCommit}^`, '--', specPath]);
    if (!previousCommit) {
      throw new Error(`No previous spec commit found before ${currentSpecCommit} for ${specPath}`);
    }

    const oldSpecPath = join(tmp, 'old-open-api-spec.yaml');
    const newSpecPath = join(tmp, 'new-open-api-spec.yaml');
    const oldIrPath = join(tmp, 'old-ir.json');
    const newIrPath = join(tmp, 'new-ir.json');
    const diffPath = join(tmp, 'diff-report.json');

    writeFileSync(oldSpecPath, run('git', ['-C', repo, 'show', `${previousCommit}:${specPath}`]));
    writeFileSync(newSpecPath, run('git', ['-C', repo, 'show', `${commit}:${specPath}`]));
    writeFileSync(oldIrPath, run('npx', ['oagen', 'parse', '--spec', oldSpecPath], { cwd: repo }));
    writeFileSync(newIrPath, run('npx', ['oagen', 'parse', '--spec', newSpecPath], { cwd: repo }));
    writeFileSync(
      diffPath,
      run('npx', ['oagen', 'diff', '--old', oldSpecPath, '--new', newSpecPath], {
        cwd: repo,
        allowExitCodes: [1, 2],
      }),
    );

    return {
      ...args,
      'diff-report': args['diff-report'] ?? diffPath,
      'old-ir': args['old-ir'] ?? oldIrPath,
      'new-ir': args['new-ir'] ?? newIrPath,
      _tmpdir: tmp,
    };
  } catch (err) {
    rmSync(tmp, { recursive: true, force: true });
    throw err;
  }
}

function inferLanguage(sdkRepo) {
  const base =
    String(sdkRepo)
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .pop() ?? '';
  const match = base.match(/^workos-(.+)$/);
  return match ? match[1] : base;
}

// Derive an SDK compat report from an existing checkout WITHOUT regenerating
// the SDK: snapshot the current tree (candidate) and the tree at the base ref
// (baseline, via a throwaway git worktree), then diff. This lets the changelog
// surface SDK-surface changes — e.g. a method rename — that the spec diff alone
// cannot see. Fails open: any problem just means the changelog is built from
// the spec diff only. Skipped when --compat-report is passed explicitly (so
// CI, which supplies its own per-language reports, is unaffected).
function prepareCompatInputs(args) {
  if (!args['sdk-repo'] || args['compat-report']) return args;

  const sdkRepo = args['sdk-repo'];
  const lang = args.lang ?? inferLanguage(sdkRepo);
  const openapiRepo = args['openapi-repo'] ?? process.cwd();
  const specPath = join(openapiRepo, args['spec-path'] ?? 'spec/open-api-spec.yaml');
  const rawBase = args['sdk-base'] ?? 'origin/main...HEAD';
  const leftRef = rawBase.split(/\.\.\.?/)[0] || 'origin/main';

  const tmp = mkdtempSync(join(tmpdir(), 'sdk-release-compat-'));
  const baselineSrc = join(tmp, 'baseline-src');
  let worktreeAdded = false;
  let succeeded = false;
  try {
    const baselineCommit = rawBase.includes('...')
      ? git(sdkRepo, ['merge-base', leftRef, 'HEAD'])
      : git(sdkRepo, ['rev-parse', leftRef]);

    git(sdkRepo, ['worktree', 'add', '--detach', baselineSrc, baselineCommit]);
    worktreeAdded = true;

    const baselineOut = join(tmp, 'baseline');
    const candidateOut = join(tmp, 'candidate');
    mkdirSync(baselineOut, { recursive: true });
    mkdirSync(candidateOut, { recursive: true });

    const extract = (sdkPath, output) =>
      run('npx', ['oagen', 'compat-extract', '--lang', lang, '--sdk-path', sdkPath, '--output', output, '--spec', specPath], {
        cwd: openapiRepo,
      });
    extract(baselineSrc, baselineOut);
    extract(sdkRepo, candidateOut);

    const reportPath = join(tmp, 'compat-report.json');
    run(
      'npx',
      [
        'oagen',
        'compat-diff',
        '--baseline',
        join(baselineOut, '.oagen-compat-snapshot.json'),
        '--candidate',
        join(candidateOut, '.oagen-compat-snapshot.json'),
        '--output',
        reportPath,
        '--fail-on',
        'none',
      ],
      { cwd: openapiRepo, allowExitCodes: [1] },
    );

    succeeded = true;
    return { ...args, 'compat-report': reportPath, _compatTmpdir: tmp };
  } catch (err) {
    process.stderr.write(
      `warning: could not derive SDK compat report (${err.message}); changelog will use the spec diff only\n`,
    );
    return args;
  } finally {
    if (worktreeAdded) {
      try {
        git(sdkRepo, ['worktree', 'remove', '--force', baselineSrc]);
      } catch {
        try {
          git(sdkRepo, ['worktree', 'prune']);
        } catch {
          // best-effort cleanup
        }
      }
    }
    if (!succeeded) rmSync(tmp, { recursive: true, force: true });
  }
}

function toSnakeCase(value) {
  return String(value)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

function normalize(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function sortStable(values) {
  return [...values].sort((a, b) => a.localeCompare(b));
}

function publicScopeFromService(serviceName) {
  if (!serviceName) return 'sdk';
  if (SERVICE_SCOPE_OVERRIDES.has(serviceName)) return SERVICE_SCOPE_OVERRIDES.get(serviceName);
  if (serviceName.startsWith('Directory')) return 'directory_sync';
  if (serviceName.startsWith('FeatureFlags')) return 'feature_flags';
  if (serviceName.startsWith('MultiFactorAuth')) return 'multi_factor_auth';
  if (serviceName.startsWith('OrganizationDomains')) return 'organization_domains';
  if (serviceName.startsWith('Organizations')) return 'organizations';
  if (serviceName.startsWith('UserManagement')) return 'user_management';
  return toSnakeCase(serviceName);
}

function scopeFromName(name) {
  if (!name) return 'sdk';

  if (/DataIntegration|Pipe/.test(name)) return 'pipes';
  if (/SessionAuthenticate/.test(name)) return 'user_management';
  if (/WebhookEndpointEvents|Webhook/.test(name)) return 'webhooks';
  if (/^(ApiKey|ExpireApiKey|OrganizationApiKey|UserApiKey)/.test(name)) return 'api_keys';
  if (/^(Dsync|Directory)/.test(name)) return 'directory_sync';
  if (/^Radar/.test(name)) return 'radar';
  if (/^(Vault|Object$|ObjectMetadata|ObjectSummary|ObjectVersion|ObjectWithoutValue)/.test(name)) return 'vault';
  if (/^AuditLog/.test(name)) return 'audit_logs';
  if (/^(Application|Connect|UserObject$|ApplicationCredentials|ExternalAuth|RedirectUriInput)/.test(name)) return 'connect';
  if (/^(Group|CreateGroup|UpdateGroup)/.test(name)) return 'groups';
  if (/OrganizationMembership/.test(name)) return 'organization_membership';
  if (/^OrganizationDomain/.test(name)) return 'organization_domains';
  if (/^Organization/.test(name)) return 'organizations';
  if (/^(Connection|SSO|Sso)/.test(name)) return 'sso';
  if (/^(AuthenticationFactor|AuthenticationChallenge|ChallengeAuthenticationFactor|MultiFactor|Mfa)/.test(name)) {
    return 'multi_factor_auth';
  }
  if (/^(FeatureFlag|Flag)/.test(name)) return 'feature_flags';
  if (/^(Invitation|MagicAuth|PasswordReset|RevokeSession|Session|User|CreateUser|UpdateUser|EmailChange)/.test(name)) {
    return 'user_management';
  }
  if (/^(Role|Permission)/.test(name)) return 'authorization';
  if (/^Widget/.test(name)) return 'widgets';
  if (/^Event/.test(name)) return 'events';

  return 'sdk';
}

function scopeFromFile(path) {
  const normalized = normalize(path);
  if (/apikey|apikeys|api_keys/.test(normalized)) return 'api_keys';
  if (/webhook/.test(normalized)) return 'webhooks';
  if (/auditlog|auditlogs|audit_logs/.test(normalized)) return 'audit_logs';
  if (/directorysync|directory_sync|dsync/.test(normalized)) return 'directory_sync';
  if (/radar/.test(normalized)) return 'radar';
  if (/vault|vaultobject/.test(normalized)) return 'vault';
  if (/connect|applicationcredential|externalauth|userobject/.test(normalized)) return 'connect';
  if (/featureflag|featureflags|feature_flags/.test(normalized)) return 'feature_flags';
  if (/multifactorauth|multi_factor_auth|mfa/.test(normalized)) return 'multi_factor_auth';
  if (/organizationdomain|organizationdomains|organization_domains/.test(normalized)) return 'organization_domains';
  if (/organizationmembership|organizationmemberships/.test(normalized)) return 'organization_membership';
  if (/organization|organizations/.test(normalized)) return 'organizations';
  if (/user_management|usermanagement|revoke_session|revokesession|createuser|updateuser/.test(normalized)) {
    return 'user_management';
  }
  if (/sso|connection/.test(normalized)) return 'sso';
  if (/group/.test(normalized)) return 'groups';
  if (/permission|role|authorization/.test(normalized)) return 'authorization';
  if (/widget/.test(normalized)) return 'widgets';
  return 'sdk';
}

function labelForScope(scope) {
  return SCOPE_LABELS[scope] ?? scope.replaceAll('_', ' ');
}

function docsUrlForScope(scope) {
  return SCOPE_DOC_URLS[scope];
}

function code(value) {
  return `\`${value}\``;
}

// Drill through wrappers (list/optional/etc.) to the underlying model or enum
// name, so a response/request type can be named in the changelog.
function primaryTypeName(type) {
  if (!type || typeof type !== 'object') return null;
  if ((type.kind === 'model' || type.kind === 'enum') && type.name) return type.name;
  return primaryTypeName(type.inner) ?? primaryTypeName(type.items) ?? null;
}

function buildIndexes(specs) {
  const modelByName = new Map();
  const enumByName = new Map();
  const enumWireValues = new Map();
  const symbolScopes = new Map();
  const operationByKey = new Map();
  const serviceNames = new Set();
  // Per-side (old vs new) maps of operation → response/request type name, used
  // to describe *what* changed in a modified operation. specs is [oldIr, newIr].
  const responseTypeByKey = { old: new Map(), new: new Map() };
  const requestTypeByKey = { old: new Map(), new: new Map() };
  specs.forEach((spec, i) => {
    const slot = i === 0 ? 'old' : 'new';
    for (const service of spec?.services ?? []) {
      for (const operation of service.operations ?? []) {
        const key = `${service.name}.${operation.name}`;
        const resp = primaryTypeName(operation.response);
        if (resp) responseTypeByKey[slot].set(key, resp);
        const req = primaryTypeName(operation.requestBody);
        if (req) requestTypeByKey[slot].set(key, req);
      }
    }
  });

  for (const spec of specs.filter(Boolean)) {
    for (const model of spec.models ?? []) modelByName.set(model.name, model);
    for (const enm of spec.enums ?? []) {
      enumByName.set(enm.name, enm);
      for (const value of enm.values ?? []) {
        enumWireValues.set(`${enm.name}.${value.name}`, value.value ?? value.name);
      }
    }
  }

  const addScope = (kind, name, scope) => {
    if (!name || !scope) return;
    const key = `${kind}:${name}`;
    const set = symbolScopes.get(key) ?? new Set();
    set.add(scope);
    symbolScopes.set(key, set);
  };

  const collectTypeRefs = (type, out) => {
    if (!type || typeof type !== 'object') return;
    if (type.kind === 'model') out.models.add(type.name);
    if (type.kind === 'enum') out.enums.add(type.name);
    if (type.inner) collectTypeRefs(type.inner, out);
    if (type.items) collectTypeRefs(type.items, out);
    if (type.values) collectTypeRefs(type.values, out);
    for (const variant of type.variants ?? []) collectTypeRefs(variant, out);
  };

  const collectModelClosure = (modelName, out, seen = new Set()) => {
    if (!modelName || seen.has(modelName)) return;
    seen.add(modelName);
    out.models.add(modelName);
    const model = modelByName.get(modelName);
    if (!model) return;
    for (const field of model.fields ?? []) {
      const nested = { models: new Set(), enums: new Set() };
      collectTypeRefs(field.type, nested);
      for (const enumName of nested.enums) out.enums.add(enumName);
      for (const nestedModel of nested.models) collectModelClosure(nestedModel, out, seen);
    }
  };

  for (const spec of specs.filter(Boolean)) {
    for (const service of spec.services ?? []) {
      const scope = publicScopeFromService(service.name);
      serviceNames.add(service.name);
      for (const operation of service.operations ?? []) {
        operationByKey.set(`${service.name}.${operation.name}`, operation);

        const direct = { models: new Set(), enums: new Set() };
        for (const param of [
          ...(operation.pathParams ?? []),
          ...(operation.queryParams ?? []),
          ...(operation.headerParams ?? []),
        ]) {
          collectTypeRefs(param.type, direct);
        }
        collectTypeRefs(operation.requestBody, direct);
        collectTypeRefs(operation.response, direct);
        for (const response of operation.successResponses ?? []) collectTypeRefs(response.type, direct);
        for (const error of operation.errors ?? []) collectTypeRefs(error.type, direct);

        const all = { models: new Set(), enums: new Set(direct.enums) };
        for (const modelName of direct.models) collectModelClosure(modelName, all);
        for (const modelName of all.models) addScope('model', modelName, scope);
        for (const enumName of all.enums) addScope('enum', enumName, scope);
      }
    }
  }

  const typeNames = new Set([...modelByName.keys(), ...enumByName.keys()]);
  return { enumWireValues, symbolScopes, operationByKey, responseTypeByKey, requestTypeByKey, serviceNames, typeNames };
}

function resolveServiceScope(serviceName) {
  const scope = publicScopeFromService(serviceName);
  const snake = toSnakeCase(serviceName);
  const source = SERVICE_SCOPE_OVERRIDES.has(serviceName)
    ? 'service_override'
    : scope === snake
      ? 'service_name'
      : 'service_rule';
  return { scope, source, candidates: [scope] };
}

function resolveSymbolScope(kind, name, indexes) {
  const refs = indexes.symbolScopes.get(`${kind}:${name}`);
  const candidates = refs ? sortStable([...refs]) : [];
  const fallback = scopeFromName(name);

  if (fallback !== 'sdk') {
    return {
      scope: fallback,
      source: candidates.includes(fallback) ? 'name_and_ir' : 'name',
      candidates,
    };
  }

  if (candidates.length === 1) {
    return { scope: candidates[0], source: 'ir', candidates };
  }
  if (candidates.length > 1) {
    return { scope: candidates[0], source: 'ir_ambiguous', candidates };
  }

  return { scope: 'sdk', source: 'unresolved', candidates: [] };
}

function scopeFields(resolution) {
  return {
    scope: resolution.scope,
    scope_source: resolution.source,
    scope_candidates: resolution.candidates,
  };
}

function enumDisplay(enumName, valueName, indexes) {
  const wire = indexes.enumWireValues.get(`${enumName}.${valueName}`);
  if (wire) return `\`${wire}\``;
  return `\`${valueName}\``;
}

function severityToPrefix(severity) {
  if (severity === 'breaking') return 'feat!';
  if (severity === 'additive') return 'feat';
  return 'fix';
}

// Per policy, only a changed call signature or a removed/renamed *type* is
// breaking. Field-, enum-value-, and response/request-shape changes are backend
// API changes — never breaking, even when the spec differ classifies them so.
// Cap those kinds: a would-be-breaking severity becomes `fix` (it is neither a
// feature nor a major bump); additive severities pass through unchanged.
const BACKEND_ONLY_DIFF_KINDS = new Set([
  'field-removed',
  'field-type-changed',
  'field-format-changed',
  'field-required-changed',
  'field-access-changed',
  'value-removed',
  'value-modified',
  'response-changed',
  'request-body-changed',
]);
function capSeverity(kind, severity) {
  return BACKEND_ONLY_DIFF_KINDS.has(kind) && severity === 'breaking' ? 'fix' : severity;
}

function addFact(facts, fact) {
  facts.push({
    symbols: [],
    scope_source: 'unknown',
    scope_candidates: [],
    ...fact,
    prefix: severityToPrefix(fact.severity),
  });
}

function operationDetail(change, indexes, action) {
  const operation = indexes.operationByKey.get(`${change.serviceName}.${change.operationName}`);
  if (operation?.httpMethod && operation?.path) {
    return `${action} endpoint \`${operation.httpMethod.toUpperCase()} ${operation.path}\`.`;
  }
  return `${action} operation in \`${change.serviceName}\`.`;
}

function factsFromDiff(diffReport, indexes) {
  const facts = [];
  for (const change of diffReport.changes ?? []) {
    if (change.kind === 'model-added') {
      const scope = resolveSymbolScope('model', change.name, indexes);
      addFact(facts, {
        severity: 'additive',
        ...scopeFields(scope),
        kind: change.kind,
        symbols: [change.name],
        detail: `Added model \`${change.name}\`.`,
      });
    } else if (change.kind === 'model-removed') {
      const scope = resolveSymbolScope('model', change.name, indexes);
      addFact(facts, {
        severity: 'breaking',
        ...scopeFields(scope),
        kind: change.kind,
        symbols: [change.name],
        detail: `Removed model \`${change.name}\`.`,
      });
    } else if (change.kind === 'model-modified') {
      const scope = resolveSymbolScope('model', change.name, indexes);
      for (const fieldChange of change.fieldChanges ?? []) {
        // The spec differ encodes a field's required/optional *direction* in the
        // classification (made-required reads as breaking). Capture it before the
        // severity is capped, since the changelog wording depends on it.
        const madeRequired = fieldChange.classification === 'breaking';
        let detail;
        if (fieldChange.kind === 'field-added') {
          detail = `Added \`${fieldChange.fieldName}\` to \`${change.name}\`.`;
        } else if (fieldChange.kind === 'field-removed') {
          detail = `Removed \`${fieldChange.fieldName}\` from \`${change.name}\`.`;
        } else if (fieldChange.kind === 'field-required-changed') {
          detail = madeRequired
            ? `Made \`${change.name}.${fieldChange.fieldName}\` required.`
            : `Made \`${change.name}.${fieldChange.fieldName}\` optional.`;
        } else if (fieldChange.kind === 'field-type-changed') {
          detail = `Changed the type of \`${change.name}.${fieldChange.fieldName}\`.`;
        } else if (fieldChange.kind === 'field-format-changed') {
          detail = `Changed the format of \`${change.name}.${fieldChange.fieldName}\`.`;
        } else {
          detail = `Changed access for \`${change.name}.${fieldChange.fieldName}\`.`;
        }
        addFact(facts, {
          severity: capSeverity(fieldChange.kind, fieldChange.classification),
          ...scopeFields(scope),
          kind: fieldChange.kind,
          symbols: [change.name, fieldChange.fieldName],
          fieldName: fieldChange.fieldName,
          modelName: change.name,
          ...(fieldChange.kind === 'field-required-changed' ? { madeRequired } : {}),
          detail,
        });
      }
    } else if (change.kind === 'enum-added') {
      const scope = resolveSymbolScope('enum', change.name, indexes);
      addFact(facts, {
        severity: 'additive',
        ...scopeFields(scope),
        kind: change.kind,
        symbols: [change.name],
        detail: `Added enum \`${change.name}\`.`,
      });
    } else if (change.kind === 'enum-removed') {
      const scope = resolveSymbolScope('enum', change.name, indexes);
      addFact(facts, {
        severity: 'breaking',
        ...scopeFields(scope),
        kind: change.kind,
        symbols: [change.name],
        detail: `Removed enum \`${change.name}\`.`,
      });
    } else if (change.kind === 'enum-modified') {
      const scope = resolveSymbolScope('enum', change.name, indexes);
      for (const valueChange of change.valueChanges ?? []) {
        let detail;
        if (valueChange.kind === 'value-added') {
          detail = `Added ${enumDisplay(change.name, valueChange.valueName, indexes)} to \`${change.name}\`.`;
        } else if (valueChange.kind === 'value-removed') {
          detail = `Removed ${enumDisplay(change.name, valueChange.valueName, indexes)} from \`${change.name}\`.`;
        } else {
          detail = `Changed ${enumDisplay(change.name, valueChange.valueName, indexes)} in \`${change.name}\`.`;
        }
        addFact(facts, {
          severity: capSeverity(valueChange.kind, valueChange.classification),
          ...scopeFields(scope),
          kind: valueChange.kind,
          symbols: [change.name, valueChange.valueName],
          enumName: change.name,
          valueName: valueChange.valueName,
          detail,
        });
      }
    } else if (change.kind === 'service-added') {
      const scope = resolveServiceScope(change.name);
      addFact(facts, {
        severity: 'additive',
        ...scopeFields(scope),
        kind: change.kind,
        symbols: [change.name],
        detail: `Added service \`${change.name}\`.`,
      });
    } else if (change.kind === 'service-removed') {
      const scope = resolveServiceScope(change.name);
      addFact(facts, {
        severity: 'breaking',
        ...scopeFields(scope),
        kind: change.kind,
        symbols: [change.name],
        detail: `Removed service \`${change.name}\`.`,
      });
    } else if (change.kind === 'operation-added') {
      const scope = resolveServiceScope(change.serviceName);
      addFact(facts, {
        severity: 'additive',
        ...scopeFields(scope),
        kind: change.kind,
        symbols: [change.serviceName, change.operationName],
        detail: operationDetail(change, indexes, 'Added'),
      });
    } else if (change.kind === 'operation-removed') {
      const scope = resolveServiceScope(change.serviceName);
      addFact(facts, {
        severity: 'breaking',
        ...scopeFields(scope),
        kind: change.kind,
        symbols: [change.serviceName, change.operationName],
        detail: operationDetail(change, indexes, 'Removed'),
      });
    } else if (change.kind === 'operation-modified') {
      const scope = resolveServiceScope(change.serviceName);
      for (const paramChange of change.paramChanges ?? []) {
        const severity = paramChange.classification;
        const param = `\`${change.serviceName}.${change.operationName}.${paramChange.paramName}\``;
        let detail;
        if (paramChange.kind === 'param-added') detail = `Added parameter ${param}.`;
        else if (paramChange.kind === 'param-removed') detail = `Removed parameter ${param}.`;
        else if (paramChange.kind === 'param-required-changed') detail = `Changed required status for parameter ${param}.`;
        else if (paramChange.kind === 'param-default-changed') detail = `Changed default for parameter ${param}.`;
        else detail = `Changed parameter ${param}.`;
        addFact(facts, {
          severity,
          ...scopeFields(scope),
          kind: paramChange.kind,
          symbols: [change.serviceName, change.operationName, paramChange.paramName],
          detail,
        });
      }
      const opKey = `${change.serviceName}.${change.operationName}`;
      if (change.responseChanged) {
        const oldType = indexes.responseTypeByKey?.old.get(opKey);
        const newType = indexes.responseTypeByKey?.new.get(opKey);
        addFact(facts, {
          severity: capSeverity('response-changed', change.classification),
          ...scopeFields(scope),
          kind: 'response-changed',
          symbols: [change.serviceName, change.operationName],
          detail:
            oldType && newType && oldType !== newType
              ? `Changed response of \`${opKey}\` from \`${oldType}\` to \`${newType}\`.`
              : `Changed response for \`${opKey}\`.`,
        });
      }
      if (change.requestBodyChanged) {
        const oldType = indexes.requestTypeByKey?.old.get(opKey);
        const newType = indexes.requestTypeByKey?.new.get(opKey);
        addFact(facts, {
          severity: capSeverity('request-body-changed', change.classification),
          ...scopeFields(scope),
          kind: 'request-body-changed',
          symbols: [change.serviceName, change.operationName],
          detail:
            oldType && newType && oldType !== newType
              ? `Changed request body of \`${opKey}\` from \`${oldType}\` to \`${newType}\`.`
              : `Changed request body for \`${opKey}\`.`,
        });
      }
    }
  }
  return facts;
}

// Pair a removed callable with an added one under the same owner into a
// rename, so the changelog reads "renamed X to Y" instead of a bare removal
// plus an unrelated-looking addition. Mirrors pairRemoveAddRows in
// sdk-compat-pr-comment.mjs: only pair member symbols (owner.member), and only
// when an owner has exactly one logical removal and one logical addition, to
// avoid guessing among multiple candidates. Returns a Map of every removed
// symbol → { from, to } display representatives.
function renamesFromCompat(compatReport) {
  // Some SDKs emit a coroutine/async member variant alongside the base method
  // (e.g. Kotlin's `fooSuspend`). Collapse them to a single logical member so
  // one rename isn't counted as multiple removals/additions.
  const VARIANT_SUFFIX = /Suspend$/;
  const index = (map, symbol) => {
    const dot = symbol.lastIndexOf('.');
    if (dot === -1) return;
    const owner = symbol.slice(0, dot).replace(/_/g, '').toLowerCase();
    const member = symbol.slice(dot + 1);
    const base = member.replace(VARIANT_SUFFIX, '').toLowerCase();
    if (!map.has(owner)) map.set(owner, { bases: new Set(), symbols: [], rep: null });
    const entry = map.get(owner);
    entry.bases.add(base);
    entry.symbols.push(symbol);
    // Prefer the variant without the suffix as the display representative.
    if (entry.rep === null || !VARIANT_SUFFIX.test(member)) entry.rep = symbol;
  };

  const removedByOwner = new Map();
  const addedByOwner = new Map();
  for (const change of compatReport?.changes ?? []) {
    if (change.category === 'symbol_removed') index(removedByOwner, String(change.symbol ?? ''));
    else if (change.category === 'symbol_added') index(addedByOwner, String(change.symbol ?? ''));
  }

  const renames = new Map();
  for (const [owner, removed] of removedByOwner) {
    const added = addedByOwner.get(owner);
    if (removed.bases.size !== 1 || added?.bases.size !== 1) continue;
    for (const symbol of removed.symbols) renames.set(symbol, { from: removed.rep, to: added.rep });
  }
  return renames;
}

// Compat categories the tool may flag breaking that are still backend API
// changes under our policy: a field's type, an enum member value, a method's
// return type, or a default moving. Only call-signature and whole-type changes
// stay breaking.
const NON_BREAKING_COMPAT_CATEGORIES = new Set([
  'field_type_changed',
  'enum_member_value_changed',
  'return_type_changed',
  'default_value_changed',
]);

// Decide whether a breaking-severity compat change is breaking under our policy.
// `symbol_removed`/`symbol_renamed` carry no kind, so split owner from member and
// consult the IR: a member of a model/enum is a property (field rename/removal —
// not breaking); a whole type/service or a service/client member is call surface.
function compatChangeIsBreaking(change, indexes) {
  const category = String(change.category ?? '');
  if (NON_BREAKING_COMPAT_CATEGORIES.has(category)) return false;
  if (category === 'symbol_removed' || category === 'symbol_renamed') {
    const symbol = String(change.symbol ?? '');
    const dot = symbol.lastIndexOf('.');
    if (dot === -1) return true; // whole type/service removed or renamed
    const owner = symbol.slice(0, dot).replace(/^Async(?=[A-Z])/, '');
    if (indexes?.serviceNames?.has(owner) || owner === 'Client') return true;
    if (indexes?.typeNames?.has(owner)) return false;
    return true; // unknown owner — preserve breaking rather than drop a real removal
  }
  return true;
}

function factsFromCompat(compatReport, existingFacts, indexes) {
  const facts = [];
  const existingBreakingScopes = new Set(existingFacts.filter((fact) => fact.severity === 'breaking').map((fact) => fact.scope));
  const renames = renamesFromCompat(compatReport);

  // Only one breaking fact survives per scope (the dedup below), so prefer the
  // sync symbol over its `Async*` mirror when both changed — the sync surface
  // is the primary public API and reads better in the changelog.
  const isAsync = (change) => (/^Async(?=[A-Z])/.test(String(change.symbol ?? '')) ? 1 : 0);
  const breakingChanges = (compatReport?.changes ?? [])
    .filter((change) => change.severity === 'breaking' && compatChangeIsBreaking(change, indexes))
    .sort((a, b) => isAsync(a) - isAsync(b));

  for (const change of breakingChanges) {
    // Strip the Python async-client prefix (`AsyncPipes` → `Pipes`) so async
    // surface symbols resolve to the same scope as their sync counterparts.
    const root = String(change.symbol ?? '').split('.')[0].replace(/^Async(?=[A-Z])/, '');
    const serviceScope = resolveServiceScope(root);
    const nameScope = scopeFromName(root);
    const scope = serviceScope.scope !== toSnakeCase(root) ? serviceScope.scope : nameScope;
    const targetScope = scope === 'sdk' && root === 'Client' ? 'client' : scope;
    const source =
      targetScope === 'client'
        ? 'compat_client'
        : serviceScope.scope !== toSnakeCase(root)
          ? `compat_${serviceScope.source}`
          : nameScope !== 'sdk'
            ? 'compat_name'
            : 'compat_unresolved';
    if (existingBreakingScopes.has(targetScope)) continue;
    const renamed = renames.get(String(change.symbol ?? ''));
    addFact(facts, {
      severity: 'breaking',
      scope: targetScope,
      scope_source: source,
      scope_candidates: [targetScope],
      kind: renamed ? 'sdk-surface-renamed' : 'sdk-surface-breaking',
      symbols: renamed ? [renamed.from, renamed.to] : [change.symbol],
      detail: renamed
        ? `SDK surface change: \`${renamed.from}\` was renamed to \`${renamed.to}\`.`
        : `SDK surface change: ${change.message ?? change.symbol}.`,
    });
    existingBreakingScopes.add(targetScope);
  }
  return facts;
}

function groupFacts(facts) {
  const groups = new Map();
  for (const fact of facts) {
    const key = `${fact.scope}:${fact.severity}`;
    const group = groups.get(key) ?? {
      scope: fact.scope,
      severity: fact.severity,
      prefix: severityToPrefix(fact.severity),
      facts: [],
      symbols: new Set(),
      scopeSources: new Set(),
      scopeCandidates: new Set(),
    };
    group.facts.push(fact);
    for (const symbol of fact.symbols ?? []) group.symbols.add(symbol);
    if (fact.scope_source) group.scopeSources.add(fact.scope_source);
    for (const candidate of fact.scope_candidates ?? []) group.scopeCandidates.add(candidate);
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => {
    const severityRank = { breaking: 0, additive: 1, fix: 2 };
    return (severityRank[a.severity] ?? 9) - (severityRank[b.severity] ?? 9) || a.scope.localeCompare(b.scope);
  });
}

function summaryForGroup(group) {
  const facts = group.facts;
  const label = labelForScope(group.scope);
  const kinds = new Set(facts.map((fact) => fact.kind));

  const commonField = facts.length > 1 && facts.every((fact) => fact.fieldName === facts[0].fieldName) ? facts[0].fieldName : null;
  if (commonField && kinds.size === 1 && kinds.has('field-added')) return `Add ${code(commonField)} to ${label} models`;
  if (commonField && kinds.size === 1 && kinds.has('field-required-changed')) {
    return facts.every((fact) => fact.madeRequired)
      ? `Make ${code(commonField)} required in ${label} models`
      : `Make ${code(commonField)} optional in ${label} models`;
  }

  if (facts.length === 1) {
    return facts[0].detail
      .replace(/\.$/, '')
      .replace(/^Added /, 'Add ')
      .replace(/^Removed /, 'Remove ')
      .replace(/^Made /, 'Make ')
      .replace(/^Changed /, 'Change ');
  }

  const removedOnly = facts.every((fact) => ['model-removed', 'enum-removed', 'value-removed', 'field-removed'].includes(fact.kind));
  if (removedOnly) return `Remove ${label} API surface`;

  const addedOnly = facts.every((fact) =>
    ['model-added', 'enum-added', 'value-added', 'field-added', 'operation-added', 'service-added'].includes(fact.kind),
  );
  if (addedOnly) {
    const hasOperation = kinds.has('operation-added');
    const hasModel = kinds.has('model-added');
    const hasEnumValue = kinds.has('value-added');
    if (hasOperation && hasModel) return `Add ${label} operations and models`;
    if (hasEnumValue && facts.length === 1) return facts[0].detail.replace(/\.$/, '').replace(/^Added /, 'Add ');
    return `Add ${label} API surface`;
  }

  return group.severity === 'breaking' ? `Change ${label} API surface` : `Update ${label} API surface`;
}

function descriptionForGroup(group) {
  const facts = group.facts;
  const label = labelForScope(group.scope);
  const kinds = new Set(facts.map((fact) => fact.kind));
  const commonField = facts.length > 1 && facts.every((fact) => fact.fieldName === facts[0].fieldName) ? facts[0].fieldName : null;

  if (commonField && kinds.size === 1 && kinds.has('field-added')) {
    return `- Added ${code(commonField)} to ${label} models.`;
  }
  if (commonField && kinds.size === 1 && kinds.has('field-required-changed')) {
    return facts.every((fact) => fact.madeRequired)
      ? `- Made ${code(commonField)} required in ${label} models.`
      : `- Made ${code(commonField)} optional in ${label} models.`;
  }

  return facts.map((fact) => `- ${fact.detail}`).join('\n');
}

function assignFilePaths(entries, changedFiles) {
  const claimed = new Set();
  for (const file of changedFiles) {
    const fileScope = scopeFromFile(file);
    const normalizedFile = normalize(file);
    let best = null;
    for (const entry of entries) {
      const symbolScore = entry.symbols.reduce((score, symbol) => {
        const normalizedSymbol = normalize(symbol);
        return normalizedSymbol && normalizedFile.includes(normalizedSymbol) ? score + 10 : score;
      }, 0);
      const scopeScore = fileScope !== 'sdk' && entry.scope === fileScope ? 2 : 0;
      if (symbolScore === 0 && scopeScore === 0) continue;
      const severityScore = entry.prefix === 'feat!' ? 2 : entry.prefix === 'feat' ? 1 : 0;
      const score = symbolScore + scopeScore + severityScore;
      if (!best || score > best.score) best = { entry, score };
    }

    if (best && !claimed.has(file)) {
      best.entry.file_paths.push(file);
      claimed.add(file);
    }
  }
}

function entriesFromGroups(groups, changedFiles) {
  const entries = groups.map((group) => ({
    prefix: group.prefix,
    scope: group.scope,
    docs_url: docsUrlForScope(group.scope),
    severity: group.severity,
    summary: summaryForGroup(group),
    description: descriptionForGroup(group),
    file_paths: [],
    symbols: unique([...group.symbols]),
    scope_sources: unique([...group.scopeSources]),
    scope_candidates: unique([...group.scopeCandidates]),
    changes: group.facts.map((fact) => ({
      severity: fact.severity,
      kind: fact.kind,
      detail: fact.detail,
      scope_source: fact.scope_source,
      scope_candidates: fact.scope_candidates,
    })),
  }));
  assignFilePaths(entries, changedFiles);
  return entries;
}

function scopeValidationIssues(entries) {
  return entries.flatMap((entry) => {
    const issues = [];
    if (entry.scope === 'sdk') {
      issues.push(`entry "${entry.summary}" resolved to fallback scope "sdk"`);
    }
    if (!entry.docs_url) {
      issues.push(`entry "${entry.summary}" has no docs_url for scope "${entry.scope}"`);
    }
    return issues;
  });
}

function scopeValidationWarnings(entries) {
  return entries.flatMap((entry) => {
    const candidates = entry.scope_candidates ?? [];
    if (candidates.length > 0 && !candidates.includes(entry.scope)) {
      return [
        `entry "${entry.summary}" uses scope "${entry.scope}" from ${entry.scope_sources.join(', ')}, while IR candidates are ${candidates
          .map((candidate) => `"${candidate}"`)
          .join(', ')}`,
      ];
    }
    if (entry.scope_sources?.includes('ir_ambiguous')) {
      return [`entry "${entry.summary}" has ambiguous IR scope candidates: ${candidates.join(', ')}`];
    }
    return [];
  });
}

function reportScopeValidation(entries, args) {
  const issues = scopeValidationIssues(entries);
  const warnings = scopeValidationWarnings(entries);

  if (issues.length > 0 && args['strict-scopes']) {
    throw new Error(`Changelog scope validation failed:\n- ${issues.join('\n- ')}`);
  }

  const prefix = process.env.GITHUB_ACTIONS ? '::warning::' : 'warning: ';
  for (const warning of warnings) process.stderr.write(`${prefix}${warning}\n`);
  for (const issue of issues) process.stderr.write(`${prefix}${issue}\n`);
}

function markdownScope(entry) {
  return entry.docs_url ? `[${entry.scope}](${entry.docs_url})` : entry.scope;
}

function renderEntryMarkdown(entry) {
  const details = String(entry.description ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/\.$/, ''))
    .map((line) => line.replace(/^[-*]\s+/, '    * '));
  if (details.length === 0 && entry.summary) details.push(`    * ${String(entry.summary).replace(/\.$/, '')}`);
  return [`  * **${markdownScope(entry)}**:`, ...details].join('\n');
}

function rollupForEntries(entries) {
  if (entries.some((entry) => entry.prefix === 'feat!')) return { type: 'feat', bang: '!' };
  if (entries.some((entry) => entry.prefix === 'feat')) return { type: 'feat', bang: '' };
  return { type: 'fix', bang: '' };
}

function renderChangelogMarkdown(entries, args) {
  const lines = [];
  const rollup = rollupForEntries(entries);
  const count = entries.length;
  const summary = count === 1 ? 'regenerate from spec (1 change)' : `regenerate from spec (${count} changes)`;

  if (args['pr-number'] || args['pr-url']) {
    const prNumber = args['pr-number'] ?? '';
    const prUrl = args['pr-url'] ?? '';
    const prRef = prNumber && prUrl ? `[#${prNumber}](${prUrl})` : prNumber ? `#${prNumber}` : prUrl;
    lines.push(`* ${prRef} ${rollup.type}(generated)${rollup.bang}: ${summary}`);
    lines.push('');
  }

  const sections = [
    ['feat!', '**⚠️ Breaking**'],
    ['feat', '**Features**'],
    ['fix', '**Fixes**'],
  ];
  for (const [prefix, heading] of sections) {
    const sectionEntries = entries.filter((entry) => entry.prefix === prefix);
    if (sectionEntries.length === 0) continue;
    if (lines.length > 0 && lines[lines.length - 1] !== '') lines.push('');
    lines.push(`  ${heading}`);
    for (const entry of sectionEntries) lines.push(renderEntryMarkdown(entry));
  }

  return `${lines.join('\n')}\n`;
}

let args = parseArgs(process.argv.slice(2));
if (args.help) {
  printHelp();
  process.exit(0);
}
args = prepareSpecInputs(args);
args = prepareCompatInputs(args);

try {
  const diffReport = readJson(args['diff-report'], { changes: [], behaviorChanges: [], summary: {} });
  const oldIr = readJson(args['old-ir'], null);
  const newIr = readJson(args['new-ir'], null);
  const compatReport = readJson(args['compat-report'], { changes: [] });
  const changedFiles = changedFilesFromArgs(args);

  const indexes = buildIndexes([oldIr, newIr]);
  const specFacts = factsFromDiff(diffReport, indexes);
  const compatFacts = factsFromCompat(compatReport, specFacts, indexes);
  const entries = entriesFromGroups(groupFacts([...specFacts, ...compatFacts]), changedFiles);
  reportScopeValidation(entries, args);

  const output =
    args.format === 'changelog' || args.format === 'markdown'
      ? renderChangelogMarkdown(entries, args)
      : `${JSON.stringify(entries, null, 2)}\n`;
  if (args.output) {
    writeFileSync(args.output, output);
  } else {
    process.stdout.write(output);
  }
} finally {
  if (args._tmpdir) rmSync(args._tmpdir, { recursive: true, force: true });
  if (args._compatTmpdir) rmSync(args._compatTmpdir, { recursive: true, force: true });
}
