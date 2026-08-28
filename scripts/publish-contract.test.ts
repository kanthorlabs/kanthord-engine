import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import SwaggerParser from "@apidevtools/swagger-parser";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

import { publishContract, refusesSelfPublish } from "./publish-contract.ts";
import { KANTHORD_VERSION } from "../src/domain/version.ts";
import { buildErrorEnvelope } from "../src/http/contract/errors.ts";
import {
  eventPayloadCatalogueKey,
  openApiFeatures,
  renderOpenApiYaml,
} from "../src/http/contract/openapi.ts";
import { eventPayloads } from "../src/http/contract/event-payload.ts";
import { reachableSchemaNames } from "../src/http/contract/schema-reachability.ts";
import { registry } from "../src/http/contract/registry.ts";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

type SchemaNode = {
  oneOf?: readonly SchemaNode[];
  properties?: Record<string, SchemaNode>;
  enum?: readonly string[];
  default?: unknown;
  additionalProperties?: boolean;
};

type PublishedParameter = {
  name: string;
  required: boolean;
  schema: SchemaNode;
};

function compare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

function sortedBytewise(values: readonly string[]): string[] {
  return [...values].sort(compare);
}

const publishedEntries = registry.filter(
  (entry) => entry.examples !== undefined,
);
const publishedOperationIds = publishedEntries.map(
  (entry) => entry.operationId,
);
const features = openApiFeatures();
const featureNames = features.map((feature) => feature.name);

function publishedDirectory(t: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), "kanthord-contract-"));
  t.after(() => {
    rmSync(directory, { recursive: true, force: true });
  });
  publishContract({
    outputDirectory: directory,
    commit: "0".repeat(40),
    tag: null,
  });
  return directory;
}

