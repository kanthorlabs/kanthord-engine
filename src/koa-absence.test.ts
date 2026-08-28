import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { compareBytewise } from "./http/server/bytewise.ts";

function collectRepoRelativePaths(): string[] {
  const repoRoot = resolve(import.meta.dirname, "..");
  const roots = ["src", "test", "scripts"] as const;
  const collected: string[] = [];
  for (const root of roots) {
    const absoluteRoot = join(repoRoot, root);
    function recurse(absoluteDir: string, relativeDir: string): void {
      for (const entry of readdirSync(absoluteDir, { withFileTypes: true })) {
        const absolutePath = join(absoluteDir, entry.name);
        const relativePath = `${relativeDir}/${entry.name}`;
        if (entry.isDirectory()) {
          recurse(absolutePath, relativePath);
        } else if (entry.isFile()) {
          collected.push(relativePath);
        }
      }
    }
    recurse(absoluteRoot, root);
  }
  const filtered = collected.filter(
    (path) => path !== "src/koa-absence.test.ts",
  );
  filtered.sort(compareBytewise);
  return filtered;
}

function collectOffenders(): string[] {
  const repoRoot = resolve(import.meta.dirname, "..");
  const paths = collectRepoRelativePaths();
  const offenders: string[] = [];
  for (const relativePath of paths) {
    const absolutePath = join(repoRoot, relativePath);
    const content = readFileSync(absolutePath, "utf8");
    const lines = content.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] as string;
      if (/koa/i.test(line)) {
        offenders.push(`${relativePath}:${index + 1}`);
      }
    }
  }
  return offenders;
}

function koaLineNumbers(content: string): number[] {
  const lines = content.split("\n");
  const result: number[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] as string;
    if (/koa/i.test(line)) {
      result.push(index + 1);
    }
  }
  return result;
}

describe("src/koa-absence.test", () => {
  it("no file under src, test or scripts names koa", () => {
    const offenders = collectOffenders();
    assert.deepEqual(offenders, []);
  });

  it("a koa import is detected", () => {
    const content = `import Koa from "koa";`;
    const lines = koaLineNumbers(content);
    assert.deepEqual(lines, [1]);
  });

  it("the case-insensitive form is detected", () => {
    const content = `import { Hono } from "hono";\nconst bridge = koaFromHono(app);`;
    const lines = koaLineNumbers(content);
    assert.deepEqual(lines, [2]);
  });

  it("the test excludes itself", () => {
    const paths = collectRepoRelativePaths();
    assert.equal(paths.includes("src/koa-absence.test.ts"), false);
    assert.equal(paths.includes("src/main.ts"), true);
  });

  it("the three roots are walked", () => {
    const paths = collectRepoRelativePaths();
    assert.equal(paths.includes("src/main.ts"), true);
    assert.equal(paths.includes("test/helpers/agent.ts"), true);
    assert.equal(paths.includes("scripts/lane-check.sh"), true);
  });
});
