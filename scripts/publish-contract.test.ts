import { test, after } from "node:test";
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
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

import { publishContract } from "./publish-contract.ts";
import { KANTHORD_VERSION } from "../src/domain/version.ts";
import { buildErrorEnvelope } from "../src/http/contract/errors.ts";
import {
  openApiFeatures,
  renderOpenApiYaml,
} from "../src/http/contract/openapi.ts";
import { registry } from "../src/http/contract/registry.ts";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

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

const directory = mkdtempSync(join(tmpdir(), "kanthord-contract-"));
after(() => {
  rmSync(directory, { recursive: true, force: true });
});

test("scripts/publish-contract", async (t) => {
  await t.test(
    "writes the master document, feature documents and examples",
    async () => {
      execFileSync(
        process.execPath,
        ["scripts/publish-contract.ts", directory],
        {
          cwd: repositoryRoot,
          encoding: "utf8",
        },
      );

      assert.deepEqual(sortedBytewise(readdirSync(directory)), [
        "examples",
        "features",
        "manifest.json",
        "openapi.yaml",
      ]);

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
      assert.equal(exampleFiles.length, 26);
      const exampleIds = sortedBytewise(
        exampleFiles.map((name) => name.replace(/\.json$/, "")),
      );
      assert.deepEqual(exampleIds, sortedBytewise(publishedOperationIds));
      for (const name of exampleFiles) {
        assert.match(name, /^[a-zA-Z][a-zA-Z.]*\.json$/);
      }
    },
  );

  await t.test("the document is the generated document", () => {
    const content = readFileSync(join(directory, "openapi.yaml"), "utf8");
    assert.equal(content, renderOpenApiYaml());
  });

  let manifest: Record<string, unknown> = {};
  await t.test(
    "the manifest carries publication metadata and the operation list",
    () => {
      const raw = readFileSync(join(directory, "manifest.json"), "utf8");
      manifest = JSON.parse(raw) as Record<string, unknown>;

      assert.equal(manifest.version, KANTHORD_VERSION);
      assert.deepEqual(manifest.operations, publishedOperationIds);
      assert.deepEqual(Object.keys(manifest), [
        "version",
        "commit",
        "dirty",
        "features",
        "operations",
      ]);
      assert.equal(typeof manifest.dirty, "boolean");
      assert.deepEqual(manifest.features, featureNames);
      assert.match(String(manifest.commit), /^[0-9a-f]{40,64}$/);
    },
  );

  await t.test("the manifest carries no timestamp", () => {
    const raw = readFileSync(join(directory, "manifest.json"), "utf8");
    assert.doesNotMatch(raw, /"[^"]*generatedAt[^"]*"\s*:/i);
    assert.doesNotMatch(raw, /"[^"]*timestamp[^"]*"\s*:/i);
    assert.doesNotMatch(raw, /"[^"]*date[^"]*"\s*:/i);
  });

  await t.test("each example file holds its keys in the fixed order", () => {
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

  await t.test("each published example still satisfies its schema", () => {
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

  await t.test("generation is byte-identical across two runs", () => {
    const first = mkdtempSync(join(tmpdir(), "kanthord-contract-a-"));
    const second = mkdtempSync(join(tmpdir(), "kanthord-contract-b-"));
    try {
      const commit = "0".repeat(40);
      const firstFiles = publishContract({
        outputDirectory: first,
        commit,
        dirty: false,
      });
      const secondFiles = publishContract({
        outputDirectory: second,
        commit,
        dirty: false,
      });

      assert.deepEqual(firstFiles, secondFiles);
      for (const relative of firstFiles) {
        const a = readFileSync(join(first, relative));
        const b = readFileSync(join(second, relative));
        assert.deepEqual(a, b);
      }
    } finally {
      rmSync(first, { recursive: true, force: true });
      rmSync(second, { recursive: true, force: true });
    }
  });

  await t.test("the manifest records a dirty tree", () => {
    const clean = mkdtempSync(join(tmpdir(), "kanthord-contract-clean-"));
    const dirty = mkdtempSync(join(tmpdir(), "kanthord-contract-dirty-"));
    try {
      const commit = "0".repeat(40);
      publishContract({ outputDirectory: clean, commit, dirty: false });
      publishContract({ outputDirectory: dirty, commit, dirty: true });

      const dirtyManifest = JSON.parse(
        readFileSync(join(dirty, "manifest.json"), "utf8"),
      ) as Record<string, unknown>;
      assert.equal(dirtyManifest.dirty, true);

      const cleanBytes = readFileSync(join(clean, "manifest.json"));
      const dirtyBytes = readFileSync(join(dirty, "manifest.json"));
      assert.notDeepEqual(cleanBytes, dirtyBytes);
    } finally {
      rmSync(clean, { recursive: true, force: true });
      rmSync(dirty, { recursive: true, force: true });
    }
  });

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

  await t.test("clears a stale file from a previous publication", () => {
    writeFileSync(join(directory, "examples", "gone.json"), "junk");
    writeFileSync(join(directory, "features", "gone.yaml"), "junk");
    writeFileSync(join(directory, "openapi.yaml"), "junk");

    publishContract({
      outputDirectory: directory,
      commit: "0".repeat(40),
      dirty: false,
    });

    assert.equal(existsSync(join(directory, "examples", "gone.json")), false);
    assert.equal(existsSync(join(directory, "features", "gone.yaml")), false);
    assert.equal(
      readFileSync(join(directory, "openapi.yaml"), "utf8"),
      renderOpenApiYaml(),
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

  await t.test("writes no document into the repository root", () => {
    assert.equal(existsSync(join(repositoryRoot, "openapi.yaml")), false);
    assert.equal(existsSync(join(repositoryRoot, "manifest.json")), false);
  });
});
