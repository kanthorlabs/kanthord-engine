import { buildOpenApiSourceTree } from "./openapi-source.ts";
import {
  buildOpenApiDocument,
  eventPayloadCatalogueKey,
  openApiFeatures,
} from "./openapi.ts";
import type { Operation } from "./operation.ts";
import YAML from "yaml";
import { z } from "zod";
import { test } from "node:test";
import assert from "node:assert/strict";

function compareBytewise(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

test("emits seventeen component files", () => {
  const tree = buildOpenApiSourceTree();
  const componentKeys = [...tree.keys()]
    .filter((key) => key.startsWith("components/"))
    .sort(compareBytewise);

  assert.equal(componentKeys.length, 17);
  assert.deepEqual(componentKeys, [
    "components/Error.yaml",
    "components/actor.yaml",
    "components/agent.yaml",
    "components/blob.yaml",
    "components/edge.yaml",
    "components/event.yaml",
    "components/node.yaml",
    "components/outcome.yaml",
    "components/plan.yaml",
    "components/project.yaml",
    "components/provider.yaml",
    "components/recovery.yaml",
    "components/repository.yaml",
    "components/run.yaml",
    "components/security.yaml",
    "components/system.yaml",
    "components/worker.yaml",
  ]);
});

test("names each component file after the schema-name prefix", () => {
  const tree = buildOpenApiSourceTree();
  const components = buildOpenApiDocument().components as {
    schemas: Record<string, unknown>;
  };

  for (const name of Object.keys(components.schemas)) {
    const key = `components/${name.split(".")[0]}.yaml`;
    const text = tree.get(key);
    assert.notEqual(text, undefined, `no component file for schema ${name}`);
    if (text === undefined) continue;
    const parsed = YAML.parse(text) as { schemas?: Record<string, unknown> };
    assert.ok(
      parsed.schemas !== undefined && name in parsed.schemas,
      `schema ${name} is not in ${key}`,
    );
  }
});

test("places an event payload schema by its event-type prefix", () => {
  const tree = buildOpenApiSourceTree();
  const text = tree.get("components/node.yaml");
  assert.notEqual(text, undefined);
  if (text === undefined) return;
  const parsed = YAML.parse(text) as { schemas: Record<string, unknown> };

  assert.equal(Object.keys(parsed.schemas).includes("node.created"), true);
  assert.equal(
    Object.keys(parsed.schemas).includes("node.list.response"),
    true,
  );
});

test("holds the exact bytes of the security component file", () => {
  const tree = buildOpenApiSourceTree();
  const actual = tree.get("components/security.yaml");
  const expected =
    "securitySchemes:\n" +
    "  bearerAuth:\n" +
    "    type: http\n" +
    "    scheme: bearer\n";

  assert.equal(actual, expected);
  assert.equal(
    Buffer.compare(
      Buffer.from(actual ?? "", "utf8"),
      Buffer.from(expected, "utf8"),
    ),
    0,
  );
});

test("leaves no internal component pointer in a component file", () => {
  const tree = buildOpenApiSourceTree();

  for (const [key, value] of tree) {
    if (!key.startsWith("components/")) continue;
    assert.equal(value.includes("#/components/schemas/"), false, key);
  }
});

test("rewrites nested component pointers from a component file", () => {
  const entries = [
    {
      operationId: "a.one",
      method: "GET",
      path: [{ kind: "resource", value: "a" }],
      introducedIn: "phase-1",
      status: "routed",
      allowedActors: ["human"],
      response: z.object({
        value: z.string().meta({
          $ref: "#/components/schemas/b.one.response/properties/value",
        }),
      }),
    },
    {
      operationId: "b.one",
      method: "GET",
      path: [{ kind: "resource", value: "b" }],
      introducedIn: "phase-1",
      status: "routed",
      allowedActors: ["human"],
      response: z.object({ value: z.string() }),
    },
  ] as unknown as Operation[];

  const tree = buildOpenApiSourceTree(entries);
  const text = tree.get("components/a.yaml");
  assert.notEqual(text, undefined);
  if (text === undefined) return;
  const document = YAML.parse(text) as {
    schemas: {
      "a.one.response": {
        properties: { value: { $ref: string } };
      };
    };
  };

  assert.equal(
    document.schemas["a.one.response"].properties.value.$ref,
    "./b.yaml#/schemas/b.one.response/properties/value",
  );
});

test("refuses two component file names that differ only by letter case", () => {
  const colliding = [
    {
      operationId: "error.list",
      method: "GET",
      path: [{ kind: "resource", value: "actor" }],
      introducedIn: "phase-1",
      status: "routed",
      allowedActors: ["human"],
      response: z.object({ ok: z.boolean() }),
    },
  ] as unknown as Operation[];

  assert.throws(
    () => buildOpenApiSourceTree(colliding),
    /component file name collision: Error and error/,
  );
});

test("refuses a schema prefix reserved for the security component file", () => {
  for (const operationId of [
    "security.list",
    "Security.list",
    "SECURITY.list",
  ]) {
    const colliding = [
      {
        operationId,
        method: "GET",
        path: [{ kind: "resource", value: "actor" }],
        introducedIn: "phase-1",
        status: "routed",
        allowedActors: ["human"],
        response: z.object({ ok: z.boolean() }),
      },
    ] as unknown as Operation[];

    assert.throws(
      () => buildOpenApiSourceTree(colliding),
      /component file name collision:.*security/i,
      operationId,
    );
  }
});

test("emits nineteen feature fragments", () => {
  const tree = buildOpenApiSourceTree();
  const featureKeys = [...tree.keys()]
    .filter((key) => key.startsWith("features/"))
    .sort(compareBytewise);
  const expected = openApiFeatures()
    .map((feature) => `features/${feature.name}.yaml`)
    .sort(compareBytewise);

  assert.equal(featureKeys.length, 19);
  assert.deepEqual(featureKeys, expected);
});

test("keys a fragment by operationId in bytewise order", () => {
  const tree = buildOpenApiSourceTree();

  for (const feature of openApiFeatures()) {
    const text = tree.get(`features/${feature.name}.yaml`);
    assert.notEqual(text, undefined, `no fragment for feature ${feature.name}`);
    if (text === undefined) continue;
    const parsed = YAML.parse(text) as { operations: Record<string, unknown> };

    assert.deepEqual(Object.keys(parsed), ["operations"]);
    assert.deepEqual(
      Object.keys(parsed.operations),
      feature.operations.map((entry) => entry.operationId),
    );
  }
});

test("holds the exact reference line of actor.list", () => {
  const tree = buildOpenApiSourceTree();
  const text = tree.get("features/actor.yaml");
  assert.notEqual(text, undefined, "no actor feature fragment");
  if (text === undefined) return;

  assert.ok(
    text.includes(
      "              $ref: ../components/actor.yaml#/schemas/actor.list.response\n",
    ),
  );
  assert.ok(
    text.includes(
      "              $ref: ../components/actor.yaml#/schemas/actor.list.error\n",
    ),
  );
});

test("leaves no internal component pointer in a feature fragment", () => {
  const tree = buildOpenApiSourceTree();

  for (const [key, value] of tree) {
    if (!key.startsWith("features/")) continue;
    assert.equal(value.includes("#/components/schemas/"), false, key);
  }

  assert.equal(
    tree.get("features/actor.yaml")?.includes("../components/"),
    true,
  );
});

test("emits one root, nineteen fragments and seventeen component files", () => {
  const tree = buildOpenApiSourceTree();

  assert.equal(tree.size, 37);
  assert.equal(tree.has("openapi.yaml"), true);
});

test("keeps the root key order of the master document", () => {
  const tree = buildOpenApiSourceTree();
  const text = tree.get("openapi.yaml");
  assert.notEqual(text, undefined);
  if (text === undefined) return;

  const root = YAML.parse(text) as Record<string, unknown>;
  const master = buildOpenApiDocument();

  assert.deepEqual(Object.keys(root), Object.keys(master));
  assert.deepEqual(Object.keys(master).slice(0, 5), [
    "openapi",
    "info",
    "security",
    "paths",
    "components",
  ]);
});

test("references a fragment from every path method", () => {
  const tree = buildOpenApiSourceTree();
  const text = tree.get("openapi.yaml");
  assert.notEqual(text, undefined);
  if (text === undefined) return;

  const root = YAML.parse(text) as {
    paths: Record<string, Record<string, unknown>>;
  };
  const master = buildOpenApiDocument() as {
    paths: Record<string, Record<string, { operationId: string }>>;
  };

  assert.deepEqual(Object.keys(root.paths), Object.keys(master.paths));
  for (const path of Object.keys(master.paths)) {
    const rootMethods = root.paths[path];
    const masterMethods = master.paths[path];
    assert.ok(rootMethods);
    assert.ok(masterMethods);
    assert.deepEqual(Object.keys(rootMethods), Object.keys(masterMethods));

    for (const method of Object.keys(masterMethods)) {
      const operationId: string = masterMethods[method]!.operationId;
      assert.deepEqual(rootMethods[method], {
        $ref: `./features/${operationId.split(".")[0]}.yaml#/operations/${operationId}`,
      });
    }
  }
});

test("references a component from every schema and from the security scheme", () => {
  const tree = buildOpenApiSourceTree();
  const text = tree.get("openapi.yaml");
  assert.notEqual(text, undefined);
  if (text === undefined) return;

  const root = YAML.parse(text) as {
    components: {
      schemas: Record<string, unknown>;
      securitySchemes: Record<string, unknown>;
    };
  };
  const master = buildOpenApiDocument() as {
    components: {
      schemas: Record<string, unknown>;
    };
  };

  assert.deepEqual(
    Object.keys(root.components.schemas),
    Object.keys(master.components.schemas),
  );
  for (const name of Object.keys(master.components.schemas)) {
    assert.deepEqual(root.components.schemas[name], {
      $ref: `./components/${name.split(".")[0]}.yaml#/schemas/${name}`,
    });
  }
  assert.deepEqual(root.components.securitySchemes, {
    bearerAuth: {
      $ref: "./components/security.yaml#/securitySchemes/bearerAuth",
    },
  });
});

test("carries the event payload catalogue as thirty-nine external references", () => {
  const tree = buildOpenApiSourceTree();
  const text = tree.get("openapi.yaml");
  assert.notEqual(text, undefined);
  if (text === undefined) return;

  const root = YAML.parse(text) as Record<string, unknown>;
  const master = buildOpenApiDocument();
  const catalogue = root[eventPayloadCatalogueKey] as Record<string, unknown>;
  const masterCatalogue = master[eventPayloadCatalogueKey] as Record<
    string,
    unknown
  >;

  assert.ok(Object.hasOwn(root, eventPayloadCatalogueKey));
  assert.equal(Object.keys(catalogue).length, 39);
  assert.deepEqual(Object.keys(catalogue), Object.keys(masterCatalogue));
  assert.ok(
    text.includes(
      "  node.created:\n    $ref: ./components/node.yaml#/schemas/node.created\n",
    ),
  );

  for (const type of Object.keys(catalogue)) {
    assert.deepEqual(catalogue[type], {
      $ref: `./components/${type.split(".")[0]}.yaml#/schemas/${type}`,
    });
  }
});

test("refuses an unknown root key", () => {
  assert.deepEqual(
    Object.keys(buildOpenApiDocument()).filter(
      (key) =>
        ![
          "openapi",
          "info",
          "security",
          "paths",
          "components",
          "x-kanthord-event-payloads",
        ].includes(key),
    ),
    [],
  );
});