test("scripts/publish-contract", async (t) => {
  await t.test(
    "writes the master document, feature documents and examples",
    async (t) => {
      const directory = publishedDirectory(t);

      assert.deepEqual(sortedBytewise(readdirSync(directory)), [
        "examples",
        "features",
        "manifest.json",
        "openapi.yaml",
        "source",
      ]);

      assert.deepEqual(sortedBytewise(readdirSync(join(directory, "source"))), [
        "components",
        "features",
        "openapi.yaml",
      ]);
      assert.equal(
        readdirSync(join(directory, "source", "components")).length,
        15,
      );
      assert.equal(
        readdirSync(join(directory, "source", "features")).length,
        19,
      );

      const featureFiles = readdirSync(join(directory, "features"));
      assert.deepEqual(
        sortedBytewise(featureFiles),
        sortedBytewise(featureNames.map((name) => `${name}.yaml`)),
      );
      for (const feature of features) {
        const filePath = join(directory, "features", `${feature.name}.yaml`);
        const document = YAML.parse(readFileSync(filePath, "utf8")) as {
          paths: Record<string, Record<string, Record<string, unknown>>>;
        };
        const operationIds = Object.values(document.paths).flatMap((path) =>
          Object.values(path).map((operation) => String(operation.operationId)),
        );
        assert.deepEqual(
          sortedBytewise(operationIds),
          sortedBytewise(feature.operations.map((entry) => entry.operationId)),
        );
        await SwaggerParser.validate(filePath);
      }

      const exampleFiles = readdirSync(join(directory, "examples"));
      assert.equal(exampleFiles.length, 43);
      const exampleIds = sortedBytewise(
        exampleFiles.map((name) => name.replace(/\.json$/, "")),
      );
      assert.deepEqual(exampleIds, sortedBytewise(publishedOperationIds));
      for (const name of exampleFiles) {
        assert.match(name, /^[a-zA-Z][a-zA-Z.]*\.json$/);
      }
    },
  );

  await t.test("the document is the generated document", (t) => {
    const directory = publishedDirectory(t);
    const content = readFileSync(join(directory, "openapi.yaml"), "utf8");
    assert.equal(content, renderOpenApiYaml());
  });

  await t.test(
    "the manifest carries publication metadata and the operation list",
    (t) => {
      const directory = publishedDirectory(t);
      const raw = readFileSync(join(directory, "manifest.json"), "utf8");
      const manifest = JSON.parse(raw) as Record<string, unknown> & {
        source: string;
      };

      assert.equal(manifest.version, KANTHORD_VERSION);
      assert.deepEqual(manifest.operations, publishedOperationIds);
      assert.deepEqual(Object.keys(manifest), [
        "version",
        "commit",
        "tag",
        "source",
        "features",
        "operations",
      ]);
      assert.equal(manifest.tag, null);
      assert.equal(String(manifest.commit), "0".repeat(40));
      assert.deepEqual(manifest.features, featureNames);
      assert.equal(manifest.source, "source/openapi.yaml");
      assert.equal(existsSync(join(directory, manifest.source)), true);
      assert.match(
        raw,
        /"version"[\s\S]*"commit"[\s\S]*"tag"[\s\S]*"source"[\s\S]*"features"[\s\S]*"operations"/,
      );
    },
  );

  await t.test("the manifest carries no timestamp", (t) => {
    const directory = publishedDirectory(t);
    const raw = readFileSync(join(directory, "manifest.json"), "utf8");
    assert.doesNotMatch(raw, /"[^"]*generatedAt[^"]*"\s*:/i);
    assert.doesNotMatch(raw, /"[^"]*timestamp[^"]*"\s*:/i);
    assert.doesNotMatch(raw, /"[^"]*date[^"]*"\s*:/i);
    assert.doesNotMatch(raw, /"[^"]*dirty[^"]*"\s*:/i);
  });

  await t.test("the manifest names exactly the files that were written", () => {
    const own = mkdtempSync(join(tmpdir(), "kanthord-contract-manifest-"));
    try {
      const written = publishContract({
        outputDirectory: own,
        commit: "0".repeat(40),
        tag: null,
      });
      const published = JSON.parse(
        readFileSync(join(own, "manifest.json"), "utf8"),
      ) as { features: string[]; operations: string[] };

      const writtenFeatures = written.filter((relative) =>
        relative.startsWith(`features${sep}`),
      );
      const writtenExamples = written.filter((relative) =>
        relative.startsWith(`examples${sep}`),
      );
      const manifestFeatures = published.features.map((name) =>
        join("features", `${name}.yaml`),
      );
      const manifestExamples = published.operations.map((id) =>
        join("examples", `${id}.json`),
      );

      assert.equal(writtenFeatures.length, 19);
      assert.equal(writtenExamples.length, 43);
      assert.deepEqual(
        manifestFeatures.filter((entry) => !writtenFeatures.includes(entry)),
        [],
      );
      assert.deepEqual(
        writtenFeatures.filter((entry) => !manifestFeatures.includes(entry)),
        [],
      );
      assert.deepEqual(
        manifestExamples.filter((entry) => !writtenExamples.includes(entry)),
        [],
      );
      assert.deepEqual(
        writtenExamples.filter((entry) => !manifestExamples.includes(entry)),
        [],
      );
      assert.deepEqual(
        sortedBytewise(manifestFeatures),
        sortedBytewise(writtenFeatures),
      );
      assert.deepEqual(
        sortedBytewise(manifestExamples),
        sortedBytewise(writtenExamples),
      );
      assert.deepEqual(published.features, sortedBytewise(published.features));
      assert.deepEqual(
        published.operations,
        sortedBytewise(published.operations),
      );
    } finally {
      rmSync(own, { recursive: true, force: true });
    }
  });

  await t.test("the manifest source and lists match returned files", () => {
    const own = mkdtempSync(join(tmpdir(), "kanthord-contract-manifest-"));
    try {
      const written = publishContract({
        outputDirectory: own,
        commit: "0".repeat(40),
        tag: null,
      });
      const manifest = JSON.parse(
        readFileSync(join(own, "manifest.json"), "utf8"),
      ) as { source: string; features: string[]; operations: string[] };

      assert.deepEqual(
        sortedBytewise(written.filter((name) => name.startsWith("features/"))),
        sortedBytewise(
          manifest.features.map((name) => `features/${name}.yaml`),
        ),
      );
      assert.deepEqual(
        sortedBytewise(written.filter((name) => name.startsWith("examples/"))),
        sortedBytewise(manifest.operations.map((id) => `examples/${id}.json`)),
      );
      assert.equal(
        written.includes(`source/${manifest.source.slice("source/".length)}`),
        true,
      );
    } finally {
      rmSync(own, { recursive: true, force: true });
    }
  });

  await t.test("each example file holds its keys in the fixed order", (t) => {
    const directory = publishedDirectory(t);
    const createKeys = Object.keys(
      JSON.parse(
        readFileSync(
          join(directory, "examples", "project.create.json"),
          "utf8",
        ),
      ) as Record<string, unknown>,
    );
    assert.deepEqual(createKeys, ["request", "success", "error"]);

    const listKeys = Object.keys(
      JSON.parse(
        readFileSync(join(directory, "examples", "project.list.json"), "utf8"),
      ) as Record<string, unknown>,
    );
    assert.deepEqual(listKeys, ["success", "error"]);

    const eventListKeys = Object.keys(
      JSON.parse(
        readFileSync(join(directory, "examples", "event.list.json"), "utf8"),
      ) as Record<string, unknown>,
    );
    assert.deepEqual(eventListKeys, ["query", "success", "error"]);
  });

  await t.test("each published example still satisfies its schema", (t) => {
    const directory = publishedDirectory(t);
    for (const entry of publishedEntries) {
      const raw = readFileSync(
        join(directory, "examples", `${entry.operationId}.json`),
        "utf8",
      );
      const parsed = JSON.parse(raw) as Record<string, unknown>;

      assert.doesNotThrow(() => entry.response!.parse(parsed.success));
      if (entry.request !== undefined) {
        assert.doesNotThrow(() => entry.request!.parse(parsed.request));
      }
      if (entry.query !== undefined) {
        assert.doesNotThrow(() => entry.query!.parse(parsed.query));
      }
      assert.doesNotThrow(() =>
        buildErrorEnvelope(entry.errors!).parse(parsed.error),
      );
    }
  });

  await t.test(
    "the published provider feature carries the two request branches",
    (t) => {
      const directory = publishedDirectory(t);
      const document = YAML.parse(
        readFileSync(join(directory, "features", "provider.yaml"), "utf8"),
      ) as { components: { schemas: Record<string, SchemaNode> } };
      const request = document.components.schemas["provider.register.request"]!;

      const branches = request.oneOf!;
      assert.equal(branches.length, 2);
      assert.deepEqual(branches[0]!.properties!.kind!.enum, ["llm"]);
      assert.deepEqual(branches[1]!.properties!.kind!.enum, ["git"]);
      assert.equal(branches[0]!.properties!.payload!.oneOf, undefined);
      assert.equal(
        branches[0]!.properties!.payload!.additionalProperties,
        false,
      );

      const transports = branches[1]!.properties!.payload!.oneOf!;
      assert.equal(transports.length, 2);
      assert.deepEqual(
        transports.map((branch) => branch.properties!.transport!.enum),
        [["http-basic"], ["ssh"]],
      );
      for (const transport of transports) {
        assert.equal(transport.additionalProperties, false);
      }
    },
  );

  await t.test(
    "the published event feature carries the cursor parameters",
    () => {
      const eventDirectory = mkdtempSync(
        join(tmpdir(), "kanthord-event-contract-"),
      );
      try {
        publishContract({
          outputDirectory: eventDirectory,
          commit: "0".repeat(40),
          tag: null,
        });

        const document = YAML.parse(
          readFileSync(join(eventDirectory, "features", "event.yaml"), "utf8"),
        ) as {
          paths: Record<
            string,
            Record<string, { parameters: readonly PublishedParameter[] }>
          >;
        };
        const parameters = document.paths["/v1/event"]!.get!.parameters;

        assert.deepEqual(
          parameters.map((parameter) => parameter.name),
          [
            "actor",
            "actorKind",
            "after",
            "before",
            "limit",
            "order",
            "subject",
            "subjectKind",
            "type",
            "wait",
          ],
        );
        for (const parameter of parameters) {
          assert.equal(parameter.required, false);
        }

        const order = parameters.find(
          (parameter) => parameter.name === "order",
        );
        assert.ok(order);
        assert.deepEqual(order.schema.enum, ["asc", "desc"]);
        assert.equal(order.schema.default, "asc");
      } finally {
        rmSync(eventDirectory, { recursive: true, force: true });
      }
    },
  );

  await t.test(
    "every emitted document holds the closure of its own refs",
    (t) => {
      const directory = publishedDirectory(t);
      const paths = [
        "openapi.yaml",
        ...featureNames.map((n) => join("features", `${n}.yaml`)),
      ];
      assert.equal(paths.length, 20);
      for (const relative of paths) {
        const document = YAML.parse(
          readFileSync(join(directory, relative), "utf8"),
        );
        const schemas = document.components.schemas as Record<string, unknown>;
        assert.deepEqual(
          sortedBytewise([...reachableSchemaNames(document)]),
          sortedBytewise(Object.keys(schemas)),
          `${relative} is not its own closure`,
        );
      }
    },
  );

  await t.test(
    "only the master and the event slice carry the catalogue",
    (t) => {
      const directory = publishedDirectory(t);
      const master = YAML.parse(
        readFileSync(join(directory, "openapi.yaml"), "utf8"),
      );
      assert.deepEqual(
        Object.keys(master[eventPayloadCatalogueKey]),
        sortedBytewise(Object.keys(eventPayloads)),
      );

      for (const name of featureNames) {
        const document = YAML.parse(
          readFileSync(join(directory, "features", `${name}.yaml`), "utf8"),
        );
        const carries = Object.hasOwn(document, eventPayloadCatalogueKey);
        assert.equal(
          carries,
          name === "event",
          `${name} carries the wrong catalogue state`,
        );
      }
    },
  );

  await t.test("the node slice drops every event payload schema", (t) => {
    const directory = publishedDirectory(t);
    const node = YAML.parse(
      readFileSync(join(directory, "features", "node.yaml"), "utf8"),
    );
    const nodeSchemas = node.components.schemas as Record<string, unknown>;
    for (const type of Object.keys(eventPayloads)) {
      assert.equal(
        Object.hasOwn(nodeSchemas, type),
        false,
        `node.yaml holds ${type}`,
      );
    }

    const event = YAML.parse(
      readFileSync(join(directory, "features", "event.yaml"), "utf8"),
    );
    const eventSchemas = event.components.schemas as Record<string, unknown>;
    for (const type of Object.keys(eventPayloads)) {
      assert.equal(
        Object.hasOwn(eventSchemas, type),
        true,
        `event.yaml lost ${type}`,
      );
    }
  });

  await t.test(
    "no emitted document holds a $ref outside its own components",
    (t) => {
      const directory = publishedDirectory(t);
      const paths = [
        "openapi.yaml",
        ...featureNames.map((n) => join("features", `${n}.yaml`)),
      ];
      for (const relative of paths) {
        const text = readFileSync(join(directory, relative), "utf8");
        const document = YAML.parse(text);
        const refs: string[] = [];
        const walk = (value: unknown): void => {
          if (Array.isArray(value)) return value.forEach(walk);
          if (value === null || typeof value !== "object") return;
          for (const [key, nested] of Object.entries(value)) {
            if (key === "$ref" && typeof nested === "string") refs.push(nested);
            else walk(nested);
          }
        };
        walk(document);
        assert.ok(refs.length > 0, `${relative} carries no $ref`);
        for (const ref of refs) {
          assert.ok(
            ref.startsWith("#/components/schemas/"),
            `${relative} holds external or malformed $ref ${ref}`,
          );
        }
      }
    },
  );

  await t.test("generation is byte-identical across two runs", () => {
    const first = mkdtempSync(join(tmpdir(), "kanthord-contract-a-"));
    const second = mkdtempSync(join(tmpdir(), "kanthord-contract-b-"));
    try {
      const commit = "0".repeat(40);
      const firstFiles = publishContract({
        outputDirectory: first,
        commit,
        tag: "v27.8.1",
      });
      const secondFiles = publishContract({
        outputDirectory: second,
        commit,
        tag: "v27.8.1",
      });

      assert.deepEqual(firstFiles, secondFiles);
      for (const relative of firstFiles) {
        const a = readFileSync(join(first, relative));
        const b = readFileSync(join(second, relative));
        assert.equal(
          Buffer.compare(a, b),
          0,
          `${relative} differs between runs`,
        );
      }
    } finally {
      rmSync(first, { recursive: true, force: true });
      rmSync(second, { recursive: true, force: true });
    }
  });

  await t.test("the manifest records an unreleased artifact", () => {
    const clean = mkdtempSync(join(tmpdir(), "kanthord-contract-clean-"));
    const unreleased = mkdtempSync(
      join(tmpdir(), "kanthord-contract-unreleased-"),
    );
    try {
      const commit = "0".repeat(40);
      publishContract({
        outputDirectory: clean,
        commit,
        tag: "v27.8.1",
      });
      publishContract({ outputDirectory: unreleased, commit, tag: null });

      const releasedManifest = JSON.parse(
        readFileSync(join(clean, "manifest.json"), "utf8"),
      ) as Record<string, unknown>;
      const unreleasedManifest = JSON.parse(
        readFileSync(join(unreleased, "manifest.json"), "utf8"),
      ) as Record<string, unknown>;
      assert.equal(releasedManifest.tag, "v27.8.1");
      assert.equal(unreleasedManifest.tag, null);

      const cleanBytes = readFileSync(join(clean, "manifest.json"));
      const unreleasedBytes = readFileSync(join(unreleased, "manifest.json"));
      assert.notDeepEqual(cleanBytes, unreleasedBytes);
    } finally {
      rmSync(clean, { recursive: true, force: true });
      rmSync(unreleased, { recursive: true, force: true });
    }
  });

  await t.test(
    "a released manifest and an unreleased manifest of the same commit differ",
    () => {
      const released = mkdtempSync(
        join(tmpdir(), "kanthord-contract-released-"),
      );
      const unreleased = mkdtempSync(
        join(tmpdir(), "kanthord-contract-unreleased-"),
      );
      try {
        const commit = "0".repeat(40);
        const releasedFiles = publishContract({
          outputDirectory: released,
          commit,
          tag: "v27.8.1",
        });
        const unreleasedFiles = publishContract({
          outputDirectory: unreleased,
          commit,
          tag: null,
        });

        assert.deepEqual(releasedFiles, unreleasedFiles);
        for (const relative of releasedFiles) {
          const releasedBytes = readFileSync(join(released, relative));
          const unreleasedBytes = readFileSync(join(unreleased, relative));
          if (relative === "manifest.json") {
            assert.notDeepEqual(releasedBytes, unreleasedBytes);
          } else {
            assert.deepEqual(releasedBytes, unreleasedBytes);
          }
        }
      } finally {
        rmSync(released, { recursive: true, force: true });
        rmSync(unreleased, { recursive: true, force: true });
      }
    },
  );

  await t.test("refuses to publish into the repository", () => {
    assert.throws(
      () =>
        execFileSync(
          process.execPath,
          ["scripts/publish-contract.ts", repositoryRoot],
          { cwd: repositoryRoot, encoding: "utf8" },
        ),
      (error: NodeJS.ErrnoException & { status?: number; stderr?: string }) => {
        assert.equal(error.status, 2);
        assert.match(
          String(error.stderr),
          /refusing to publish into the repository/,
        );
        return true;
      },
    );

    assert.throws(
      () =>
        execFileSync(process.execPath, ["scripts/publish-contract.ts", "."], {
          cwd: repositoryRoot,
          encoding: "utf8",
        }),
      (error: NodeJS.ErrnoException & { status?: number; stderr?: string }) => {
        assert.equal(error.status, 2);
        assert.match(
          String(error.stderr),
          /refusing to publish into the repository/,
        );
        return true;
      },
    );

    assert.equal(existsSync(join(repositoryRoot, "openapi.yaml")), false);
  });

  await t.test("refuses to publish into a repository descendant", () => {
    const existing = join(repositoryRoot, "src");
    const missing = join(repositoryRoot, ".kanthord-contract-child");
    const sentinel = join(existing, "main.ts");
    const before = readFileSync(sentinel);

    assert.equal(refusesSelfPublish(existing), true);
    assert.equal(refusesSelfPublish(missing), true);
    assert.throws(
      () =>
        publishContract({
          outputDirectory: existing,
          commit: "0".repeat(40),
          tag: null,
        }),
      /refusing to publish into the repository/,
    );
    assert.throws(
      () =>
        publishContract({
          outputDirectory: missing,
          commit: "0".repeat(40),
          tag: null,
        }),
      /refusing to publish into the repository/,
    );
    assert.deepEqual(readFileSync(sentinel), before);
    assert.equal(existsSync(missing), false);
  });

  await t.test("clears a stale file from a previous publication", (t) => {
    const directory = publishedDirectory(t);
    writeFileSync(join(directory, "examples", "gone.json"), "junk");
    writeFileSync(join(directory, "features", "gone.yaml"), "junk");
    writeFileSync(join(directory, "openapi.yaml"), "junk");
    writeFileSync(join(directory, "source", "components", "gone.yaml"), "junk");

    publishContract({
      outputDirectory: directory,
      commit: "0".repeat(40),
      tag: null,
    });

    assert.equal(existsSync(join(directory, "examples", "gone.json")), false);
    assert.equal(existsSync(join(directory, "features", "gone.yaml")), false);
    assert.equal(
      readFileSync(join(directory, "openapi.yaml"), "utf8"),
      renderOpenApiYaml(),
    );
    assert.equal(
      existsSync(join(directory, "source", "components", "gone.yaml")),
      false,
    );
  });

  await t.test("refuses to run with no output directory", () => {
    assert.throws(
      () =>
        execFileSync(process.execPath, ["scripts/publish-contract.ts"], {
          cwd: repositoryRoot,
          encoding: "utf8",
        }),
      (error: NodeJS.ErrnoException & { status?: number; stderr?: string }) => {
        assert.equal(error.status, 2);
        assert.match(String(error.stderr), /usage:/);
        return true;
      },
    );
  });

  await t.test("refuses an unknown flag", (t) => {
    const directory = publishedDirectory(t);
    assert.throws(
      () =>
        execFileSync(
          process.execPath,
          ["scripts/publish-contract.ts", "--tag", directory],
          { cwd: repositoryRoot, encoding: "utf8" },
        ),
      (error: NodeJS.ErrnoException & { status?: number; stderr?: string }) => {
        assert.equal(error.status, 2);
        assert.equal(
          String(error.stderr),
          "usage: node scripts/publish-contract.ts [--unreleased] <output-directory>\n",
        );
        return true;
      },
    );
  });

  await t.test("writes no document into the repository root", () => {
    assert.equal(existsSync(join(repositoryRoot, "openapi.yaml")), false);
    assert.equal(existsSync(join(repositoryRoot, "manifest.json")), false);
  });
});
