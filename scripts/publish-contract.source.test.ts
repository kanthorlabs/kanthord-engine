import { publishContract } from "./publish-contract.ts";
import SwaggerParser from "@apidevtools/swagger-parser";
import YAML from "yaml";
import {
  buildOpenApiDocument,
  openApiFeatures,
  renderOpenApiYaml,
} from "../src/http/contract/openapi.ts";
import { buildOpenApiSourceTree } from "../src/http/contract/openapi-source.ts";
import { registry } from "../src/http/contract/registry.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

function collectRefs(node: unknown, found: string[]): string[] {
  if (Array.isArray(node)) {
    for (const item of node) collectRefs(item, found);
    return found;
  }
  if (node !== null && typeof node === "object") {
    for (const [key, value] of Object.entries(
      node as Record<string, unknown>,
    )) {
      if (key === "$ref" && typeof value === "string") found.push(value);
      else collectRefs(value, found);
    }
  }
  return found;
}

function compareBytewise(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

function normalise(value: unknown): unknown {
  const plain = JSON.parse(JSON.stringify(value)) as unknown;
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (node !== null && typeof node === "object") {
      const sorted: Record<string, unknown> = {};
      for (const key of Object.keys(node as Record<string, unknown>).sort(
        compareBytewise,
      )) {
        sorted[key] = walk((node as Record<string, unknown>)[key]);
      }
      return sorted;
    }
    return node;
  };
  return walk(plain);
}

type RefVerdict = "ok" | "absolute" | "scheme" | "escapes" | "missing";

function classifyRef(
  ref: string,
  fileDirectory: string,
  root: string,
): RefVerdict {
  const hash = ref.indexOf("#");
  const pathPart = hash === -1 ? ref : ref.slice(0, hash);
  if (pathPart === "") return "ok";
  if (pathPart.startsWith("/")) return "absolute";
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(pathPart)) return "scheme";

  const target = resolve(fileDirectory, pathPart);
  if (!target.startsWith(`${resolve(root)}${sep}`)) return "escapes";
  return existsSync(target) ? "ok" : "missing";
}

function emittedFiles(directory: string): string[] {
  return (readdirSync(directory, { recursive: true }) as string[])
    .map((name) => name.split(sep).join("/"))
    .filter((name) => statSync(join(directory, name)).isFile())
    .sort(compareBytewise);
}

