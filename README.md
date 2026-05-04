# WorkOS OpenAPI Specification

This repository contains the [OpenAPI specification](https://github.com/OAI/OpenAPI-Specification) for the [WorkOS API](https://workos.com/docs/reference).

## Overview

The WorkOS API provides a comprehensive platform for enterprise-ready features including:

- **User Management** - Authentication, identity, and user lifecycle management
- **Organization Management** - Multi-tenancy and organization-level configurations
- **Directory Sync** - Automated user provisioning with SCIM and directory providers
- **Single Sign-On (SSO)** - SAML and OIDC identity provider integrations
- **Audit Logs** - Comprehensive event logging and exports
- **API Keys** - Programmatic access management
- **Authorization** - Role-based access control (RBAC) and permissions

## Specification

- **OpenAPI Version:** 3.1.1
- **Format:** YAML
- **File:** [`spec/open-api-spec.yaml`](spec/open-api-spec.yaml)

## SDK Generation

This repository is the canonical source for SDK generation. The consumer config at `oagen.config.ts` defines spec interpretation policy (operation hints, mount rules, transforms) and imports the plugin bundle from `@workos/oagen-emitters`.

### Orchestration scripts

All SDK orchestration runs from this project.

```bash
# Resolve operation names and review the naming table
npm run sdk:resolve

# Generate SDK code
npm run sdk:generate -- --lang python --output ~/workos/sdks/backend/python

# Diff the current spec against the last-generated snapshot
npm run sdk:diff -- --lang python

# Run smoke tests and compat checks against generated output
npm run sdk:verify -- --lang python

# Extract a live SDK's public API surface for compat overlay
npm run sdk:extract -- --lang python
```

### Compat workflow

Check for breaking changes between a live SDK and freshly generated output.

```bash
# 1. Extract baseline snapshot from the live SDK
npm run sdk:compat-extract -- --lang python --sdk-root ~/workos/sdks/backend/python

# 2. Generate new SDK code
npm run sdk:generate -- --lang python --output .oagen/python/sdk

# 3. Extract candidate snapshot from the generated output
npm run sdk:compat-extract -- --lang python --sdk-root .oagen/python/sdk --output .oagen/python/sdk

# 4. Diff baseline vs candidate (exits non-zero on breaking changes)
npm run sdk:compat-diff -- --lang python

# 5. Generate a markdown summary from the diff report
npm run sdk:compat-summary -- --report .oagen/python/compat-report.json

# Cross-language rollup
npm run sdk:compat-summary -- --report .oagen/python/compat-report.json --report .oagen/go/compat-report.json

# Write summary to a file instead of stdout
npm run sdk:compat-summary -- --report .oagen/python/compat-report.json --output summary.md
```

### Local development

Install dependencies:

```bash
npm ci
```

Sanity check the config and spec wiring:

```bash
npm run sdk:check
```

Common local loop:

```bash
# Review resolved operation names and mounts
npm run sdk:resolve

# Generate one SDK locally
npm run sdk:generate -- --lang python --output .oagen/python/sdk

# Verify generated output
npm run sdk:verify -- --lang python --output .oagen/python/sdk
```

If you are developing `@workos/oagen` or `@workos/oagen-emitters` locally, link them into this repo:

```bash
npm run dev:link
```

Restore published package resolution:

```bash
npm run dev:unlink
```

To preview the SDK validation PR comment locally, generate compat artifacts and then render the markdown comment from the downloaded or local artifact layout:

```bash
node scripts/sdk-compat-pr-comment.mjs \
  --artifacts-root sdk-diagnostics \
  --output sample.md
```

### Typical workflow

1. Edit `spec/open-api-spec.yaml`
2. Update `oagen.config.ts` if the change needs new hints, mount rules, or transforms
3. `npm run sdk:resolve` to inspect naming
4. `npm run sdk:generate -- --lang <lang> --output .oagen/<lang>/sdk` to generate
5. `npm run sdk:verify -- --lang <lang> --output .oagen/<lang>/sdk` to verify

## Grabbing from npm

The spec is published to npm as [`@workos-inc/openapi-spec`](https://www.npmjs.com/package/@workos-inc/openapi-spec).

```bash
npm install @workos-inc/openapi-spec
```

### Usage

The package ships TypeScript types generated from the spec, plus the raw `open-api-spec.yaml` file.

**TypeScript types:**

```ts
import type { paths, components, operations } from "@workos-inc/openapi-spec";

type User = components["schemas"]["User"];

type CreateUserRequest =
  paths["/user_management/users"]["post"]["requestBody"]["content"]["application/json"];

type CreateUserResponse =
  paths["/user_management/users"]["post"]["responses"]["201"]["content"]["application/json"];

// Annotate HTTP client responses with the generated types:
const res = await fetch("https://api.workos.com/user_management/users/user_123");
const user: components["schemas"]["User"] = await res.json();
```

The types follow the [`openapi-typescript`](https://openapi-ts.dev) layout: top-level `paths`, `components`, and `operations` interfaces.

**Loading the raw spec (Node.js, ESM):**

```ts
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import yaml from "js-yaml";

const require = createRequire(import.meta.url);
const specPath = require.resolve("@workos-inc/openapi-spec/spec");
const spec = yaml.load(readFileSync(specPath, "utf8"));

console.log(spec.info.title, spec.info.version);
```

**Loading the raw spec (Node.js, CommonJS):**

```js
const { readFileSync } = require("node:fs");
const yaml = require("js-yaml");

const specPath = require.resolve("@workos-inc/openapi-spec/spec");
const spec = yaml.load(readFileSync(specPath, "utf8"));
```

**Bundlers (Vite, webpack, etc.) with a YAML loader:**

```ts
import spec from "@workos-inc/openapi-spec/spec";
```

## Generating Postman Collections

This repository includes scripts to generate Postman collections from the OpenAPI specification. See the `scripts/postman` folder for more information.

## Support

- [WorkOS Documentation](https://workos.com/docs)
- [API Reference](https://workos.com/docs/reference)
- [Support](https://workos.com/support)

## License

This OpenAPI specification is available under the [MIT License](LICENSE).
