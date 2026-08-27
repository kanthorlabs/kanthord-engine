import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

import { compareBytewise } from "./bytewise.ts";

type OffenderLists = Readonly<{
  nodeBuiltins: readonly string[];
  runtimeRoots: readonly string[];
  runtimeVendors: readonly string[];
}>;

const coreRoot = resolve(import.meta.dirname);
const sourceRoot = resolve(import.meta.dirname, "../..");

function isExempt(relativeDirectoryPath: string): boolean {
  return relativeDirectoryPath === "runtime";
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\r\n]*/g, "");
}

function extractSpecifiers(source: string): readonly string[] {
  const stripped = stripComments(source);
  const patterns = [
    /\b(?:import|export)\b[\s\S]*?\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  const specifiers: string[] = [];
  for (const pattern of patterns) {
    for (const match of stripped.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier !== undefined) {
        specifiers.push(specifier);
      }
    }
  }
  return specifiers;
}

function coreTypeScriptFiles(root: string): readonly string[] {
  const files: string[] = [];
  const walk = (relativeDirectoryPath: string): void => {
    const directory = resolve(root, relativeDirectoryPath);
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relativePath = relativeDirectoryPath
        ? `${relativeDirectoryPath}/${entry.name}`
        : entry.name;
      if (entry.isDirectory()) {
        if (!isExempt(relativePath)) {
          walk(relativePath);
        }
      } else if (
        entry.isFile() &&
        entry.name.endsWith(".ts") &&
        !entry.name.endsWith(".test.ts")
      ) {
        files.push(relativePath);
      }
    }
  };
  walk("");
  return files.sort(compareBytewise);
}

function sourceTypeScriptFiles(root: string): readonly string[] {
  const files: string[] = [];
  const walk = (relativeDirectoryPath: string): void => {
    const directory = resolve(root, relativeDirectoryPath);
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relativePath = relativeDirectoryPath
        ? `${relativeDirectoryPath}/${entry.name}`
        : entry.name;
      if (entry.isDirectory()) {
        walk(relativePath);
      } else if (
        entry.isFile() &&
        entry.name.endsWith(".ts") &&
        !entry.name.endsWith(".test.ts")
      ) {
        files.push(relativePath);
      }
    }
  };
  walk("");
  return files.sort(compareBytewise);
}

function offendersFor(relativePath: string, source: string): OffenderLists {
  const specifiers = extractSpecifiers(source);
  return {
    nodeBuiltins: specifiers
      .filter((specifier) => specifier.startsWith("node:"))
      .map((specifier) => `${relativePath}: ${specifier}`),
    runtimeRoots: specifiers
      .filter((specifier) => specifier.includes("runtime/"))
      .map((specifier) => `${relativePath}: ${specifier}`),
    runtimeVendors: specifiers
      .filter(
        (specifier) =>
          specifier === "@hono/node-server" ||
          specifier.startsWith("@hono/node-server/"),
      )
      .map((specifier) => `${relativePath}: ${specifier}`),
  };
}

function coreOffenders(): OffenderLists {
  const lists = {
    nodeBuiltins: [] as string[],
    runtimeRoots: [] as string[],
    runtimeVendors: [] as string[],
  };
  for (const relativePath of coreTypeScriptFiles(coreRoot)) {
    const current = offendersFor(
      relativePath,
      readFileSync(resolve(coreRoot, relativePath), "utf8"),
    );
    lists.nodeBuiltins.push(...current.nodeBuiltins);
    lists.runtimeRoots.push(...current.runtimeRoots);
    lists.runtimeVendors.push(...current.runtimeVendors);
  }
  return lists;
}

