import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Command } from "commander";

import { registerClientOptions } from "../options.ts";
import type { CallResult } from "../client.ts";
import type { PlanDirectoryDependencies } from "./directory.ts";
import { registerPlanImport } from "./import.ts";

const ID = "project_01HZY8QF3M4N5P6R7S8T9V0W1X";
const CWD = "/tmp/cwd";
const REVISION_B = "revision_01HZY8QF3M4N5P6R7S8T9V0W1X";
const REVISION_C = "revision_01HZY8QF3M4N5P6R7S8T9V0W1Y";

const hash = (n: number): string =>
  `sha256:${"a".repeat(64 - n)}${"b".repeat(n)}`;

const REVISIONS: CallResult = {
  ok: true,
  status: 200,
  body: {
    revisions: [
      {
        id: REVISION_B,
        parentId: "revision_01HZY8QF3M4N5P6R7S8T9V0W1W",
        origin: "import",
        importId: "imp_01HZY8QF3M4N5P6R7S8T9V0W1W",
        submittedBlob: hash(0),
        choicesBlob: hash(1),
        acceptedBlob: hash(2),
      },
    ],
  },
};

const VALIDATE_DOCUMENTS = [
  {
    path: "plan/i--01/01-task-a--01drz3ndektsv4rrffq69g5fav.md",
    content: "the normalized task",
  },
  {
    path: "plan/i--01/objective-o--01drz3ndektsv4rrffq69g5fa1.md",
    content: "the normalized objective",
  },
];

const VALIDATE: CallResult = {
  ok: true,
  status: 200,
  body: {
    findings: [],
    documents: VALIDATE_DOCUMENTS,
    documentsHash: hash(3),
    revision: REVISION_B,
    choices: [],
  },
};

const IMPORT_RESPONSE: CallResult = {
  ok: true,
  status: 200,
  body: {
    revision: REVISION_C,
    documents: VALIDATE_DOCUMENTS,
    absent: [],
    completeness: [],
  },
};

const AUTHORED = { "plan/i--01/01-a.md": "authored plan" };

