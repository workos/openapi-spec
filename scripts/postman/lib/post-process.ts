import type {
  PostmanItem,
  PostmanUrl,
  PostmanHeader,
  OpenApiSpec,
  OpenApiSchema,
  ExclusionMap,
} from "./types.js";

// ---------------------------------------------------------------------------
// Folder nesting: convert dotted tags to nested folder structure
// ---------------------------------------------------------------------------

export function nestFolders(items: PostmanItem[]): PostmanItem[] {
  const nestedStructure = new Map<string, PostmanItem>();
  const seen = new Set<string>();

  for (const item of items) {
    const name = item.name;

    if (name.includes(".")) {
      const parts = name.split(".");
      const parentName = parts[0];
      const childName = parts.slice(1).join(".");

      if (!nestedStructure.has(parentName)) {
        nestedStructure.set(parentName, {
          id: crypto.randomUUID(),
          name: parentName,
          description: { content: "", type: "text/plain" },
          item: [],
        });
      }

      const parent = nestedStructure.get(parentName)!;
      const childFolder: PostmanItem = { ...item, name: childName };

      if (childName.includes(".")) {
        parent.item = nestFolders([...parent.item!, childFolder]);
      } else {
        parent.item!.push(childFolder);
      }
    } else {
      if (nestedStructure.has(name)) {
        const existing = nestedStructure.get(name)!;
        existing.description = item.description;
        if (item.item) {
          existing.item = [...item.item, ...existing.item!];
        }
      } else {
        nestedStructure.set(name, item);
      }
    }
  }

  // Fill in empty descriptions on synthetic parent folders
  for (const [, folder] of nestedStructure) {
    const desc =
      typeof folder.description === "object"
        ? folder.description?.content
        : folder.description;
    if (!desc || desc.trim().length === 0) {
      const formatted = folder.name
        .split(/[-_]/)
        .map((w: string) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(" ");
      folder.description = {
        content: `${formatted} endpoints.`,
        type: "text/plain",
      };
    }
  }

  // Build final array preserving original order
  const result: PostmanItem[] = [];
  for (const item of items) {
    const name = item.name.split(".")[0];
    if (!seen.has(name) && nestedStructure.has(name)) {
      result.push(nestedStructure.get(name)!);
      seen.add(name);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Folder name formatting
// ---------------------------------------------------------------------------

const ACRONYMS = new Set([
  "sso",
  "api",
  "mfa",
  "cors",
  "oauth",
  "saml",
  "oidc",
  "fga",
  "jwt",
  "cli",
]);

const SPECIAL_CASING: Record<string, string> = {
  authkit: "AuthKit",
};

const HYPHENATED_COMPOUNDS: Record<string, string> = {
  "multi-factor": "Multi-Factor",
};

export function formatFolderName(name: string): string {
  let processedName = name.toLowerCase();
  const placeholders = new Map<string, string>();

  let idx = 0;
  for (const [compound, replacement] of Object.entries(HYPHENATED_COMPOUNDS)) {
    const placeholder = `XCOMPOUNDX${idx}X`;
    if (processedName.includes(compound)) {
      processedName = processedName.replace(
        new RegExp(compound, "g"),
        placeholder
      );
      placeholders.set(placeholder, replacement);
      idx++;
    }
  }

  return processedName
    .split(/[-_]/)
    .map((word) => {
      if (word.startsWith("XCOMPOUNDX")) return placeholders.get(word) || word;
      if (ACRONYMS.has(word.toLowerCase())) return word.toUpperCase();
      if (SPECIAL_CASING[word.toLowerCase()])
        return SPECIAL_CASING[word.toLowerCase()];
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join(" ");
}

export function formatFolderNames(items: PostmanItem[]): void {
  for (const item of items) {
    if (item.item && Array.isArray(item.item)) {
      item.name = formatFolderName(item.name);
      formatFolderNames(item.item);
    }
  }
}

// ---------------------------------------------------------------------------
// Sort & cleanup
// ---------------------------------------------------------------------------

export function sortItemsAlphabetically(items: PostmanItem[]): PostmanItem[] {
  const sorted = items.sort((a, b) => a.name.localeCompare(b.name));
  for (const item of sorted) {
    if (item.item && Array.isArray(item.item)) {
      item.item = sortItemsAlphabetically(item.item);
    }
  }
  return sorted;
}

export function removeEmptyFolders(items: PostmanItem[]): PostmanItem[] {
  return items.filter((item) => {
    if (item.item && Array.isArray(item.item)) {
      item.item = removeEmptyFolders(item.item);
      return item.item.length > 0;
    }
    return true;
  });
}

// ---------------------------------------------------------------------------
// Hoist request descriptions to item level (Postman UI reads item.description)
// ---------------------------------------------------------------------------

export function hoistRequestDescriptions(items: PostmanItem[]): void {
  for (const item of items) {
    if (item.item) {
      hoistRequestDescriptions(item.item);
    } else if (item.request?.description && !item.description) {
      item.description = item.request.description;
    }
  }
}

// ---------------------------------------------------------------------------
// Query param deduplication (openapi-to-postmanv2 bug with array params)
// ---------------------------------------------------------------------------

export function deduplicateQueryParams(items: PostmanItem[]): void {
  for (const item of items) {
    if (item.item) {
      deduplicateQueryParams(item.item);
    } else if (item.request?.url?.query) {
      const seen = new Set<string>();
      item.request.url.query = item.request.url.query.filter((param) => {
        if (seen.has(param.key)) return false;
        seen.add(param.key);
        return true;
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Disable optional parameters by default
// ---------------------------------------------------------------------------

function disableUrlParameters(url: PostmanUrl): void {
  if (url.query) {
    for (const param of url.query) {
      param.disabled = true;
    }
  }
  if (url.variable) {
    for (const variable of url.variable) {
      variable.disabled = true;
    }
  }
}

function disableOptionalHeaders(headers: PostmanHeader[]): void {
  if (!headers) return;
  for (const header of headers) {
    if ("disabled" in header) {
      header.disabled = true;
    }
  }
}

export function disableOptionalParameters(items: PostmanItem[]): void {
  for (const item of items) {
    if (item.item) {
      disableOptionalParameters(item.item);
    } else {
      if (item.request?.url) {
        disableUrlParameters(item.request.url);
      }
      if (item.request?.header) {
        disableOptionalHeaders(item.request.header);
      }
      if (item.response) {
        for (const response of item.response) {
          if (response.originalRequest?.url) {
            disableUrlParameters(response.originalRequest.url);
          }
          if (response.originalRequest?.header) {
            disableOptionalHeaders(response.originalRequest.header);
          }
          if (response.header) {
            disableOptionalHeaders(response.header);
          }
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Mutually exclusive field detection (generic, description-based)
// ---------------------------------------------------------------------------

export function buildExclusionMap(
  spec: OpenApiSpec
): Map<string, ExclusionMap> {
  const result = new Map<string, ExclusionMap>();
  const schemas = spec.components?.schemas;
  if (!schemas) return result;

  for (const [schemaName, schema] of Object.entries(schemas)) {
    if (!schema.properties) continue;

    const exclusionPairs: Array<[string, string]> = [];
    const dependents = new Map<string, string[]>();

    for (const [propName, propSchema] of Object.entries(schema.properties)) {
      const desc = propSchema.description || "";

      // Detect "Mutually exclusive with `fieldName`"
      const exclusiveMatch = desc.match(
        /[Mm]utually exclusive with `([^`]+)`/
      );
      if (exclusiveMatch) {
        const otherField = exclusiveMatch[1];
        exclusionPairs.push([propName, otherField]);
      }

      // Detect dependent fields: "providing a `fieldName`" or "when.*`fieldName`"
      const dependentMatch = desc.match(
        /(?:providing a|when[^`]*)`([^`]+)`/
      );
      if (dependentMatch && !exclusiveMatch) {
        const dependsOn = dependentMatch[1];
        if (schema.properties[dependsOn]) {
          if (!dependents.has(dependsOn)) {
            dependents.set(dependsOn, []);
          }
          dependents.get(dependsOn)!.push(propName);
        }
      }
    }

    if (exclusionPairs.length > 0 || dependents.size > 0) {
      // Build exclusion groups (sets of mutually exclusive fields)
      const exclusions: Set<string>[] = [];
      for (const [a, b] of exclusionPairs) {
        // Check if either field is already in an existing group
        let found = false;
        for (const group of exclusions) {
          if (group.has(a) || group.has(b)) {
            group.add(a);
            group.add(b);
            found = true;
            break;
          }
        }
        if (!found) {
          exclusions.push(new Set([a, b]));
        }
      }

      result.set(schemaName, { exclusions, dependents });
    }
  }

  return result;
}

function resolveRef(spec: OpenApiSpec, ref: string): OpenApiSchema | null {
  const parts = ref.replace("#/", "").split("/");
  let current: any = spec;
  for (const part of parts) {
    current = current?.[part];
  }
  return current || null;
}

// Postman converts {param} to :param — normalize Postman paths to match OpenAPI
function findMatchingSpecPath(
  spec: OpenApiSpec,
  postmanPath: string
): string | null {
  // Direct match first
  if (spec.paths?.[postmanPath]) return postmanPath;

  // Convert :param to {param} and try matching
  const normalized = postmanPath.replace(/:([^/]+)/g, "{$1}");
  if (spec.paths?.[normalized]) return normalized;

  // Fuzzy match: compare path segments, treating :param as wildcard for {anything}
  for (const specPath of Object.keys(spec.paths || {})) {
    const specParts = specPath.split("/");
    const postmanParts = postmanPath.split("/");
    if (specParts.length !== postmanParts.length) continue;

    let match = true;
    for (let i = 0; i < specParts.length; i++) {
      const sp = specParts[i];
      const pp = postmanParts[i];
      // Both are params, or both are the same literal
      const spIsParam = sp.startsWith("{") && sp.endsWith("}");
      const ppIsParam = pp.startsWith(":");
      if (spIsParam && ppIsParam) continue;
      if (sp !== pp) {
        match = false;
        break;
      }
    }
    if (match) return specPath;
  }

  return null;
}

function getRequestBodySchema(
  spec: OpenApiSpec,
  urlPath: string,
  method: string
): OpenApiSchema | null {
  const specPath = findMatchingSpecPath(spec, urlPath);
  if (!specPath) return null;

  const pathObj = spec.paths?.[specPath];
  if (!pathObj) return null;

  const operation = pathObj[method.toLowerCase()];
  if (!operation?.requestBody?.content?.["application/json"]?.schema)
    return null;

  let schema = operation.requestBody.content["application/json"].schema;
  if (schema.$ref) {
    schema = resolveRef(spec, schema.$ref);
  }
  return schema;
}

function getSchemaNameFromRef(
  spec: OpenApiSpec,
  urlPath: string,
  method: string
): string | null {
  const specPath = findMatchingSpecPath(spec, urlPath);
  if (!specPath) return null;

  const pathObj = spec.paths?.[specPath];
  if (!pathObj) return null;

  const operation = pathObj[method.toLowerCase()];
  const schema =
    operation?.requestBody?.content?.["application/json"]?.schema;
  if (!schema?.$ref) return null;

  const parts = schema.$ref.split("/");
  return parts[parts.length - 1];
}

// ---------------------------------------------------------------------------
// Request body processing: keep only required fields + exclusion handling
// ---------------------------------------------------------------------------

function keepOnlyRequiredFields(
  jsonBody: string,
  requiredFields: string[]
): string {
  if (!jsonBody) return jsonBody;
  try {
    const parsed = JSON.parse(jsonBody);
    const filtered: Record<string, unknown> = {};
    for (const field of requiredFields) {
      if (field in parsed) {
        filtered[field] = parsed[field];
      }
    }
    return JSON.stringify(filtered, null, 2);
  } catch {
    return jsonBody;
  }
}

function createErrorRequestBody(
  jsonBody: string,
  requiredFields: string[]
): string {
  if (!jsonBody || requiredFields.length === 0) return jsonBody;
  try {
    const parsed = JSON.parse(jsonBody);
    const filtered: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (key !== requiredFields[0]) {
        filtered[key] = value;
      }
    }
    return JSON.stringify(filtered, null, 2);
  } catch {
    return jsonBody;
  }
}

function applyExclusions(
  jsonBody: string,
  exclusionMap: ExclusionMap
): string {
  if (!jsonBody) return jsonBody;
  try {
    const parsed = JSON.parse(jsonBody);
    const fieldsToRemove = new Set<string>();

    // For each exclusion group, keep only the first field present (by property order)
    for (const group of exclusionMap.exclusions) {
      const presentFields = Object.keys(parsed).filter((k) => group.has(k));
      if (presentFields.length > 1) {
        // Keep the first, remove the rest
        for (let i = 1; i < presentFields.length; i++) {
          fieldsToRemove.add(presentFields[i]);
        }
      }
    }

    // Remove dependents of removed fields
    for (const removed of fieldsToRemove) {
      const deps = exclusionMap.dependents.get(removed);
      if (deps) {
        for (const dep of deps) {
          fieldsToRemove.add(dep);
        }
      }
    }

    if (fieldsToRemove.size === 0) return jsonBody;

    const filtered: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (!fieldsToRemove.has(key)) {
        filtered[key] = value;
      }
    }
    return JSON.stringify(filtered, null, 2);
  } catch {
    return jsonBody;
  }
}

function processBody(
  body: string,
  requiredFields: string[] | undefined,
  exclusion: ExclusionMap | undefined,
  isError: boolean
): string {
  let result = body;
  if (requiredFields) {
    result = isError
      ? createErrorRequestBody(result, requiredFields)
      : keepOnlyRequiredFields(result, requiredFields);
  }
  if (exclusion) {
    result = applyExclusions(result, exclusion);
  }
  return result;
}

export function processItems(
  items: PostmanItem[],
  spec: OpenApiSpec,
  exclusionMaps: Map<string, ExclusionMap>
): void {
  for (const item of items) {
    if (item.item) {
      processItems(item.item, spec, exclusionMaps);
    } else if (item.request?.body?.raw) {
      const urlPath = "/" + (item.request.url?.path?.join("/") || "");
      const method = item.request.method || "POST";

      const schema = getRequestBodySchema(spec, urlPath, method);
      const schemaName = getSchemaNameFromRef(spec, urlPath, method);
      const exclusion = schemaName
        ? exclusionMaps.get(schemaName)
        : undefined;

      item.request.body.raw = processBody(
        item.request.body.raw,
        schema?.required,
        exclusion,
        false
      );

      if (item.response) {
        for (const response of item.response) {
          if (response.originalRequest?.body?.raw) {
            const isError =
              response.code !== undefined &&
              response.code >= 400 &&
              response.code < 500;

            response.originalRequest.body.raw = processBody(
              response.originalRequest.body.raw,
              schema?.required,
              exclusion,
              isError
            );
          }
        }
      }
    }
  }
}
