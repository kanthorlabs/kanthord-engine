import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { stringify } from "yaml";
import { z } from "zod";
import { ulidSchema } from "../kernel/identity.ts";
import { errorDetailsSchema, errorSchema } from "../kernel/errors.ts";
import type { Operation } from "../kernel/operation.ts";
import { AccessPolicy } from "../kernel/operation.ts";
import { packageVersion } from "../kernel/version.ts";
import { HttpStatus } from "../kernel/http.ts";
import { isObject, isString } from "../kernel/values.ts";

export const OPENAPI_INDEX_FILE = "openapi.yaml";
const SHARED_SCOPE = "shared";
const SCHEMA_REFERENCE_KEY = "$ref";
const ParameterLocation = { Path: "path", Query: "query" } as const;

const sharedFile = "openapi/shared/components.yaml";
const sharedRef = "../shared/components.yaml#/components";
const generatedHeader =
  "# Generated from the operation registry by kanthord gateway openapi.\n";
const pointer = (name: string) => name.replace(/~/g, "~0").replace(/\//g, "~1");

export interface OpenAPIDocument {
  openapi: string;
  info: { title: string; version: string };
  paths: Record<string, { $ref: string }>;
  components: { securitySchemes: Record<string, { $ref: string }> };
}
export type OpenAPIFiles = Record<string, object> & {
  [OPENAPI_INDEX_FILE]: OpenAPIDocument;
};

/** Service ownership also determines the public artifact directory. */
export function validateOpenAPIScope(operation: Operation): void {
  if (
    !/^[a-z][a-z0-9-]*$/.test(operation.service) ||
    operation.service === SHARED_SCOPE
  )
    throw new Error(
      "An OpenAPI service scope must be a safe name other than shared.",
    );
  const name = operation.id.slice(operation.service.length + 1);
  if (
    !operation.id.startsWith(`${operation.service}.`) ||
    !/^[A-Za-z][A-Za-z0-9._-]*$/.test(name)
  )
    throw new Error("An operation identity must be qualified by its service.");
}

function pathGroups(operations: readonly Operation[]) {
  const groups = new Map<string, Operation[]>();
  const identities = new Set<string>();
  for (const operation of [...operations].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  )) {
    validateOpenAPIScope(operation);
    if (identities.has(operation.id))
      throw new Error("Duplicate operation identity.");
    identities.add(operation.id);
    const path = operation.path.replace(/:([^/]+)/g, "{$1}");
    const group = groups.get(path) ?? [];
    if (group.some((entry) => entry.service !== operation.service))
      throw new Error(
        "All operations at one path must belong to the same service.",
      );
    if (group.some((entry) => entry.method === operation.method))
      throw new Error("Duplicate operation route.");
    group.push(operation);
    groups.set(path, group);
  }
  return [...groups].map(([path, entries]) => {
    const owner = entries[0]!;
    return {
      path,
      operations: entries,
      file: `openapi/${owner.service}/${owner.id.slice(owner.service.length + 1)}.yaml`,
    };
  });
}

/** The serving allowlist is derived without emitting or reading any document. */
export function openAPIFileNames(operations: readonly Operation[]): string[] {
  return [
    OPENAPI_INDEX_FILE,
    sharedFile,
    ...pathGroups(operations).map(({ file }) => file),
  ];
}

function jsonSchema(name: string, schema: z.ZodType): Record<string, unknown> {
  const { $schema: _dialect, ...result } = z.toJSONSchema(schema, {
    override: ({ zodSchema, jsonSchema }) => {
      // Any JSON value is the empty JSON Schema. Avoid recursively enumerating
      // that domain across every path's shared error response.
      if (zodSchema === errorDetailsSchema)
        for (const key of Object.keys(jsonSchema)) delete jsonSchema[key];
    },
  });
  void _dialect;
  const base = `#/components/schemas/${pointer(name)}`;
  const rebase = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(rebase);
    if (!isObject(value)) return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        key === SCHEMA_REFERENCE_KEY && isString(entry) && entry.startsWith("#")
          ? base + entry.slice(1)
          : rebase(entry),
      ]),
    );
  };
  return rebase(result) as Record<string, unknown>;
}