const harness = (
  options: {
    script?: readonly CallResult[];
    isTty?: boolean;
    promptAnswer?: string;
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
  exits(): readonly number[];
  promptCalls(): number;
} => {
  const program = new Command();
  registerClientOptions(program);
  const calls: Readonly<{
    operationId: string;
    body: unknown;
    parameters: Readonly<Record<string, string>> | undefined;
  }>[] = [];
  const queue = [...(options.script ?? [])];
  const client = {
    call: async (
      operationId: string,
      body: unknown,
      parameters?: Readonly<Record<string, string>>,
    ): Promise<CallResult> => {
      calls.push({ operationId, body, parameters });
      const next = queue.shift();
      if (next === undefined) {
        throw new Error(`unexpected call: ${operationId}`);
      }
      return next;
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
  let promptCalls = 0;
  const exitCalls: number[] = [];
  registerPlanImport({
    program,
    client,
    exit: (code: number) => {
      exitCalls.push(code);
    },
    confirm: {
      isTty: options.isTty ?? false,
      prompt: async (_question: string): Promise<string> => {
        promptCalls += 1;
        if (options.promptAnswer === "throw") {
          throw new Error("prompt must not be called");
        }
        return options.promptAnswer ?? "y";
      },
    },
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
    exits: () => exitCalls,
    promptCalls: () => promptCalls,
  };
};

const run = async (
  program: Command,
  args: readonly string[],
): Promise<void> => {
  await program.parseAsync([...args], { from: "user" });
};

describe("src/cli/plan/import.test", () => {
  it("plan.validate is called before plan.import, and the run records exactly three calls", async () => {
    const h = harness({
      script: [REVISIONS, VALIDATE, IMPORT_RESPONSE],
      initialFs: AUTHORED,
    });
    await run(h.program, ["plan", "import", "--project", ID]);

    assert.deepEqual(
      h.calls.map((call) => call.operationId),
      ["plan.revisions", "plan.validate", "plan.import"],
    );
    assert.equal(h.fails(), 0);
  });

  it("the import body carries validatedRevision, documentsHash and the validated documents, not the authored files", async () => {
    const h = harness({
      script: [REVISIONS, VALIDATE, IMPORT_RESPONSE],
      initialFs: AUTHORED,
    });
    await run(h.program, ["plan", "import", "--project", ID]);

    const importCall = h.calls[2];
    assert.ok(importCall !== undefined);
    assert.deepEqual(importCall.parameters, { id: ID });
    const body = importCall.body as Readonly<{
      validatedRevision: unknown;
      documentsHash: unknown;
      documents: unknown;
    }>;
    assert.equal(body.validatedRevision, REVISION_B);
    assert.equal(body.documentsHash, hash(3));
    assert.deepEqual(body.documents, VALIDATE_DOCUMENTS);
    assert.notDeepEqual(body.documents, [
      { path: "plan/i--01/01-a.md", content: "authored plan" },
    ]);
  });

  it("fromRevision equals the head of the revisions list and is null for an empty list", async () => {
    const h1 = harness({
      script: [REVISIONS, VALIDATE, IMPORT_RESPONSE],
      initialFs: AUTHORED,
    });
    await run(h1.program, ["plan", "import", "--project", ID]);
    const validate1 = h1.calls[1];
    assert.ok(validate1 !== undefined);
    assert.equal(
      (validate1.body as { fromRevision: unknown }).fromRevision,
      REVISION_B,
    );

    const empty = { ok: true as const, status: 200, body: { revisions: [] } };
    const h2 = harness({
      script: [empty, VALIDATE, IMPORT_RESPONSE],
      initialFs: AUTHORED,
    });
    await run(h2.program, ["plan", "import", "--project", ID]);
    const validate2 = h2.calls[1];
    assert.ok(validate2 !== undefined);
    assert.equal(
      (validate2.body as { fromRevision: unknown }).fromRevision,
      null,
    );
  });

  it("every suggestion is pre-selected: five entries with mixed suggestions yield choices bytewise ascending by id", async () => {
    const choice = (
      id: string,
      suggested: "submitted" | "database",
    ): unknown => ({
      id,
      kind: "task",
      presence: "both",
      state: "pending",
      suggested,
      fields: [],
      path: "plan/i--01/01-task-a--01drz3ndektsv4rrffq69g5fav.md",
      submitted: { legal: true, reason: null, values: {} },
      database: { legal: true, reason: null, values: {} },
    });
    const scripted = [
      choice("task_z", "database"),
      choice("task_a", "submitted"),
      choice("initiative_a", "database"),
      choice("objective_a", "submitted"),
      choice("task_b", "submitted"),
    ];
    const h = harness({
      script: [
        REVISIONS,
        {
          ok: true as const,
          status: 200,
          body: {
            ...(VALIDATE.body as Record<string, unknown>),
            choices: scripted,
          },
        },
        IMPORT_RESPONSE,
      ],
      initialFs: AUTHORED,
    });
    await run(h.program, ["plan", "import", "--project", ID]);

    const importCall = h.calls[2];
    assert.ok(importCall !== undefined);
    assert.deepEqual(
      (importCall.body as { choices: { id: string; take: string }[] }).choices,
      [
        { id: "initiative_a", take: "database" },
        { id: "objective_a", take: "submitted" },
        { id: "task_a", take: "submitted" },
        { id: "task_b", take: "submitted" },
        { id: "task_z", take: "database" },
      ],
    );
  });

  it("a finding stops the run: two findings print two plan-invalid lines, fail, and write nothing", async () => {
    const findings = [
      {
        code: "acceptance-missing",
        id: "task_01HZY8QF3M4N5P6R7S8T9V0W1X",
        path: "plan/i--01/01-a.md",
        message: "acceptance section missing",
      },
      {
        code: "identity-invalid",
        id: null,
        path: null,
        message: "id task_01H does not parse",
      },
    ];
    const initial = { "plan/i--01/01-a.md": "authored plan" };
    const h = harness({
      script: [
        REVISIONS,
        {
          ok: true as const,
          status: 200,
          body: { ...(VALIDATE.body as Record<string, unknown>), findings },
        },
      ],
      initialFs: initial,
    });
    await run(h.program, ["plan", "import", "--project", ID]);

    assert.deepEqual(
      h.calls.map((call) => call.operationId),
      ["plan.revisions", "plan.validate"],
    );
    assert.equal(h.fails(), 1);
    assert.equal(
      h.stderr(),
      "kanthord: plan-invalid: acceptance-missing plan/i--01/01-a.md acceptance section missing\n" +
        "kanthord: plan-invalid: identity-invalid - id task_01H does not parse\n",
    );
    assert.deepEqual(
      h.fs,
      new Map([[`${CWD}/plan/i--01/01-a.md`, "authored plan"]]),
    );
  });

  it("a non-interactive run asks nothing: with no TTY and no --yes the prompt is never called", async () => {
    const h = harness({
      script: [REVISIONS, VALIDATE, IMPORT_RESPONSE],
      initialFs: AUTHORED,
    });
    await run(h.program, ["plan", "import", "--project", ID]);

    assert.equal(h.promptCalls(), 0);
    assert.equal(h.fails(), 0);
    assert.deepEqual(
      h.calls.map((call) => call.operationId),
      ["plan.revisions", "plan.validate", "plan.import"],
    );
  });

  it("a non-interactive run still prints one choice line per suggestion, bytewise ascending by id", async () => {
    const choice = (
      id: string,
      suggested: "submitted" | "database",
    ): unknown => ({
      id,
      kind: "task",
      presence: "both",
      state: "pending",
      suggested,
      fields: [],
      path: "plan/i--01/01-task-a--01drz3ndektsv4rrffq69g5fav.md",
      submitted: { legal: true, reason: null, values: {} },
      database: { legal: true, reason: null, values: {} },
    });
    const h = harness({
      script: [
        REVISIONS,
        {
          ok: true as const,
          status: 200,
          body: {
            ...(VALIDATE.body as Record<string, unknown>),
            choices: [
              choice("task_b", "submitted"),
              choice("task_a", "database"),
            ],
          },
        },
        IMPORT_RESPONSE,
      ],
      initialFs: AUTHORED,
    });
    await run(h.program, ["plan", "import", "--project", ID]);

    assert.equal(h.promptCalls(), 0);
    assert.equal(h.fails(), 0);
    assert.equal(
      h
        .stdout()
        .startsWith(
          "kanthord: task_a -> database\nkanthord: task_b -> submitted\n",
        ),
      true,
    );
  });

  it("with a TTY and no --yes the prompt is called once; answering n cancels with no import", async () => {
    const h = harness({
      script: [REVISIONS, VALIDATE],
      isTty: true,
      promptAnswer: "n",
      initialFs: AUTHORED,
    });
    await run(h.program, ["plan", "import", "--project", ID]);

    assert.equal(h.promptCalls(), 1);
    assert.deepEqual(
      h.calls.map((call) => call.operationId),
      ["plan.revisions", "plan.validate"],
    );
    assert.equal(h.fails(), 1);
    assert.equal(h.stderr(), "kanthord: cancelled\n");
  });

  it("with --yes and a TTY the prompt is not called", async () => {
    const h = harness({
      script: [REVISIONS, VALIDATE, IMPORT_RESPONSE],
      isTty: true,
      promptAnswer: "throw",
      initialFs: AUTHORED,
    });
    await run(h.program, ["plan", "import", "--project", ID, "--yes"]);

    assert.equal(h.promptCalls(), 0);
    assert.equal(h.fails(), 0);
  });

  it("choices-stale exits non-zero and names the reason, writing no file", async () => {
    const initial = { "plan/i--01/01-a.md": "authored plan" };
    const h = harness({
      script: [
        REVISIONS,
        VALIDATE,
        {
          ok: false as const,
          status: 409,
          code: "choices-stale",
          message: `the choices were validated against ${REVISION_B}, the newest revision is ${REVISION_C}`,
          details: { conflicts: [{ id: "task_a" }] },
        },
      ],
      initialFs: initial,
    });
    await run(h.program, ["plan", "import", "--project", ID]);

    assert.deepEqual(h.exits(), [157]);
    assert.equal(
      h.stderr(),
      `kanthord: choices-stale: the choices were validated against ${REVISION_B}, the newest revision is ${REVISION_C}\n` +
        "kanthord: choices-stale: the plan moved since validation; export and retry\n",
    );
    assert.deepEqual(
      h.fs,
      new Map([[`${CWD}/plan/i--01/01-a.md`, "authored plan"]]),
    );
  });

  it("choices-changed names the ids from details", async () => {
    const h = harness({
      script: [
        REVISIONS,
        VALIDATE,
        {
          ok: false as const,
          status: 409,
          code: "choices-changed",
          message: "a selected outcome is no longer legal",
          details: {
            conflicts: [
              {
                id: "task_b",
                reason: "the node or a descendant holds a lease",
              },
              {
                id: "task_a",
                reason: "the node or a descendant holds a lease",
              },
            ],
          },
        },
      ],
      initialFs: AUTHORED,
    });
    await run(h.program, ["plan", "import", "--project", ID]);

    assert.deepEqual(h.exits(), [158]);
    assert.equal(
      h.stderr(),
      "kanthord: choices-changed: a selected outcome is no longer legal\n" +
        "kanthord: choices-changed: task_b,task_a\n",
    );
  });

  it("a 409 idempotency-mismatch exits 156 and a 409 stale-revision exits 150, per exitCodeForError", async () => {
    const h1 = harness({
      script: [
        REVISIONS,
        VALIDATE,
        {
          ok: false as const,
          status: 409,
          code: "idempotency-mismatch",
          message: "the choices differ from the committed import",
          details: { differed: "choices" },
        },
      ],
      initialFs: AUTHORED,
    });
    await run(h1.program, ["plan", "import", "--project", ID]);
    assert.deepEqual(h1.exits(), [156]);
    assert.equal(
      h1.stderr(),
      "kanthord: idempotency-mismatch: the choices differ from the committed import\n",
    );

    const h2 = harness({
      script: [
        REVISIONS,
        VALIDATE,
        {
          ok: false as const,
          status: 409,
          code: "stale-revision",
          message: `the import names ${REVISION_B}, the newest revision is ${REVISION_C}`,
          details: { current: REVISION_C },
        },
      ],
      initialFs: AUTHORED,
    });
    await run(h2.program, ["plan", "import", "--project", ID]);
    assert.deepEqual(h2.exits(), [150]);
    assert.equal(
      h2.stderr(),
      `kanthord: stale-revision: the import names ${REVISION_B}, the newest revision is ${REVISION_C}\n`,
    );
  });

  it("a daemon-error response at plan.revisions or plan.validate also exits through exitCodeForError", async () => {
    const revisionsFailed = harness({
      script: [
        {
          ok: false as const,
          status: 404,
          code: "not-found",
          message: "the project does not exist",
          details: null,
        },
      ],
      initialFs: AUTHORED,
    });
    await run(revisionsFailed.program, ["plan", "import", "--project", ID]);
    assert.deepEqual(revisionsFailed.exits(), [140]);
    assert.equal(
      revisionsFailed.stderr(),
      "kanthord: not-found: the project does not exist\n",
    );

    const validateFailed = harness({
      script: [
        REVISIONS,
        {
          ok: false as const,
          status: 409,
          code: "identity-kind-mismatch",
          message: "the identity names a different kind",
          details: null,
        },
      ],
      initialFs: AUTHORED,
    });
    await run(validateFailed.program, ["plan", "import", "--project", ID]);
    assert.deepEqual(validateFailed.exits(), [162]);
    assert.equal(
      validateFailed.stderr(),
      "kanthord: identity-kind-mismatch: the identity names a different kind\n",
    );
  });

  it("a malformed choices-changed details fails loudly instead of printing an empty id list", async () => {
    const h = harness({
      script: [
        REVISIONS,
        VALIDATE,
        {
          ok: false as const,
          status: 409,
          code: "choices-changed",
          message: "a selected outcome is no longer legal",
          details: { conflicts: [{ id: "task_a" }] },
        },
      ],
      initialFs: AUTHORED,
    });

    await assert.rejects(run(h.program, ["plan", "import", "--project", ID]));
  });

  it("the response replaces the directory: response documents written and the authored file removed", async () => {
    const h = harness({
      script: [REVISIONS, VALIDATE, IMPORT_RESPONSE],
      initialFs: { "plan/i--01/01-a.md": "authored plan" },
    });
    await run(h.program, ["plan", "import", "--project", ID]);

    assert.equal(h.fails(), 0);
    for (const document of VALIDATE_DOCUMENTS) {
      assert.equal(h.fs.get(`${CWD}/${document.path}`), document.content);
    }
    assert.ok(!h.fs.has(`${CWD}/plan/i--01/01-a.md`));
    assert.equal(
      h.stdout(),
      `kanthord: revision ${REVISION_C}\n` +
        `kanthord: wrote ${VALIDATE_DOCUMENTS.length} document\n` +
        "kanthord: removed 1 document\n" +
        "kanthord: absent <none>\n",
    );
  });

  it("absent is printed as the joined ids and as <none> for an empty array", async () => {
    const joined = harness({
      script: [
        REVISIONS,
        VALIDATE,
        {
          ok: true as const,
          status: 200,
          body: {
            revision: REVISION_C,
            documents: [],
            absent: ["task_a", "task_b"],
            completeness: [],
          },
        },
      ],
      initialFs: AUTHORED,
    });
    await run(joined.program, ["plan", "import", "--project", ID]);
    assert.equal(
      joined.stdout(),
      `kanthord: revision ${REVISION_C}\n` +
        "kanthord: wrote 0 document\n" +
        "kanthord: removed 1 document\n" +
        "kanthord: absent task_a,task_b\n",
    );

    const none = harness({
      script: [
        REVISIONS,
        VALIDATE,
        {
          ok: true as const,
          status: 200,
          body: {
            revision: REVISION_C,
            documents: [],
            absent: [],
            completeness: [],
          },
        },
      ],
      initialFs: AUTHORED,
    });
    await run(none.program, ["plan", "import", "--project", ID]);
    assert.equal(
      none.stdout(),
      `kanthord: revision ${REVISION_C}\n` +
        "kanthord: wrote 0 document\n" +
        "kanthord: removed 1 document\n" +
        "kanthord: absent <none>\n",
    );
  });

  it("an empty plan/ directory records zero calls", async () => {
    const h = harness({});
    await run(h.program, ["plan", "import", "--project", ID]);

    assert.equal(h.calls.length, 0);
    assert.equal(h.fails(), 1);
    assert.equal(
      h.stderr(),
      `kanthord: invalid-request: no plan document under ${CWD}/plan\n`,
    );
  });

  it("importId is a fresh imp_-prefixed value on each run", async () => {
    const runOnce = async (): Promise<string> => {
      const h = harness({
        script: [REVISIONS, VALIDATE, IMPORT_RESPONSE],
        initialFs: AUTHORED,
      });
      await run(h.program, ["plan", "import", "--project", ID]);
      const importCall = h.calls[2];
      assert.ok(importCall !== undefined);
      const value = (importCall.body as { importId?: string }).importId;
      assert.ok(value !== undefined);
      return value;
    };

    const first = await runOnce();
    const second = await runOnce();
    assert.match(first, /^imp_[0-9A-HJKMNP-TV-Z]{26}$/);
    assert.match(second, /^imp_[0-9A-HJKMNP-TV-Z]{26}$/);
    assert.notEqual(first, second);
  });

  it("two runs against the same queue and file system produce identical bodies apart from importId", async () => {
    const stripImportId = (body: unknown): unknown => {
      if (body === null || typeof body !== "object") {
        return body;
      }
      const record = { ...(body as Record<string, unknown>) };
      delete record.importId;
      return record;
    };
    const runOnce = async () => {
      const h = harness({
        script: [REVISIONS, VALIDATE, IMPORT_RESPONSE],
        initialFs: AUTHORED,
      });
      await run(h.program, ["plan", "import", "--project", ID]);
      return h;
    };

    const first = await runOnce();
    const second = await runOnce();

    assert.deepEqual(
      first.calls.map((call) => call.operationId),
      second.calls.map((call) => call.operationId),
    );
    assert.deepEqual(
      first.calls.map((call) => call.parameters),
      second.calls.map((call) => call.parameters),
    );
    assert.deepEqual(
      first.calls.map((call) => stripImportId(call.body)),
      second.calls.map((call) => stripImportId(call.body)),
    );
  });
});
