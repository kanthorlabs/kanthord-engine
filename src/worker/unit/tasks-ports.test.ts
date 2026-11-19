import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { background, CancellationContext } from "../../kernel/context.ts";
import { stopAfter, temporary } from "../../kernel/test-support.ts";
import { AssetKind, missionOperations } from "../../mission/contract.ts";
import type { HostInput } from "./chain-host.ts";
import { ExecutionRun } from "./execution-run.ts";
import type { EvidenceDraft } from "./foundry-ports.ts";
import type { MethodClients } from "./method-clients.ts";
import { localEvidencePort } from "./tasks-run.ts";
import { TasksOutput, UPLOADS_DIRECTORY } from "./tasks-output.ts";
import { workerPorts } from "./worker-ports.ts";

const REPORT = "coder report";
const DRAFT: EvidenceDraft = {
  subject: "coder-report",
  assets: [
    {
      kind: AssetKind.Produced,
      content: {
        media_type: "text/markdown",
        encoding: "base64",
        data: Buffer.from(REPORT, "utf8").toString("base64"),
      },
    },
  ],
};
const CLAIM = {
  execution_id: "execution_01ARZ3NDEKTSV4RRFFQ69G5FAA",
  node_id: "node_01ARZ3NDEKTSV4RRFFQ69G5FAA",
  attempt: 2,
  pinned_revision: 3,
  node_branch: "kanthord/node_01ARZ3NDEKTSV4RRFFQ69G5FAA",
  created_at: Date.now(),
  expired_at: Date.now() + 60000,
  trace_id: "trace",
  root_span_id: "1".repeat(16),
};

test("the CLI evidence port records the operation and the body that the worker evidence port sends", async (t) => {
  const sent: unknown[] = [];
  const run = new ExecutionRun({
    claim: CLAIM,
    clients: {
      mission: {
        "evidence.submit": async (input: { body: unknown }) => {
          sent.push(input.body);
          return {
            type: "completed",
            status: 200,
            data: { evidence: { id: "evidence_01ARZ3NDEKTSV4RRFFQ69G5FAA" } },
          };
        },
      },
    } as unknown as MethodClients,
    credentials: { release: async () => {} },
    context: background,
    secrets: async () => [],
  });
  stopAfter(t, () => run.dispose());
  const root = temporary(t);
  const worker = workerPorts(
    {
      claim: CLAIM,
      setup: { repositories: [] },
      workspaces: { nodeKey: () => root },
    } as unknown as HostInput,
    run,
  ).evidence;
  const output = TasksOutput.create(
    join(root, "out"),
    { credential: [], passed: [] },
    () => {},
  );
  const local = localEvidencePort(run, output);
  const cancel = new CancellationContext();
  for (const halt of [false, true]) {
    await worker.submit(DRAFT, cancel, { halt });
    await local.submit(DRAFT, cancel, { halt });
  }
  const recorded = output.outbox();
  assert.deepEqual(
    recorded.map((entry) => entry.operation),
    [
      missionOperations["evidence.submit"].id,
      missionOperations["evidence.submit"].id,
    ],
  );
  assert.deepEqual(
    recorded.map((entry) => entry.body),
    sent,
  );
  assert.deepEqual(
    JSON.parse(readFileSync(join(root, "out", "outbox.json"), "utf8")),
    JSON.parse(JSON.stringify(recorded)),
  );
  assert.equal(
    readFileSync(
      join(
        root,
        "out",
        UPLOADS_DIRECTORY,
        "evidence_00000000000000000000000001",
        "evidence_asset_00000000000000000000000001",
      ),
      "utf8",
    ),
    REPORT,
  );
});

test("the CLI evidence port redacts a known secret in the decoded base64 asset content before the outbox record", async (t) => {
  const secret = "canary-credential-value-0123456789";
  const run = new ExecutionRun({
    claim: CLAIM,
    clients: {} as MethodClients,
    credentials: { release: async () => {} },
    context: background,
    secrets: async () => [],
  });
  stopAfter(t, () => run.dispose());
  const root = temporary(t);
  const output = TasksOutput.create(
    join(root, "out"),
    { credential: [secret], passed: [] },
    () => {},
  );
  const draft: EvidenceDraft = {
    subject: "coder-report",
    assets: [
      {
        kind: AssetKind.Produced,
        content: {
          media_type: "text/markdown",
          encoding: "base64",
          data: Buffer.from(`report ${secret}`, "utf8").toString("base64"),
        },
      },
    ],
  };
  await localEvidencePort(run, output).submit(
    draft,
    new CancellationContext(),
    { halt: false },
  );
  const recorded = JSON.parse(
    readFileSync(join(root, "out", "outbox.json"), "utf8"),
  ) as { body: { assets: { content: { data: string } }[] } }[];
  const decoded = Buffer.from(
    recorded[0]!.body.assets[0]!.content.data,
    "base64",
  ).toString("utf8");
  assert.ok(decoded.startsWith("report "));
  assert.ok(!decoded.includes(secret));
  assert.ok(
    !JSON.stringify(output.outbox()).includes(
      Buffer.from(`report ${secret}`, "utf8").toString("base64"),
    ),
  );
});