test("classifies a reference against the publication boundary", () => {
  const root = mkdtempSync(join(tmpdir(), "kanthord-contract-ref-"));
  try {
    const fileDirectory = join(root, "source", "features");
    const componentReference =
      "../components/actor.yaml#/schemas/actor.list.response";
    const componentPath = join(root, "source", "components", "actor.yaml");

    assert.equal(
      classifyRef("#/components/schemas/Error", fileDirectory, root),
      "ok",
      "#/components/schemas/Error",
    );
    assert.equal(
      classifyRef(componentReference, fileDirectory, root),
      "missing",
      componentReference,
    );

    mkdirSync(join(root, "source", "components"), { recursive: true });
    writeFileSync(componentPath, "", { encoding: "utf8" });
    assert.equal(
      classifyRef(componentReference, fileDirectory, root),
      "ok",
      componentReference,
    );
    assert.equal(
      classifyRef("/components/actor.yaml#/schemas/x", fileDirectory, root),
      "absolute",
      "/components/actor.yaml#/schemas/x",
    );
    assert.equal(
      classifyRef(
        "https://example.invalid/a.yaml#/schemas/x",
        fileDirectory,
        root,
      ),
      "scheme",
      "https://example.invalid/a.yaml#/schemas/x",
    );
    assert.equal(
      classifyRef(
        "../../../components/actor.yaml#/schemas/x",
        fileDirectory,
        root,
      ),
      "escapes",
      "../../../components/actor.yaml#/schemas/x",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bundles the modular root with no external reference left", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kanthord-contract-source-"));
  try {
    publishContract({
      outputDirectory: directory,
      commit: "0".repeat(40),
      tag: null,
    });

    const bundled = await SwaggerParser.bundle(
      join(directory, "source", "openapi.yaml"),
    );
    const refs = collectRefs(bundled, []);
    assert.deepEqual(
      refs.filter((ref) => !ref.startsWith("#/")),
      [],
    );
    assert.deepEqual(
      Object.keys((bundled as { paths: object }).paths),
      Object.keys((buildOpenApiDocument() as { paths: object }).paths),
    );
    assert.equal(refs.length > 0, true, "the bundle holds no reference at all");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("reports no circular reference in the modular root", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kanthord-contract-source-"));
  try {
    publishContract({
      outputDirectory: directory,
      commit: "0".repeat(40),
      tag: null,
    });

    const parser = new SwaggerParser();
    await parser.bundle(join(directory, "source", "openapi.yaml"));
    assert.equal(parser.$refs.circular, false);
    assert.equal(
      parser.$refs.paths().length > 1,
      true,
      "the parser resolved only the root file",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("dereferences to the same document as the canonical master", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kanthord-contract-source-"));
  try {
    publishContract({
      outputDirectory: directory,
      commit: "0".repeat(40),
      tag: null,
    });

    const fromSource = await SwaggerParser.dereference(
      join(directory, "source", "openapi.yaml"),
    );
    const fromMaster = await SwaggerParser.dereference(
      join(directory, "openapi.yaml"),
    );
    assert.deepStrictEqual(normalise(fromSource), normalise(fromMaster));
    assert.deepEqual(
      Object.keys((fromMaster as { paths: object }).paths),
      Object.keys((buildOpenApiDocument() as { paths: object }).paths),
    );

    const catalogue = (fromSource as unknown as Record<string, unknown>)[
      "x-kanthord-event-payloads"
    ];
    assert.ok(catalogue !== null && typeof catalogue === "object");
    assert.equal(Object.keys(catalogue).length, 39);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("validates the modular root from disk", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kanthord-contract-source-"));
  try {
    publishContract({
      outputDirectory: directory,
      commit: "0".repeat(40),
      tag: null,
    });

    await SwaggerParser.validate(join(directory, "source", "openapi.yaml"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("resolves every emitted reference inside the publication directory", () => {
  const directory = mkdtempSync(join(tmpdir(), "kanthord-contract-source-"));
  try {
    publishContract({
      outputDirectory: directory,
      commit: "0".repeat(40),
      tag: null,
    });

    const offenders: Array<{ file: string; ref: string; verdict: RefVerdict }> =
      [];
    for (const file of emittedFiles(directory)) {
      if (!file.endsWith(".yaml") && !file.endsWith(".json")) continue;
      const value = file.endsWith(".yaml")
        ? YAML.parse(readFileSync(join(directory, file), "utf8"))
        : JSON.parse(readFileSync(join(directory, file), "utf8"));
      for (const ref of collectRefs(value, [])) {
        const verdict = classifyRef(
          ref,
          dirname(join(directory, file)),
          directory,
        );
        if (verdict !== "ok") offenders.push({ file, ref, verdict });
      }
    }

    assert.deepEqual(
      offenders,
      [],
      offenders
        .map((offender) => `${offender.file} holds ${offender.ref}`)
        .join("\n"),
    );

    const document = buildOpenApiDocument();
    const methodCount = Object.values(
      document.paths as Record<string, Record<string, unknown>>,
    ).reduce((total, item) => total + Object.keys(item).length, 0);
    const schemaCount = Object.keys(
      (document.components as { schemas: object }).schemas,
    ).length;
    const catalogue = (document as Record<string, unknown>)[
      "x-kanthord-event-payloads"
    ];
    if (catalogue === null || typeof catalogue !== "object") {
      throw new Error("the document has no event payload catalogue");
    }
    const catalogueCount = Object.keys(catalogue).length;
    const rootRefs = collectRefs(
      YAML.parse(
        readFileSync(join(directory, "source", "openapi.yaml"), "utf8"),
      ),
      [],
    );
    assert.equal(
      rootRefs.length,
      methodCount + 1 + schemaCount + catalogueCount,
    );

    const exampleCount = registry.filter(
      (entry) => entry.examples !== undefined,
    ).length;
    assert.equal(
      emittedFiles(directory).length,
      1 +
        openApiFeatures().length +
        exampleCount +
        1 +
        buildOpenApiSourceTree().size,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("emits identical bytes for every source file across two publications", () => {
  const firstDirectory = mkdtempSync(
    join(tmpdir(), "kanthord-contract-source-first-"),
  );
  const secondDirectory = mkdtempSync(
    join(tmpdir(), "kanthord-contract-source-second-"),
  );
  try {
    for (const outputDirectory of [firstDirectory, secondDirectory]) {
      publishContract({
        outputDirectory,
        commit: "0".repeat(40),
        tag: null,
      });
    }

    const first = emittedFiles(firstDirectory).filter((name) =>
      name.startsWith("source/"),
    );
    const second = emittedFiles(secondDirectory).filter((name) =>
      name.startsWith("source/"),
    );
    assert.deepEqual(first, second);
    assert.equal(first.length, buildOpenApiSourceTree().size);
    for (const name of first) {
      assert.equal(
        Buffer.compare(
          readFileSync(join(firstDirectory, name)),
          readFileSync(join(secondDirectory, name)),
        ),
        0,
        name,
      );
    }
  } finally {
    rmSync(firstDirectory, { recursive: true, force: true });
    rmSync(secondDirectory, { recursive: true, force: true });
  }
});

test("keeps the self-contained forms self-contained", () => {
  const directory = mkdtempSync(join(tmpdir(), "kanthord-contract-source-"));
  try {
    publishContract({
      outputDirectory: directory,
      commit: "0".repeat(40),
      tag: null,
    });

    const masterPath = join(directory, "openapi.yaml");
    const masterRefs = collectRefs(
      YAML.parse(readFileSync(masterPath, "utf8")),
      [],
    );
    assert.deepEqual(
      masterRefs.filter((ref) => !ref.startsWith("#/components/schemas/")),
      [],
    );
    assert.equal(
      Buffer.compare(
        readFileSync(masterPath),
        Buffer.from(renderOpenApiYaml(), "utf8"),
      ),
      0,
    );

    for (const feature of openApiFeatures()) {
      const slice = join(directory, "features", `${feature.name}.yaml`);
      const sliceRefs = collectRefs(
        YAML.parse(readFileSync(slice, "utf8")),
        [],
      );
      assert.deepEqual(
        sliceRefs.filter((ref) => !ref.startsWith("#/components/schemas/")),
        [],
        feature.name,
      );
      assert.equal(
        Buffer.compare(
          readFileSync(slice),
          Buffer.from(renderOpenApiYaml(feature.operations), "utf8"),
        ),
        0,
        feature.name,
      );
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
