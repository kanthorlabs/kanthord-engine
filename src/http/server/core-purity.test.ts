import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { compareBytewise } from "./bytewise.ts";

function isExempt(relativeDirectoryPath: string): boolean {
  return relativeDirectoryPath === "runtime";
}

function stripComments(source: string): string {
  const withoutBlock = source.replace(/\/\*[\s\S]*?\*\//g, "");
  const withoutLine = withoutBlock.replace(/\/\/.*$/gm, "");
  return withoutLine;
}

function extractSpecifiers(source: string): string[] {
  const stripped = stripComments(source);
  const specifiers: string[] = [];
  const staticRe = /\b(?:import|export)\b[\s\S]*?\bfrom\s*["']([^"']+)["']/g;
  const sideEffectRe = /\bimport\s*["']([^"']+)["']/g;
  const dynamicRe = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
  let match: RegExpExecArray | null;
  while ((match = staticRe.exec(stripped)) !== null) {
    specifiers.push(match[1] as string);
  }
  while ((match = sideEffectRe.exec(stripped)) !== null) {
    specifiers.push(match[1] as string);
  }
  while ((match = dynamicRe.exec(stripped)) !== null) {
    specifiers.push(match[1] as string);
  }
  return specifiers;
}

function collectCoreRelativePaths(): string[] {
  const coreRoot = resolve(import.meta.dirname);
  const collected: string[] = [];
  function recurse(absoluteDir: string, relativeDir: string): void {
    for (const entry of readdirSync(absoluteDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const nextRelative = relativeDir
          ? `${relativeDir}/${entry.name}`
          : entry.name;
        if (isExempt(nextRelative)) {
          continue;
        }
        recurse(join(absoluteDir, entry.name), nextRelative);
      } else if (
        entry.isFile() &&
        entry.name.endsWith(".ts") &&
        !entry.name.endsWith(".test.ts")
      ) {
        const fileRelative = relativeDir
          ? `${relativeDir}/${entry.name}`
          : entry.name;
        collected.push(fileRelative);
      }
    }
  }
  recurse(coreRoot, "");
  collected.sort(compareBytewise);
  return collected;
}

function collectSrcRelativePaths(): {
  relativePath: string;
  absolutePath: string;
}[] {
  const srcRoot = resolve(import.meta.dirname, "../..");
  const collected: { relativePath: string; absolutePath: string }[] = [];
  function recurse(absoluteDir: string, relativeDir: string): void {
    for (const entry of readdirSync(absoluteDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const nextRelative = relativeDir
          ? `${relativeDir}/${entry.name}`
          : entry.name;
        recurse(join(absoluteDir, entry.name), nextRelative);
      } else if (
        entry.isFile() &&
        entry.name.endsWith(".ts") &&
        !entry.name.endsWith(".test.ts")
      ) {
        const fileRelative = relativeDir
          ? `${relativeDir}/${entry.name}`
          : entry.name;
        collected.push({
          relativePath: fileRelative,
          absolutePath: join(absoluteDir, entry.name),
        });
      }
    }
  }
  recurse(srcRoot, "");
  collected.sort((a, b) => compareBytewise(a.relativePath, b.relativePath));
  return collected;
}

function coreOffenders(): {
  node: string[];
  runtime: string[];
  vendor: string[];
} {
  const coreRoot = resolve(import.meta.dirname);
  const files = collectCoreRelativePaths();
  const node: string[] = [];
  const runtime: string[] = [];
  const vendor: string[] = [];
  for (const relativePath of files) {
    const absolute = join(coreRoot, relativePath);
    const content = readFileSync(absolute, "utf8");
    const specifiers = extractSpecifiers(content);
    for (const specifier of specifiers) {
      if (specifier.startsWith("node:")) {
        node.push(`${relativePath}: ${specifier}`);
      }
      if (specifier.includes("runtime/")) {
        runtime.push(`${relativePath}: ${specifier}`);
      }
      if (
        specifier === "@hono/node-server" ||
        specifier.startsWith("@hono/node-server/")
      ) {
        vendor.push(`${relativePath}: ${specifier}`);
      }
    }
  }
  return { node, runtime, vendor };
}

function srcRuntimeOffenders(): string[] {
  const files = collectSrcRelativePaths();
  const offenders: string[] = [];
  for (const { relativePath, absolutePath } of files) {
    if (relativePath === "main.ts") {
      continue;
    }
    const content = readFileSync(absolutePath, "utf8");
    const specifiers = extractSpecifiers(content);
    for (const specifier of specifiers) {
      if (specifier.includes("runtime/")) {
        offenders.push(`${relativePath}: ${specifier}`);
      }
    }
  }
  return offenders;
}

describe("src/http/server/core-purity.test", () => {
  it("the core imports no node: builtin", () => {
    const { node } = coreOffenders();
    assert.deepEqual(node, []);
  });

  it("the core reaches into no runtime root", () => {
    const { runtime } = coreOffenders();
    assert.deepEqual(runtime, []);
  });

  it("the core imports no runtime-only vendor package", () => {
    const { vendor } = coreOffenders();
    assert.deepEqual(vendor, []);
  });

  it("src/main.ts is the only production importer of the Node root", () => {
    const offenders = srcRuntimeOffenders();
    assert.deepEqual(offenders, []);
  });

  it("a single-line node: import is detected", () => {
    const specifiers = extractSpecifiers(
      `import { createServer } from "node:http";`,
    );
    assert.deepEqual(specifiers, ["node:http"]);
  });

  it("a multiline node: import is detected", () => {
    const specifiers = extractSpecifiers(
      `import {\n  createServer,\n} from "node:http";`,
    );
    assert.deepEqual(specifiers, ["node:http"]);
  });

  it("a node: re-export is detected", () => {
    const specifiers = extractSpecifiers(
      `export { createServer } from "node:http";`,
    );
    assert.deepEqual(specifiers, ["node:http"]);
  });

  it("a node: type import is detected", () => {
    const specifiers = extractSpecifiers(
      `import type { Server } from "node:http";`,
    );
    assert.deepEqual(specifiers, ["node:http"]);
  });

  it("a node: side-effect import is detected", () => {
    const specifiers = extractSpecifiers(`import "node:http";`);
    assert.deepEqual(specifiers, ["node:http"]);
  });

  it("a node: dynamic import is detected", () => {
    const specifiers = extractSpecifiers(`await import("node:http")`);
    assert.deepEqual(specifiers, ["node:http"]);
  });

  it("a single-quoted specifier is detected", () => {
    const specifiers = extractSpecifiers(
      `import { createServer } from 'node:http';`,
    );
    assert.deepEqual(specifiers, ["node:http"]);
  });

  it("a commented import is not detected", () => {
    const lineComment = extractSpecifiers(
      `// import { createServer } from "node:http";`,
    );
    assert.deepEqual(lineComment, []);
    const blockComment = extractSpecifiers(
      `/* import { createServer } from "node:http"; */`,
    );
    assert.deepEqual(blockComment, []);
  });

  it("an object property named node: is not detected", () => {
    const specifiers = extractSpecifiers(
      `const row = { node: parsed.data.node };`,
    );
    assert.deepEqual(specifiers, []);
  });

  it("a runtime reach is detected", () => {
    const specifiers = extractSpecifiers(
      `import { listen } from "./runtime/node/listen.ts";`,
    );
    const runtime = specifiers.filter((s) => s.includes("runtime/"));
    const node = specifiers.filter((s) => s.startsWith("node:"));
    assert.deepEqual(runtime, ["./runtime/node/listen.ts"]);
    assert.deepEqual(node, []);
  });

  it("the vendor package is detected", () => {
    const specifiers = extractSpecifiers(
      `import { serve } from "@hono/node-server";`,
    );
    const vendor = specifiers.filter(
      (s) => s === "@hono/node-server" || s.startsWith("@hono/node-server/"),
    );
    assert.deepEqual(vendor, ["@hono/node-server"]);
  });

  it("isExempt compares the whole path", () => {
    assert.equal(isExempt("runtime"), true);
    assert.equal(isExempt("node/runtime"), false);
    assert.equal(isExempt("runtime/node"), false);
    assert.equal(isExempt("event"), false);
  });

  it("the walk applies the exemption", () => {
    const files = collectCoreRelativePaths();
    assert.equal(files.includes("runtime/node/listen.ts"), false);
    assert.equal(files.includes("app.ts"), true);
    assert.equal(files.includes("idempotency-key.ts"), true);
    assert.equal(files.includes("node/create-node.ts"), true);
  });
});