function emitOperation(operation: Operation, schemas: Record<string, unknown>) {
  const inputName = `${operation.id}.Input`;
  const outputName = `${operation.id}.Output`;
  const input = jsonSchema(inputName, operation.input) as {
    properties?: Record<
      string,
      { properties?: Record<string, unknown>; required?: string[] }
    >;
  };
  schemas[inputName] = input;
  schemas[outputName] = jsonSchema(outputName, operation.output);
  const inputRef = `#/components/schemas/${pointer(inputName)}`;
  const parameters: unknown[] = [];
  for (const [location, part] of [
    [ParameterLocation.Path, "params"],
    [ParameterLocation.Query, "query"],
  ] as const) {
    const object = input.properties?.[part];
    for (const name of Object.keys(object?.properties ?? {}))
      parameters.push({
        name,
        in: location,
        required:
          location === ParameterLocation.Path ||
          (object?.required?.includes(name) ?? false),
        schema: {
          $ref: `${inputRef}/properties/${part}/properties/${pointer(name)}`,
        },
      });
  }
  if (operation.mutation)
    parameters.push({ $ref: `${sharedRef}/parameters/IdempotencyKey` });
  const responses: Record<string, unknown> = {
    [operation.status]: {
      description: "Completed result",
      ...(operation.status === HttpStatus.NoContent
        ? {}
        : {
            content: {
              [operation.contentType ?? "application/json"]: {
                schema: { $ref: `#/components/schemas/${pointer(outputName)}` },
              },
            },
          }),
    },
  };
  for (const status of new Set([
    400,
    401,
    403,
    404,
    409,
    413,
    415,
    500,
    503,
    504,
    ...(operation.errors ?? []),
  ]))
    responses[status] = { $ref: `${sharedRef}/responses/Error` };
  return {
    operationId: operation.id,
    tags: [operation.service],
    description: operation.description,
    "x-access-policy": operation.access,
    "x-timeout-ms": operation.timeoutMs,
    "x-mutation": operation.mutation,
    "x-kanthord-lifetime": operation.lifetime,
    security:
      operation.access === AccessPolicy.Human ||
      operation.access === AccessPolicy.Client
        ? [{ bearerAuth: [] }]
        : [],
    parameters,
    ...(operation.body
      ? {
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: `${inputRef}/properties/body` },
              },
            },
          },
        }
      : {}),
    ...(operation.delivery
      ? {
          requestBody: {
            required: true,
            content: {
              "application/octet-stream": {
                schema: { type: "string", contentEncoding: "binary" },
              },
            },
          },
        }
      : {}),
    responses,
  };
}

/** Root index -> service-owned path items and schemas -> shared components. */
export function emitOpenAPIFiles(
  operations: readonly Operation[],
): OpenAPIFiles {
  const document: OpenAPIDocument = {
    openapi: "3.1.0",
    info: { title: "kanthord", version: packageVersion() },
    paths: {},
    components: {
      securitySchemes: {
        bearerAuth: {
          $ref: `./${sharedFile}#/components/securitySchemes/bearerAuth`,
        },
      },
    },
  };
  const files: OpenAPIFiles = {
    [OPENAPI_INDEX_FILE]: document,
    [sharedFile]: {
      components: {
        securitySchemes: {
          bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
        },
        parameters: {
          IdempotencyKey: {
            name: "Idempotency-Key",
            in: "header",
            required: true,
            schema: jsonSchema("IdempotencyKey", ulidSchema),
          },
        },
        responses: {
          Error: {
            description: "Declared failure",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Error" },
              },
            },
          },
        },
        schemas: { Error: jsonSchema("Error", errorSchema) },
      },
    },
  };
  for (const group of pathGroups(operations)) {
    const schemas: Record<string, unknown> = {};
    const pathItem: Record<string, unknown> = {};
    for (const operation of group.operations)
      pathItem[operation.method.toLowerCase()] = emitOperation(
        operation,
        schemas,
      );
    files[group.file] = { pathItem, components: { schemas } };
    document.paths[group.path] = { $ref: `./${group.file}#/pathItem` };
  }
  return files;
}

export function emitOpenAPI(operations: readonly Operation[]): OpenAPIDocument {
  return emitOpenAPIFiles(operations)[OPENAPI_INDEX_FILE];
}

export function serializeOpenAPIFile(document: object): string {
  return generatedHeader + stringify(document);
}

export function writeOpenAPI(
  operations: readonly Operation[],
  root: string,
): void {
  const files = emitOpenAPIFiles(operations);
  // Publish dependencies before the index that references them.
  for (const name of [
    ...Object.keys(files).filter((name) => name !== OPENAPI_INDEX_FILE),
    OPENAPI_INDEX_FILE,
  ]) {
    const path = join(root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, serializeOpenAPIFile(files[name]!));
  }
  // Remove obsolete generated fragments only; preserve other package assets.
  const prune = (directory: string, relative: string): void => {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const name = `${relative}/${entry.name}`;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) prune(path, name);
      else if (
        entry.isFile() &&
        entry.name.endsWith(".yaml") &&
        !Object.hasOwn(files, name) &&
        readFileSync(path, "utf8").startsWith(generatedHeader)
      )
        unlinkSync(path);
    }
  };
  prune(join(root, "openapi"), "openapi");
}
