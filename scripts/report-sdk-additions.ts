import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseSpec, toCamelCase } from "@workos/oagen";
import type { Extractor } from "@workos/oagen/compat";
import type { Addition, ApiSurface, DiffResult } from "@workos/oagen/compat";
import {
  diffSurfaces,
  filterSurface,
  nodeExtractor,
  pythonExtractor,
  specDerivedEnumValues,
  specDerivedFieldPaths,
  specDerivedMethodPaths,
  specDerivedNames,
} from "@workos/oagen/compat";

type Args = {
  language: string;
  spec: string;
  baseline: string;
  "candidate-dir": string;
  output: string;
};

type ManifestEntry = {
  service: string;
  sdkMethod: string;
};

type Manifest = Record<string, ManifestEntry>;

type ModuleRow = {
  moduleName: string;
  sourceFile: string;
};

type MethodRow = {
  moduleName: string;
  operation: string;
  endpoint: string;
  sourceFile: string;
};

const extractors: Record<string, Extractor> = {
  node: nodeExtractor,
  python: pythonExtractor,
};

function parseArgs(argv: string[]): Args {
  const args: Partial<Args> = {};

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected argument: ${arg}`);
    }

    const key = arg.slice(2) as keyof Args;
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for --${key}`);
    }

    args[key] = value;
    i += 1;
  }

  for (const required of ["language", "spec", "baseline", "candidate-dir", "output"] as const) {
    if (!args[required]) {
      throw new Error(`Missing required argument: --${required}`);
    }
  }

  return args as Args;
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

async function loadManifest(candidateDir: string): Promise<Manifest> {
  const manifestPath = path.join(candidateDir, "smoke-manifest.json");

  try {
    return JSON.parse(await readFile(manifestPath, "utf8")) as Manifest;
  } catch {
    return {};
  }
}

function buildModuleRows(diff: DiffResult, candidate: ApiSurface): ModuleRow[] {
  return diff.additions
    .filter((addition: Addition) => addition.symbolType === "class")
    .map((addition: Addition) => ({
      moduleName: addition.symbolPath,
      sourceFile: candidate.classes[addition.symbolPath]?.sourceFile ?? "-",
    }))
    .sort((a, b) => a.moduleName.localeCompare(b.moduleName));
}

function buildMethodRows(
  diff: DiffResult,
  candidate: ApiSurface,
  manifest: Manifest,
): MethodRow[] {
  const endpointByMethod = new Map<string, string>(
    Object.entries(manifest).map(([httpKey, entry]) => [
      `${entry.service}.${entry.sdkMethod}`,
      httpKey,
    ]),
  );

  return diff.additions
    .filter((addition: Addition) => addition.symbolType === "method")
    .map((addition: Addition) => {
      const [moduleName, operation] = addition.symbolPath.split(".");
      const sourceFile = candidate.classes[moduleName]?.sourceFile ?? "-";
      const endpointKey = `${toCamelCase(moduleName)}.${operation}`;

      return {
        moduleName,
        operation,
        endpoint: endpointByMethod.get(endpointKey) ?? "-",
        sourceFile,
      };
    })
    .sort(
      (a, b) =>
        a.moduleName.localeCompare(b.moduleName) ||
        a.operation.localeCompare(b.operation),
    );
}

function renderMarkdown(
  language: string,
  moduleRows: ModuleRow[],
  methodRows: MethodRow[],
): string {
  let markdown = `### SDK additions (${language})\n\n`;

  if (moduleRows.length === 0 && methodRows.length === 0) {
    markdown += "No new SDK modules or operations.\n";
    return markdown;
  }

  if (moduleRows.length > 0) {
    markdown += "#### New modules\n\n";
    markdown += "| Module | Source file |\n";
    markdown += "|---|---|\n";
    markdown += moduleRows
      .map(
        (row) =>
          `| \`${escapeCell(row.moduleName)}\` | \`${escapeCell(row.sourceFile)}\` |`,
      )
      .join("\n");
    markdown += "\n\n";
  }

  if (methodRows.length > 0) {
    markdown += "#### New operations\n\n";
    markdown += "| Module | Operation | Endpoint | Source file |\n";
    markdown += "|---|---|---|---|\n";
    markdown += methodRows
      .map(
        (row) =>
          `| \`${escapeCell(row.moduleName)}\` | \`${escapeCell(row.operation)}\` | \`${escapeCell(row.endpoint)}\` | \`${escapeCell(row.sourceFile)}\` |`,
      )
      .join("\n");
    markdown += "\n";
  }

  return markdown;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const extractor = extractors[args.language];

  if (!extractor) {
    throw new Error(`Unsupported language for additions report: ${args.language}`);
  }

  const baseline = JSON.parse(
    await readFile(args.baseline, "utf8"),
  ) as ApiSurface;
  const candidate = await extractor.extract(args["candidate-dir"]);
  const spec = await parseSpec(args.spec);

  const allowedNames = specDerivedNames(spec, extractor.hints);
  const filterOptions = {
    enumValues: specDerivedEnumValues(spec),
    fieldPaths: specDerivedFieldPaths(spec, extractor.hints),
    methodPaths: specDerivedMethodPaths(spec),
  };

  const diff = diffSurfaces(
    filterSurface(baseline, allowedNames, filterOptions),
    filterSurface(candidate, allowedNames, filterOptions),
    extractor.hints,
  );

  const manifest = await loadManifest(args["candidate-dir"]);
  const moduleRows = buildModuleRows(diff, candidate);
  const methodRows = buildMethodRows(diff, candidate, manifest);
  const markdown = renderMarkdown(args.language, moduleRows, methodRows);

  await writeFile(args.output, markdown);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
