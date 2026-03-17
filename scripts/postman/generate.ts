import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import yaml from "js-yaml";
import { convertSpec } from "./lib/convert.js";
import {
  nestFolders,
  formatFolderNames,
  sortItemsAlphabetically,
  removeEmptyFolders,
  deduplicateQueryParams,
  disableOptionalParameters,
  hoistRequestDescriptions,
  processItems,
  buildExclusionMap,
} from "./lib/post-process.js";
import { uploadCollection } from "./lib/upload.js";
import type { OpenApiSpec } from "./lib/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SPEC_PATH = path.resolve(__dirname, "../../spec/open-api-spec.yaml");

const isLocal = process.argv.includes("--local");

async function main(): Promise<void> {
  console.log("Reading OpenAPI spec...");
  const specString = fs.readFileSync(SPEC_PATH, "utf8");
  const parsedSpec = yaml.load(specString) as OpenApiSpec;

  console.log("Converting to Postman collection...");
  const collection = await convertSpec(specString);

  console.log("Building exclusion map...");
  const exclusionMaps = buildExclusionMap(parsedSpec);
  for (const [schema, map] of exclusionMaps) {
    const groups = map.exclusions.map((s) => [...s].join(" | "));
    console.log(`  ${schema}: exclusions=[${groups.join("; ")}]`);
    if (map.dependents.size > 0) {
      for (const [field, deps] of map.dependents) {
        console.log(`    ${field} -> dependents: ${deps.join(", ")}`);
      }
    }
  }

  console.log("Post-processing collection...");

  if (collection.item) {
    collection.item = nestFolders(collection.item);
    collection.item = sortItemsAlphabetically(collection.item);
    collection.item = removeEmptyFolders(collection.item);
    processItems(collection.item, parsedSpec, exclusionMaps);
    deduplicateQueryParams(collection.item);
    disableOptionalParameters(collection.item);
    hoistRequestDescriptions(collection.item);
    formatFolderNames(collection.item);
  }

  // Set collection name and description
  collection.info.name = "WorkOS API";
  collection.info.description = {
    content: `# WorkOS API

WorkOS is a developer platform that provides enterprise-ready authentication and user management APIs. This collection enables you to integrate Single Sign-On (SSO), Directory Sync (SCIM), Multi-Factor Authentication (MFA), and other enterprise features into your application with just a few API calls.

## What You Can Build

With the WorkOS API, you can:

- **Single Sign-On (SSO)**: Enable users to authenticate via SAML or OAuth providers like Okta, Azure AD, and Google Workspace

- **Directory Sync**: Automatically sync user directories from identity providers using SCIM 2.0

- **Multi-Factor Authentication**: Add an extra layer of security with SMS, TOTP, and other MFA methods

- **Organizations**: Manage multi-tenant applications with organization-level controls

- **Admin Portal**: Generate links for customers to self-serve SSO and Directory Sync configuration

- **Audit Logs**: Stream security and compliance events to your application

- **Magic Link**: Implement passwordless authentication flows

## Getting Started

### Authentication

All WorkOS API requests require authentication using your API key in the Authorization header:

\`\`\`
Authorization: Bearer sk_test_your_api_key_here
\`\`\`

Get your API key from the [WorkOS Dashboard](https://dashboard.workos.com/api-keys).

### Base URL

All API requests are made to:

\`\`\`
https://api.workos.com
\`\`\`

### Environment Setup

This collection uses environment variables for easy configuration:

- \`base_url\`: Set to \`https://api.workos.com\`

- \`api_key\`: Your WorkOS API key (keep this secret!)

- Additional variables for resource IDs (organization_id, user_id, etc.)

## Resources

- **Full API Documentation**: [workos.com/docs/reference](https://workos.com/docs/reference)

- **Developer Guides**: [workos.com/docs](https://workos.com/docs)

- **Dashboard**: [dashboard.workos.com](https://dashboard.workos.com)

- **Support**: [workos.com/support](https://workos.com/support)

## Collection Structure

This collection is organized by WorkOS product features, with each folder containing the relevant API endpoints for that feature. Start with the **Organizations** folder to create and manage your multi-tenant structure, then explore SSO, Directory Sync, and other features as needed.

---

Ready to get started? Fork this collection and configure your environment variables to begin making API calls.`,
    type: "text/markdown",
  };

  // Add bearer token variable
  if (!collection.variable) {
    collection.variable = [];
  }
  collection.variable.push({
    key: "bearerToken",
    value: "YOUR_TOKEN_HERE",
    type: "string",
  });

  if (isLocal) {
    const outputPath = path.resolve(__dirname, "../../workos-postman-collection.local.json");
    fs.writeFileSync(outputPath, JSON.stringify(collection, null, 2));
    console.log(`Collection written to ${outputPath}`);
  } else {
    const apiKey = process.env.POSTMAN_API_KEY;
    const collectionUid = process.env.POSTMAN_COLLECTION_UID;

    if (!apiKey || !collectionUid) {
      console.error(
        "Missing POSTMAN_API_KEY or POSTMAN_COLLECTION_UID environment variables."
      );
      process.exit(1);
    }

    console.log("Uploading to Postman...");
    await uploadCollection(collection, collectionUid, apiKey);
  }

  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
