import { buildOpenApiDocument, renderOpenApiYaml } from "./openapi.ts";
import { registry } from "./registry.ts";
import { KANTHORD_VERSION } from "../../domain/version.ts";
import SwaggerParser from "@apidevtools/swagger-parser";
import YAML from "yaml";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const fixedMethodOrder = ["delete", "get", "post", "put"] as const;

function compare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

function sortedBytewise(values: readonly string[]): string[] {
  return [...values].sort(compare);
}

function operationObjects(document: Readonly<Record<string, unknown>>): Array<{
  operationId: string;
  method: string;
  path: string;
  operation: Record<string, unknown>;
}> {
  const paths = document.paths as Readonly<Record<string, unknown>>;
  const found: Array<{
    operationId: string;
    method: string;
    path: string;
    operation: Record<string, unknown>;
  }> = [];
  for (const [path, pathObject] of Object.entries(paths)) {
    for (const [method, operation] of Object.entries(
      pathObject as Readonly<Record<string, unknown>>,
    )) {
      const record = operation as Record<string, unknown>;
      found.push({
        operationId: String(record.operationId),
        method,
        path,
        operation: record,
      });
    }
  }
  return found;
}

const openApiDirectory = mkdtempSync(join(tmpdir(), "kanthord-openapi-"));
after(() => {
  rmSync(openApiDirectory, { recursive: true, force: true });
});

test("documents openapi 3.0.3 and the product info", () => {
  const document = buildOpenApiDocument();
  assert.equal(document.openapi, "3.0.3");
  assert.deepEqual(document.info, {
    title: "kanthord",
    version: KANTHORD_VERSION,
  });
});

test("renders forty-seven distinct paths in bytewise order", () => {
  const document = buildOpenApiDocument();
  const paths = document.paths as Readonly<Record<string, unknown>>;
  const keys = Object.keys(paths);
  assert.equal(keys.length, 47);
  assert.deepEqual(keys, sortedBytewise(keys));
});

test("orders methods within a path by the fixed sequence", () => {
  const document = buildOpenApiDocument();
  const paths = document.paths as Readonly<Record<string, unknown>>;
  for (const pathObject of Object.values(paths)) {
    const keys = Object.keys(pathObject as Readonly<Record<string, unknown>>);
    const order = keys.map((key) =>
      fixedMethodOrder.indexOf(key as (typeof fixedMethodOrder)[number]),
    );
    for (let i = 0; i < order.length - 1; i += 1) {
      assert.ok(
        order[i] !== undefined && order[i]! >= 0,
        `method ${keys[i]} is not one of the fixed four`,
      );
      assert.ok(order[i + 1]! > order[i]!, `method keys leave the fixed order`);
    }
  }
  assert.deepEqual(
    Object.keys(
      paths["/v1/repository/{id}/profile"] as Readonly<Record<string, unknown>>,
    ),
    ["get", "post", "put"],
  );
  assert.deepEqual(
    Object.keys(
      paths["/v1/provider/{id}"] as Readonly<Record<string, unknown>>,
    ),
    ["delete", "get"],
  );
});

test("names every operation and matches the registry set", () => {
  const document = buildOpenApiDocument();
  const ids = operationObjects(document).map((entry) => entry.operationId);
  assert.equal(ids.length, 53);
  assert.deepEqual(
    sortedBytewise(ids),
    sortedBytewise(registry.map((entry) => entry.operationId)),
  );
});

test("carries the bearer default and lets every operation inherit it", () => {
  const document = buildOpenApiDocument();
  const securitySchemes = document.components as Readonly<
    Record<string, unknown>
  >;
  const schemes = (securitySchemes as Readonly<Record<string, unknown>>)
    .securitySchemes as Readonly<Record<string, unknown>>;
  assert.deepEqual(schemes.bearerAuth, { type: "http", scheme: "bearer" });
  assert.deepEqual(document.security, [{ bearerAuth: [] }]);
  for (const entry of operationObjects(document)) {
    assert.equal(
      Object.hasOwn(entry.operation, "security"),
      false,
      `${entry.operationId} overrides the bearer default`,
    );
  }
});

test("templates path parameters with their names in order", () => {
  const document = buildOpenApiDocument();
  const paths = document.paths as Readonly<Record<string, unknown>>;
  const unblock = (
    paths["/v1/node/{id}/unblock"] as Readonly<Record<string, unknown>>
  ).post as Readonly<Record<string, unknown>>;
  assert.deepEqual(unblock.parameters, [
    {
      name: "id",
      in: "path",
      required: true,
      schema: { type: "string" },
    },
  ]);
  const blobParameters = (
    (paths["/v1/blob/{hash}"] as Readonly<Record<string, unknown>>)
      .get as Readonly<Record<string, unknown>>
  ).parameters as readonly Record<string, unknown>[];
  assert.equal(blobParameters[0]?.name, "hash");
});

test("documents each entry as its success or stub status", () => {
  const document = buildOpenApiDocument();
  const paths = document.paths as Readonly<Record<string, unknown>>;
  const healthResponses = (
    (paths["/v1/health"] as Readonly<Record<string, unknown>>).get as Readonly<
      Record<string, unknown>
    >
  ).responses as Readonly<Record<string, unknown>>;
  assert.equal(Object.hasOwn(healthResponses, "200"), true);
  const unblockResponses = (
    (paths["/v1/node/{id}/unblock"] as Readonly<Record<string, unknown>>)
      .post as Readonly<Record<string, unknown>>
  ).responses as Readonly<Record<string, unknown>>;
  assert.equal(Object.hasOwn(unblockResponses, "501"), true);
  assert.equal(Object.hasOwn(unblockResponses, "200"), false);
  for (const entry of operationObjects(document)) {
    const responses = entry.operation.responses as Readonly<
      Record<string, unknown>
    >;
    assert.equal(Object.hasOwn(responses, "default"), true);
  }
});

