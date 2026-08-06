import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Command } from "commander";

import { registerClientOptions } from "../options.ts";
import type { CallResult } from "../client.ts";
import type { PlanDirectoryDependencies } from "./directory.ts";
import { registerPlanExport } from "./export.ts";

const ID = "project_01HZY8QF3M4N5P6R7S8T9V0W1X";
const CWD = "/tmp/cwd";
const REVISION = "revision_01HZY8QF3M4N5P6R7S8T9V0W1X";

const DOCUMENTS = [
  {
    path: "plan/i--01/01-task-a--01drz3ndektsv4rrffq69g5fav.md",
    content: "the normalized task",
  },
  {
    path: "plan/i--01/objective-o--01drz3ndektsv4rrffq69g5fa1.md",
    content: "the normalized objective",
  },
];

const harness = (
  options: {
    respond?: (operationId: string, body: unknown) => CallResult;
    initialFs?: Readonly<Record<string, string>>;
  } = {},
): {
  program: Command;
  calls: readonly Readonly<{
    operationId: string;
    body: unknown;
    parameters: Readonly<Record<string, string>> | undefined;
  }>[];
  fs: Map<string, string>;
  stdout(): string;
  stderr(): string;
  fails(): number;
} => {
  const program = new Command();
  registerClientOptions(program);
  const calls: Readonly<{
    operationId: string;
    body: unknown;
    parameters: Readonly<Record<string, string>> | undefined;
  }>[] = [];
  const client = {
    call: async (
      operationId: string,
      body: unknown,
      parameters?: Readonly<Record<string, string>>,
    ): Promise<CallResult> => {
      calls.push({ operationId, body, parameters });
      if (options.respond !== undefined) {
        return options.respond(operationId, body);
      }
      return {
        ok: true as const,
        status: 200,
        body: { revision: REVISION, documents: DOCUMENTS },
      };
    },
  };
  const files = new Map<string, string>();
  for (const [path, content] of Object.entries(options.initialFs ?? {})) {
    files.set(`${CWD}/${path}`, content);
  }
  const fs: PlanDirectoryDependencies = {
    readDirectory: (path) => {
      const prefix = path.endsWith("/") ? path : `${path}/`;
      const names = new Set<string>();
      let found = false;
      for (const key of files.keys()) {
        if (!key.startsWith(prefix)) continue;
        found = true;
        const rest = key.slice(prefix.length);
        const slash = rest.indexOf("/");
        names.add(slash === -1 ? rest : `${rest.slice(0, slash)}/`);
      }
      if (!found) {
        throw Object.assign(
          new Error(`ENOENT: no such file or directory, open '${path}'`),
          { code: "ENOENT" },
        );
      }
      return [...names];
    },
    readFile: (path) => {
      const content = files.get(path);
      if (content === undefined) {
        throw Object.assign(
          new Error(`ENOENT: no such file or directory, open '${path}'`),
          { code: "ENOENT" },
        );
      }
      return content;
    },
    writeFile: (path, content) => {
      files.set(path, content);
    },
    makeDirectory: () => {},
    removeFile: (path) => {
      files.delete(path);
    },
  };
  let stdoutText = "";
  let stderrText = "";
  let failCalls = 0;
  registerPlanExport({
    program,
    client,
    cwd: CWD,
    fs,
    stdout: (text) => {
      stdoutText += text;
    },
    stderr: (text) => {
      stderrText += text;
    },
    fail: () => {
      failCalls += 1;
    },
  });
  return {
    program,
    calls,
    fs: files,
    stdout: () => stdoutText,
    stderr: () => stderrText,
    fails: () => failCalls,
  };
};

const run = async (
  program: Command,
  args: readonly string[],
): Promise<void> => {
  await program.parseAsync([...args], { from: "user" });
};

describe("src/cli/plan/export.test", () => {
  it("a successful export records exactly one call, writes every document, and prints the three lines", async () => {
    const h = harness();
    await run(h.program, ["plan", "export", "--project", ID]);

    assert.deepEqual(h.calls, [
      { operationId: "plan.export", body: undefined, parameters: { id: ID } },
    ]);
    for (const document of DOCUMENTS) {
      assert.equal(h.fs.get(`${CWD}/${document.path}`), document.content);
    }
    assert.equal(
      h.stdout(),
      `kanthord: revision ${REVISION}\n` +
        `kanthord: wrote ${DOCUMENTS.length} document\n` +
        "kanthord: removed 0 document\n",
    );
    assert.equal(h.stderr(), "");
    assert.equal(h.fails(), 0);
  });

  it("a revision: null response prints revision <none> and wrote 0 document", async () => {
    const h = harness({
      respond: () => ({
        ok: true as const,
        status: 200,
        body: { revision: null, documents: [] },
      }),
    });
    await run(h.program, ["plan", "export", "--project", ID]);

    assert.equal(
      h.stdout(),
      "kanthord: revision <none>\n" +
        "kanthord: wrote 0 document\n" +
        "kanthord: removed 0 document\n",
    );
    assert.equal(h.stderr(), "");
    assert.equal(h.fails(), 0);
  });

  it("a 404 prints the not-found line and calls fail, leaving the file system map unchanged", async () => {
    const h = harness({
      respond: () => ({
        ok: false as const,
        status: 404,
        code: "not-found",
        message: `no project ${ID}`,
        details: undefined,
      }),
      initialFs: { "plan/a.md": "unchanged" },
    });
    await run(h.program, ["plan", "export", "--project", ID]);

    assert.equal(h.fails(), 1);
    assert.equal(h.stderr(), `kanthord: not-found: no project ${ID}\n`);
    assert.equal(h.stdout(), "");
    assert.deepEqual(h.fs, new Map([[`${CWD}/plan/a.md`, "unchanged"]]));
  });

  it("no --project prints the invalid-request line and records zero calls", async () => {
    const h = harness();
    await run(h.program, ["plan", "export"]);

    assert.equal(h.fails(), 1);
    assert.equal(h.calls.length, 0);
    assert.equal(
      h.stderr(),
      "kanthord: invalid-request: --project is required\n",
    );
    assert.equal(h.stdout(), "");
  });
});
