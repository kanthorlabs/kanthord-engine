import YAML from "yaml";

import { buildOpenApiDocument, openApiFeatures } from "./openapi.ts";
import type { Operation } from "./operation.ts";
import { registry } from "./registry.ts";

export function buildOpenApiSourceTree(
  entries: readonly Operation[] = registry,
): ReadonlyMap<string, string> {
  const document = buildOpenApiDocument(entries);
  const components = document.components as {
    schemas: Record<string, unknown>;
    securitySchemes: Record<string, unknown>;
  };
  const operationsById = new Map<string, unknown>();
  for (const pathObject of Object.values(
    document.paths as Record<string, unknown>,
  )) {
    for (const operation of Object.values(
      pathObject as Record<string, unknown>,
    )) {
      const id = (operation as { operationId?: unknown }).operationId;
      if (typeof id === "string") operationsById.set(id, operation);
    }
  }
  const schemasByPrefix = new Map<string, Record<string, unknown>>();

  for (const [name, schema] of Object.entries(components.schemas)) {
    const prefix = prefixOf(name);
    const schemas = schemasByPrefix.get(prefix);
    if (schemas === undefined) {
      schemasByPrefix.set(prefix, { [name]: schema });
    } else {
      schemas[name] = schema;
    }
  }

  for (const prefix of schemasByPrefix.keys()) {
    if (prefix.toLowerCase() !== "security") continue;
    const [first, second] = [prefix, "security"].sort(compareBytewise);
    throw new Error(`component file name collision: ${first} and ${second}`);
  }

  const fileNames = [...schemasByPrefix.keys(), "security"];
  const namesByLowerCase = new Map<string, string>();
  for (const name of fileNames) {
    const lowerCaseName = name.toLowerCase();
    const previous = namesByLowerCase.get(lowerCaseName);
    if (previous !== undefined && previous !== name) {
      const [first, second] = [previous, name].sort(compareBytewise);
      throw new Error(`component file name collision: ${first} and ${second}`);
    }
    namesByLowerCase.set(lowerCaseName, name);
  }

  const files = new Map<string, string>();
  for (const [prefix, schemas] of schemasByPrefix) {
    files.set(
      `components/${prefix}.yaml`,
      YAML.stringify({ schemas: rewriteRefs(schemas, "./") }, { lineWidth: 0 }),
    );
  }
  files.set(
    "components/security.yaml",
    YAML.stringify(
      { securitySchemes: components.securitySchemes },
      { lineWidth: 0 },
    ),
  );

  for (const feature of openApiFeatures(entries)) {
    const operations: Record<string, unknown> = {};
    for (const entry of feature.operations) {
      const operation = operationsById.get(entry.operationId);
      if (operation === undefined) {
        throw new Error(
          `operation not found in OpenAPI document: ${entry.operationId}`,
        );
      }
      operations[entry.operationId] = rewriteRefs(operation, "../components/");
    }
    files.set(
      `features/${feature.name}.yaml`,
      YAML.stringify({ operations }, { lineWidth: 0 }),
    );
  }

  const root: Record<string, unknown> = {};
  for (const key of Object.keys(document)) {
    root[key] = rootValueFor(key, document);
  }
  files.set("openapi.yaml", YAML.stringify(root, { lineWidth: 0 }));

  return new Map(
    [...files.entries()].sort(([a], [b]) => compareBytewise(a, b)),
  );
}

function prefixOf(name: string): string {
  const separator = name.indexOf(".");
  return separator === -1 ? name : name.slice(0, separator);
}

function rootValueFor(
  key: string,
  document: Readonly<Record<string, unknown>>,
): unknown {
  switch (key) {
    case "openapi":
    case "info":
    case "security":
      return document[key];
    case "paths":
      return modularPaths(document[key]);
    case "components":
      return modularComponents(document[key]);
    case "x-kanthord-event-payloads":
      return rewriteRefs(document[key], "./components/");
    default:
      throw new Error(`unknown root key in the master document: ${key}`);
  }
}

function modularPaths(value: unknown): Record<string, unknown> {
  const paths = value as Record<string, Record<string, unknown>>;
  const modular: Record<string, unknown> = {};

  for (const [path, pathObject] of Object.entries(paths)) {
    const methods: Record<string, unknown> = {};
    for (const [method, operation] of Object.entries(pathObject)) {
      const operationId = (operation as { operationId: string }).operationId;
      methods[method] = {
        $ref: `./features/${prefixOf(operationId)}.yaml#/operations/${operationId}`,
      };
    }
    modular[path] = methods;
  }

  return modular;
}

function modularComponents(value: unknown): Record<string, unknown> {
  const master = value as {
    securitySchemes: Record<string, unknown>;
    schemas: Record<string, unknown>;
  };
  const securitySchemes: Record<string, unknown> = {};
  for (const name of Object.keys(master.securitySchemes)) {
    securitySchemes[name] = {
      $ref: `./components/security.yaml#/securitySchemes/${name}`,
    };
  }

  const schemas: Record<string, unknown> = {};
  for (const name of Object.keys(master.schemas)) {
    schemas[name] = {
      $ref: `./components/${prefixOf(name)}.yaml#/schemas/${name}`,
    };
  }

  return { securitySchemes, schemas };
}

function rewriteRefs(value: unknown, componentBase: string): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => rewriteRefs(item, componentBase));
  }
  if (value === null || typeof value !== "object") {
    return value;
  }

  const rewritten: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (
      key === "$ref" &&
      typeof child === "string" &&
      child.startsWith("#/components/schemas/")
    ) {
      const pointer = child.slice("#/components/schemas/".length);
      const separator = pointer.indexOf("/");
      const encodedName =
        separator === -1 ? pointer : pointer.slice(0, separator);
      const name = decodePointer(encodedName);
      const suffix = separator === -1 ? "" : pointer.slice(separator);
      rewritten[key] =
        `${componentBase}${prefixOf(name)}.yaml#/schemas/${encodedName}${suffix}`;
    } else {
      rewritten[key] = rewriteRefs(child, componentBase);
    }
  }
  return rewritten;
}

function decodePointer(segment: string): string {
  return segment.replaceAll("~1", "/").replaceAll("~0", "~");
}

function compareBytewise(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}
