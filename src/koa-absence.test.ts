import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";

import { compareBytewise } from "./http/server/bytewise.ts";

const repositoryRoot = resolve(import.meta.dirname, "..");
const walkedRoots = ["src", "test", "scripts"] as const;
const ownPath = relative(
  repositoryRoot,
  resolve(import.meta.dirname, "koa-absence.test.ts"),
).replaceAll("\\", "/");

function repositoryFiles(): readonly string[] {
  const files: string[] = [];
  const walk = (relativeDirectoryPath: string): void => {
    const directory = resolve(repositoryRoot, relativeDirectoryPath);
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relativePath = `${relativeDirectoryPath}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(relativePath);
      } else if (entry.isFile() && relativePath !== ownPath) {
        files.push(relativePath);
      }
    }
  };

  for (const root of walkedRoots) {
    walk(root);
  }
  return files.sort(compareBytewise);
}

function offendersFor(relativePath: string, source: string): readonly string[] {
  return source
    .split("\n")
    .flatMap((line, index) =>
      /koa/i.test(line) ? [`${relativePath}:${index + 1}`] : [],
    );
}

function repositoryOffenders(): readonly string[] {
  return repositoryFiles().flatMap((relativePath) =>
    offendersFor(
      relativePath,
      readFileSync(resolve(repositoryRoot, relativePath), "utf8"),
    ),
  );
}

describe("src/koa-absence.test", () => {
  it("no file under src, test or scripts names koa", () => {
    assert.deepEqual(repositoryOffenders(), []);
  });

  it("a koa import is detected", () => {
    assert.deepEqual(offendersFor("fixture.ts", 'import Koa from "koa";'), [
      "fixture.ts:1",
    ]);
  });

  it("the case-insensitive form is detected", () => {
    assert.deepEqual(
      offendersFor(
        "fixture.ts",
        ["const app = createApp();", "const bridge = koaFromHono(app);"].join(
          "\n",
        ),
      ),
      ["fixture.ts:2"],
    );
  });

  it("the test excludes itself", () => {
    const files = repositoryFiles();
    assert.equal(files.includes("src/koa-absence.test.ts"), false);
    assert.equal(files.includes("src/main.ts"), true);
  });

  it("the three roots are walked", () => {
    const files = repositoryFiles();
    assert.equal(files.includes("src/main.ts"), true);
    assert.equal(files.includes("test/helpers/agent.ts"), true);
    assert.equal(files.includes("scripts/lane-check.sh"), true);
  });
});
