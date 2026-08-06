import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { PlanDirectoryDependencies } from "./directory.ts";
import { readPlanDirectory, writePlanDirectory } from "./directory.ts";

const ROOT = "/tmp/plan-root";

const makeFs = (
  initial: Readonly<Record<string, string>>,
): {
  files: Map<string, string>;
  log: readonly string[];
  deps: PlanDirectoryDependencies;
} => {
  const files = new Map<string, string>();
  for (const [path, content] of Object.entries(initial)) {
    files.set(`${ROOT}/${path}`, content);
  }
  const log: string[] = [];
  const readDirectory = (path: string): readonly string[] => {
    log.push(`readDirectory ${path}`);
    const prefix = path.endsWith("/") ? path : `${path}/`;
    const names = new Map<string, boolean>();
    for (const key of files.keys()) {
      if (!key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      if (rest.length === 0) continue;
      const slash = rest.indexOf("/");
      const name = slash === -1 ? rest : rest.slice(0, slash);
      names.set(name, slash !== -1 || (names.get(name) ?? false));
    }
    if (names.size === 0) {
      throw Object.assign(
        new Error(`ENOENT: no such file or directory, scandir '${path}'`),
        { code: "ENOENT" },
      );
    }
    return [...names.entries()].map(([name, isDirectory]) =>
      isDirectory ? `${name}/` : name,
    );
  };
  const readFile = (path: string): string => {
    log.push(`readFile ${path}`);
    const content = files.get(path);
    if (content === undefined) {
      throw new Error(`ENOENT: no such file or directory, open '${path}'`);
    }
    return content;
  };
  const writeFile = (path: string, content: string): void => {
    log.push(`writeFile ${path}`);
    files.set(path, content);
  };
  const makeDirectory = (path: string): void => {
    log.push(`makeDirectory ${path}`);
  };
  const removeFile = (path: string): void => {
    log.push(`removeFile ${path}`);
    files.delete(path);
  };
  return {
    files,
    log,
    deps: { readDirectory, readFile, writeFile, makeDirectory, removeFile },
  };
};

describe("src/cli/plan/directory.test", () => {
  it("a three-file tree returns three entries with POSIX paths beginning plan/, sorted with comparePaths", () => {
    const fs = makeFs({
      "plan/c.md": "c",
      "plan/a.md": "a",
      "plan/b.md": "b",
    });

    const entries = readPlanDirectory(fs.deps, ROOT);

    assert.deepEqual(
      entries.map((entry) => entry.path),
      ["plan/a.md", "plan/b.md", "plan/c.md"],
    );
    assert.deepEqual(
      entries.map((entry) => entry.content),
      ["a", "b", "c"],
    );
  });

  it("walks nested directories and sorts bytewise so a --01 directory precedes a.md", () => {
    const fs = makeFs({
      "plan/z.md": "z",
      "plan/a--01/01.md": "one",
      "plan/a--01/initiative.md": "init",
      "plan/a.md": "a",
      "plan/a--01/o--02/01-task.md": "task",
    });

    const entries = readPlanDirectory(fs.deps, ROOT);

    assert.deepEqual(
      entries.map((entry) => entry.path),
      [
        "plan/a--01/01.md",
        "plan/a--01/initiative.md",
        "plan/a--01/o--02/01-task.md",
        "plan/a.md",
        "plan/z.md",
      ],
    );
  });

  it("a file outside plan/ is not returned and a .txt inside plan/ is not returned", () => {
    const fs = makeFs({
      "planning.md": "outside the root",
      "docs/plan/x.md": "a plan-named path outside root/plan",
      "plan/a.md": "a",
      "plan/README.txt": "notes",
    });

    const entries = readPlanDirectory(fs.deps, ROOT);

    assert.deepEqual(
      entries.map((entry) => entry.path),
      ["plan/a.md"],
    );
  });

  it("an absent plan/ directory returns []", () => {
    const fs = makeFs({ "README.md": "no plan directory" });

    assert.deepEqual(readPlanDirectory(fs.deps, ROOT), []);
  });

  it("a non-absent directory read error surfaces instead of an empty plan", () => {
    const permissionError = Object.assign(
      new Error(`EACCES: permission denied, scandir '${ROOT}/plan'`),
      { code: "EACCES" },
    );
    const deps: PlanDirectoryDependencies = {
      readDirectory: (path: string): readonly string[] => {
        throw permissionError;
      },
      readFile: (path: string): string => path,
      writeFile: (): void => {},
      makeDirectory: (): void => {},
      removeFile: (): void => {},
    };

    assert.throws(
      () => readPlanDirectory(deps, ROOT),
      (error: unknown) => error === permissionError,
    );
  });

  it("writes every document and creates each parent directory before its file", () => {
    const fs = makeFs({});

    const removed = writePlanDirectory(fs.deps, {
      root: ROOT,
      documents: [
        { path: "plan/a--01/initiative.md", content: "init" },
        { path: "plan/a--01/01-task.md", content: "task" },
      ],
    });

    assert.deepEqual(removed, []);
    assert.equal(fs.files.get(`${ROOT}/plan/a--01/initiative.md`), "init");
    assert.equal(fs.files.get(`${ROOT}/plan/a--01/01-task.md`), "task");
    const log = [...fs.log];
    const make = log.indexOf("makeDirectory /tmp/plan-root/plan/a--01");
    const writeInit = log.indexOf(
      "writeFile /tmp/plan-root/plan/a--01/initiative.md",
    );
    const writeTask = log.indexOf(
      "writeFile /tmp/plan-root/plan/a--01/01-task.md",
    );
    assert.ok(make !== -1 && writeInit !== -1 && writeTask !== -1);
    assert.ok(
      make < writeInit,
      "the parent directory is created before the file",
    );
    assert.ok(make < writeTask);
  });

  it("orphan removal: a human-named file the response does not name is removed and named in the removed list", () => {
    const fs = makeFs({
      "plan/a--01/initiative.md": "stored",
      "plan/my-notes.md": "human notes",
    });

    const removed = writePlanDirectory(fs.deps, {
      root: ROOT,
      documents: [{ path: "plan/a--01/initiative.md", content: "stored" }],
    });

    assert.deepEqual(removed, ["plan/my-notes.md"]);
    assert.equal(fs.files.get(`${ROOT}/plan/a--01/initiative.md`), "stored");
    assert.ok(!fs.files.has(`${ROOT}/plan/my-notes.md`));
  });

  it("a .gitignore and a plan/README.txt are not removed", () => {
    const fs = makeFs({
      "plan/.gitignore": "*.log",
      "plan/README.txt": "notes",
      "plan/a.md": "a",
    });

    const removed = writePlanDirectory(fs.deps, {
      root: ROOT,
      documents: [{ path: "plan/a.md", content: "a" }],
    });

    assert.deepEqual(removed, []);
    assert.ok(fs.files.has(`${ROOT}/plan/.gitignore`));
    assert.ok(fs.files.has(`${ROOT}/plan/README.txt`));
  });

  it("no directory is removed: every removal targets a .md file", () => {
    const fs = makeFs({
      "plan/a--01/initiative.md": "init",
      "plan/a--01/o--02/01-task.md": "task",
    });

    const removed = writePlanDirectory(fs.deps, {
      root: ROOT,
      documents: [{ path: "plan/a--01/initiative.md", content: "init" }],
    });

    assert.deepEqual(removed, ["plan/a--01/o--02/01-task.md"]);
    for (const entry of fs.log) {
      assert.ok(
        !entry.startsWith("removeFile ") || entry.endsWith(".md"),
        `removed a non-markdown path: ${entry}`,
      );
    }
  });

  it("a response document at a new nested path creates both parent directories", () => {
    const fs = makeFs({});

    writePlanDirectory(fs.deps, {
      root: ROOT,
      documents: [{ path: "plan/a--01/o--02/01-task.md", content: "task" }],
    });

    assert.equal(fs.files.get(`${ROOT}/plan/a--01/o--02/01-task.md`), "task");
    const log = [...fs.log];
    const first = log.indexOf("makeDirectory /tmp/plan-root/plan/a--01");
    const second = log.indexOf("makeDirectory /tmp/plan-root/plan/a--01/o--02");
    const write = log.indexOf(
      "writeFile /tmp/plan-root/plan/a--01/o--02/01-task.md",
    );
    assert.ok(first !== -1 && second !== -1 && write !== -1);
    assert.ok(first < second && second < write);
  });

  it("writing the same document set twice removes nothing on the second run", () => {
    const fs = makeFs({ "plan/my-notes.md": "human notes" });
    const documents = [{ path: "plan/a--01/initiative.md", content: "init" }];

    const first = writePlanDirectory(fs.deps, { root: ROOT, documents });
    assert.deepEqual(first, ["plan/my-notes.md"]);
    const logLength = fs.log.length;

    const second = writePlanDirectory(fs.deps, { root: ROOT, documents });
    assert.deepEqual(second, []);
    const secondRun = fs.log.slice(logLength);
    assert.ok(
      secondRun.every((entry) => !entry.startsWith("removeFile")),
      "the second run removed nothing",
    );
  });
});
