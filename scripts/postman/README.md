# Postman Collection Sync

Converts `spec/open-api-spec.yaml` into a Postman collection and (optionally) uploads it via the Postman API.

## How it works

1. The OpenAPI spec is converted to a Postman collection using `openapi-to-postmanv2`
2. Post-processing transforms are applied:
   - Dotted tags (e.g. `user-management.users`) become nested folders
   - Folder names are title-cased with acronym handling (SSO, MFA, API, etc.)
   - Folders are sorted alphabetically; empty ones are removed
   - Request bodies are trimmed to required fields only
   - Mutually exclusive fields are detected from schema descriptions and deduplicated (e.g. `password` vs `password_hash`)
   - Duplicate query params are removed (openapi-to-postmanv2 bug workaround)
   - Optional parameters are disabled by default
3. The collection is uploaded to Postman via `PUT /collections/{uid}`

## Running locally

```sh
# Generate collection to a local JSON file (no upload)
npm run generate:postman:local

# Or, upload directly to Postman
POSTMAN_API_KEY=your_key POSTMAN_COLLECTION_UID=your_uid npm run generate:postman
```

## File structure

```
scripts/postman/
├── generate-and-upload.ts   # Entry point
├── lib/
│   ├── convert.ts           # openapi-to-postmanv2 wrapper
│   ├── post-process.ts      # All post-processing transforms
│   ├── upload.ts            # Postman API client
│   └── types.ts             # Shared TypeScript interfaces
└── README.md
```