function nodeRootImporterOffenders(): readonly string[] {
  const offenders: string[] = [];
  for (const relativePath of sourceTypeScriptFiles(sourceRoot)) {
    if (relativePath === "main.ts") {
      continue;
    }
    const file = resolve(sourceRoot, relativePath);
    for (const specifier of extractSpecifiers(readFileSync(file, "utf8"))) {
      if (!specifier.startsWith(".")) {
        continue;
      }
      const target = relative(
        sourceRoot,
        resolve(dirname(file), specifier),
      ).replaceAll("\\", "/");
      if (target.startsWith("http/server/runtime/")) {
        offenders.push(`${relativePath}: ${specifier}`);
      }
    }
  }
  return offenders.sort(compareBytewise);
}

describe("src/http/server/core-purity.test", () => {
  it("the core imports no node builtin", () => {
    assert.deepEqual(coreOffenders().nodeBuiltins, []);
  });

  it("the core reaches into no runtime root", () => {
    assert.deepEqual(coreOffenders().runtimeRoots, []);
  });

  it("the core imports no runtime-only vendor package", () => {
    assert.deepEqual(coreOffenders().runtimeVendors, []);
  });

  it("src/main.ts is the only production importer of the Node root", () => {
    assert.deepEqual(nodeRootImporterOffenders(), []);
  });

  it("a single-line node import is detected", () => {
    assert.deepEqual(
      extractSpecifiers('import { createServer } from "node:http";'),
      ["node:http"],
    );
  });

  it("a multiline node import is detected", () => {
    assert.deepEqual(
      extractSpecifiers(
        ["import {", "  createServer,", '} from "node:http";'].join("\n"),
      ),
      ["node:http"],
    );
  });

  it("a node re-export is detected", () => {
    assert.deepEqual(
      extractSpecifiers('export { createServer } from "node:http";'),
      ["node:http"],
    );
  });

  it("a node type import is detected", () => {
    assert.deepEqual(
      extractSpecifiers('import type { Server } from "node:http";'),
      ["node:http"],
    );
  });

  it("a node side-effect import is detected", () => {
    assert.deepEqual(extractSpecifiers('import "node:http";'), ["node:http"]);
  });

  it("a node dynamic import is detected", () => {
    assert.deepEqual(extractSpecifiers('await import("node:http")'), [
      "node:http",
    ]);
  });

  it("a single-quoted specifier is detected", () => {
    assert.deepEqual(
      extractSpecifiers("import { createServer } from 'node:http';"),
      ["node:http"],
    );
  });

  it("a commented import is not detected", () => {
    assert.deepEqual(
      extractSpecifiers(
        [
          '// import { createServer } from "node:http";',
          '/* import { createServer } from "node:http"; */',
        ].join("\n"),
      ),
      [],
    );
  });

  it("an object property named node is not detected", () => {
    assert.deepEqual(
      extractSpecifiers("const row = { node: parsed.data.node };"),
      [],
    );
  });

  it("a runtime reach is detected in the runtime list only", () => {
    const offenders = offendersFor(
      "app.ts",
      'import { listen } from "./runtime/node/listen.ts";',
    );
    assert.deepEqual(offenders.nodeBuiltins, []);
    assert.deepEqual(offenders.runtimeRoots, [
      "app.ts: ./runtime/node/listen.ts",
    ]);
  });

  it("the runtime vendor package is detected", () => {
    const offenders = offendersFor(
      "app.ts",
      'import { serve } from "@hono/node-server";',
    );
    assert.deepEqual(offenders.runtimeVendors, ["app.ts: @hono/node-server"]);
  });

  it("isExempt compares the whole path", () => {
    assert.equal(isExempt("runtime"), true);
    assert.equal(isExempt("node/runtime"), false);
    assert.equal(isExempt("runtime/node"), false);
    assert.equal(isExempt("event"), false);
  });

  it("the walk applies the runtime exemption", () => {
    const files = coreTypeScriptFiles(coreRoot);
    assert.equal(files.includes("runtime/node/listen.ts"), false);
    assert.equal(files.includes("app.ts"), true);
    assert.equal(files.includes("idempotency-key.ts"), true);
    assert.equal(files.includes("node/create-node.ts"), true);
  });
});
