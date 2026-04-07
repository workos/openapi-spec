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

This repository also contains the OpenAPI-side automation for SDK generation and validation. The GitHub workflows use the same npm scripts that can be run locally.

`oagen.config.ts` registers the installed emitters and extractors used by `oagen`

### Commands

```sh
# Extract the live SDK surface
npm run sdk:extract -- --lang node --sdk-path ../workos-node --output ./sdk-node-surface.json

# Generate SDK output from the spec
npm run sdk:generate -- --lang node --output ./sdk-node --namespace workos --spec ./spec/open-api-spec.yaml --api-surface ./sdk-node-surface.json --target ../workos-node

# Report newly added SDK modules and operations
npm run sdk:report:additions -- --language node --spec ./spec/open-api-spec.yaml --baseline ./sdk-node-surface.json --candidate-dir ./sdk-node --output ./sdk-additions-node.md

# Low-level helpers used by CI
npm run sdk:resolve -- --spec ./spec/open-api-spec.yaml --format json
npm run sdk:diff -- --old ./sdk-node/spec-snapshot.yaml --new ./spec/open-api-spec.yaml --report
```

## Generating Postman Collections

This repository includes scripts to generate Postman collections from the OpenAPI specification. See the `scripts/postman` folder for more information.

## Support

- [WorkOS Documentation](https://workos.com/docs)
- [API Reference](https://workos.com/docs/reference)
- [Support](https://workos.com/support)

## License

This OpenAPI specification is available under the [MIT License](LICENSE).
