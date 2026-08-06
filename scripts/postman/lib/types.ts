export interface PostmanCollection {
  info: {
    name: string;
    schema: string;
    [key: string]: unknown;
  };
  item: PostmanItem[];
  variable?: PostmanVariable[];
  [key: string]: unknown;
}

export interface PostmanItem {
  id?: string;
  name: string;
  description?: { content: string; type: string } | string;
  item?: PostmanItem[];
  request?: PostmanRequest;
  response?: PostmanResponse[];
  [key: string]: unknown;
}

export interface PostmanRequest {
  method?: string;
  url?: PostmanUrl;
  header?: PostmanHeader[];
  body?: { mode?: string; raw?: string; [key: string]: unknown };
  description?: string | { content: string; type: string };
  [key: string]: unknown;
}

export interface PostmanUrl {
  path?: string[];
  query?: PostmanParam[];
  variable?: PostmanParam[];
  [key: string]: unknown;
}

export interface PostmanParam {
  key: string;
  value?: string;
  disabled?: boolean;
  [key: string]: unknown;
}

export interface PostmanHeader {
  key: string;
  value?: string;
  disabled?: boolean;
  [key: string]: unknown;
}

export interface PostmanResponse {
  code?: number;
  originalRequest?: PostmanRequest;
  header?: PostmanHeader[];
  [key: string]: unknown;
}

export interface PostmanVariable {
  key: string;
  value: string;
  type?: string;
}

export interface ExclusionMap {
  exclusions: Set<string>[];
  dependents: Map<string, string[]>;
}

// OpenAPI types (minimal subset we need)
export interface OpenApiSpec {
  paths: Record<string, Record<string, OpenApiOperation>>;
  components?: {
    schemas?: Record<string, OpenApiSchema>;
  };
  [key: string]: unknown;
}

export interface OpenApiOperation {
  requestBody?: {
    content?: {
      "application/json"?: {
        schema?: OpenApiSchema;
      };
    };
  };
  [key: string]: unknown;
}

export interface OpenApiSchema {
  $ref?: string;
  type?: string;
  properties?: Record<string, OpenApiSchema>;
  required?: string[];
  description?: string;
  [key: string]: unknown;
}
