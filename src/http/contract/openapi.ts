import YAML from "yaml";
import { z } from "zod";

import { KANTHORD_VERSION } from "../../domain/version.ts";
import { errorEnvelopeSchema } from "./errors.ts";
import { parameterNames, renderOpenApiPath } from "./path.ts";
import type { Operation } from "./operation.ts";
import { registry } from "./registry.ts";

const fixedMethodOrder = ["delete", "get", "post", "put"] as const;

export function buildOpenApiDocument(): Readonly<Record<string, unknown>> {
  const schemas = new Map<string, unknown>();
  schemas.set(
    "Error",
    z.toJSONSchema(errorEnvelopeSchema, {
      target: "openapi-3.0",
      io: "output",
    }),
  );

  const byPath = new Map<string, Map<string, Operation>>();
  for (const entry of registry) {
    const path = renderOpenApiPath(entry.path);
    const byMethod = byPath.get(path);
    if (byMethod === undefined) {
      byPath.set(path, new Map([[entry.method.toLowerCase(), entry]]));
    } else {
      byMethod.set(entry.method.toLowerCase(), entry);
    }
  }

  const paths: Record<string, unknown> = {};
  const sortedPathKeys = [...byPath.keys()].sort(compareBytewise);
  for (const path of sortedPathKeys) {
    const byMethod = byPath.get(path);
    if (byMethod === undefined) continue;
    const pathObject: Record<string, unknown> = {};
    for (const method of fixedMethodOrder) {
      const entry = byMethod.get(method);
      if (entry === undefined) continue;
      pathObject[method] = operationObject(entry, schemas);
    }
    paths[path] = pathObject;
  }

  const sortedSchemas: Record<string, unknown> = {};
  for (const key of [...schemas.keys()].sort(compareBytewise)) {
    const schema = schemas.get(key);
    if (schema !== undefined) sortedSchemas[key] = schema;
  }

  return {
    openapi: "3.0.3",
    info: { title: "kanthord", version: KANTHORD_VERSION },
    security: [{ bearerAuth: [] }],
    paths,
    components: {
      securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
      schemas: sortedSchemas,
    },
  };
}

export function renderOpenApiYaml(): string {
  return YAML.stringify(buildOpenApiDocument(), { lineWidth: 0 });
}

function operationObject(
  entry: Operation,
  schemas: Map<string, unknown>,
): Record<string, unknown> {
  const operation: Record<string, unknown> = {
    operationId: entry.operationId,
  };

  const parameters = parameterNames(entry.path);
  if (parameters.length > 0) {
    operation.parameters = parameters.map((name) => ({
      name,
      in: "path",
      required: true,
      schema: { type: "string" },
    }));
  }

  const successKey = String(entry.successStatus ?? 200);
  const responses: Record<string, unknown> = {};
  if (entry.status === "routed") {
    const success: Record<string, unknown> = { description: entry.operationId };
    if (entry.response !== undefined) {
      const schemaName = `${entry.operationId}.response`;
      schemas.set(
        schemaName,
        z.toJSONSchema(entry.response, { target: "openapi-3.0", io: "output" }),
      );
      success.content = {
        "application/json": {
          schema: { $ref: `#/components/schemas/${schemaName}` },
        },
      };
    }
    responses[successKey] = success;
  } else {
    responses["501"] = { description: "not implemented" };
  }
  responses.default = {
    description: "error",
    content: {
      "application/json": {
        schema: { $ref: "#/components/schemas/Error" },
      },
    },
  };
  operation.responses = responses;

  if (entry.request !== undefined) {
    const schemaName = `${entry.operationId}.request`;
    schemas.set(
      schemaName,
      z.toJSONSchema(entry.request, { target: "openapi-3.0", io: "input" }),
    );
    operation.requestBody = {
      required: true,
      content: {
        "application/json": {
          schema: { $ref: `#/components/schemas/${schemaName}` },
        },
      },
    };
  }

  return operation;
}

function compareBytewise(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}