test("documents the routed success status from successStatus", () => {
  const document = buildOpenApiDocument();
  const byId = new Map(
    operationObjects(document).map((entry) => [entry.operationId, entry]),
  );
  for (const entry of registry) {
    const found = byId.get(entry.operationId);
    assert.ok(found, `no operation object for ${entry.operationId}`);
    const responses = found.operation.responses as Readonly<
      Record<string, unknown>
    >;
    const expected =
      entry.status === "stubbed" ? "501" : String(entry.successStatus ?? 200);
    assert.deepEqual(Object.keys(responses), [expected, "default"]);
  }
  assert.equal(
    registry.some((entry) => entry.successStatus !== undefined),
    false,
  );
});

test("registers exactly the twenty-nine schema components in bytewise order", () => {
  const document = buildOpenApiDocument();
  const components = document.components as Readonly<Record<string, unknown>>;
  const schemas = components.schemas as Readonly<Record<string, unknown>>;
  assert.deepEqual(Object.keys(schemas), [
    "Error",
    "edge.list.response",
    "node.list.response",
    "node.show.response",
    "plan.export.response",
    "plan.import.request",
    "plan.import.response",
    "plan.revisions.response",
    "plan.validate.request",
    "plan.validate.response",
    "project.create.request",
    "project.create.response",
    "project.list.response",
    "project.repositories.request",
    "project.repositories.response",
    "project.show.response",
    "provider.list.response",
    "provider.register.request",
    "provider.register.response",
    "provider.show.response",
    "repository.inspect.request",
    "repository.inspect.response",
    "repository.list.response",
    "repository.register.request",
    "repository.register.response",
    "repository.show.response",
    "system.db.response",
    "system.health.response",
    "system.status.response",
  ]);
});

test("refers to components only through internal refs", () => {
  const document = buildOpenApiDocument();
  const refs: string[] = [];
  collectRefs(document, refs);
  assert.ok(refs.length > 0, "the document carries no $ref at all");
  for (const ref of refs) {
    assert.ok(
      ref.startsWith("#/components/schemas/"),
      `external or malformed $ref ${ref}`,
    );
  }
  const components = document.components as Readonly<Record<string, unknown>>;
  const schemas = components.schemas as Readonly<Record<string, unknown>>;
  for (const ref of refs) {
    const key = ref.slice("#/components/schemas/".length);
    assert.equal(Object.hasOwn(schemas, key), true, `dangling $ref ${ref}`);
  }
});

test("renders canonical yaml", () => {
  const yaml = renderOpenApiYaml();
  assert.equal(yaml.includes("\r"), false);
  assert.equal(yaml.endsWith("\n"), true);
  assert.equal(yaml.endsWith("\n\n"), false);
  assert.equal(yaml, renderOpenApiYaml());
});

test("validates the generated document and deletes its directory", async () => {
  const filePath = join(openApiDirectory, "openapi.yaml");
  writeFileSync(filePath, renderOpenApiYaml(), "utf8");
  await SwaggerParser.validate(filePath);
});

test("is never committed to the repository root", () => {
  assert.equal(existsSync(join(repositoryRoot, "openapi.yaml")), false);
});

test("rejects a document missing info.version", async () => {
  const document = structuredClone(buildOpenApiDocument()) as Record<
    string,
    unknown
  >;
  const info = document.info as Record<string, unknown>;
  delete info.version;
  const filePath = join(openApiDirectory, "no-version.yaml");
  writeFileSync(filePath, YAML.stringify(document), "utf8");
  await assert.rejects(SwaggerParser.validate(filePath));
});

test("rejects a dangling schema reference", async () => {
  const document = structuredClone(buildOpenApiDocument()) as Record<
    string,
    unknown
  >;
  const paths = document.paths as Record<string, unknown>;
  const health = paths["/v1/health"] as Record<string, unknown>;
  const responses = (health.get as Record<string, unknown>).responses as Record<
    string,
    unknown
  >;
  const defaultResponse = responses.default as Record<string, unknown>;
  const content = defaultResponse.content as Record<string, unknown>;
  const json = content["application/json"] as Record<string, unknown>;
  const schema = json.schema as Record<string, unknown>;
  schema.$ref = "#/components/schemas/missing";
  const filePath = join(openApiDirectory, "dangling-ref.yaml");
  writeFileSync(filePath, YAML.stringify(document), "utf8");
  await assert.rejects(SwaggerParser.validate(filePath));
});

test("keeps the validator out of production sources", () => {
  const srcDirectory = join(repositoryRoot, "src");
  const entries = readdirSync(srcDirectory, { recursive: true }) as string[];
  const sources = entries
    .filter(
      (name) =>
        name.endsWith(".ts") &&
        !name.endsWith(".test.ts") &&
        !name.endsWith(".d.ts"),
    )
    .map((name) => join(srcDirectory, name));
  assert.ok(sources.length > 0, "no production sources found to scan");
  for (const source of sources) {
    assert.equal(
      readFileSync(source, "utf8").includes("@apidevtools/swagger-parser"),
      false,
      `${source} names the validator`,
    );
  }
});

function collectRefs(value: unknown, refs: string[]): void {
  if (Array.isArray(value)) {
    for (const element of value) {
      collectRefs(element, refs);
    }
    return;
  }
  if (value === null || typeof value !== "object") {
    return;
  }
  for (const [key, nested] of Object.entries(value)) {
    if (key === "$ref" && typeof nested === "string") {
      refs.push(nested);
    } else {
      collectRefs(nested, refs);
    }
  }
}
