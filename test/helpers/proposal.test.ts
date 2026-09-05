import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { proposalStatements, readRouteMatrix } from "./proposal.ts";
import { KANTHORD_VERSION } from "../../src/domain/version.ts";
import {
  objectiveBusy,
  subtreeExclusion,
} from "../../src/domain/run-exclusion.ts";
import { claimRefusalCodes } from "../../src/commands/node/claim-node.ts";
import { runAuthorityRefusals } from "../../src/domain/run-authority.ts";

const tables = [
  "agent_invocation",
  "attempt",
  "blob",
  "candidate",
  "check_result",
  "edge",
  "event",
  "git_operation",
  "lease",
  "migration",
  "node",
  "plan_revision",
  "profile",
  "project",
  "project_binding",
  "provider",
  "repository",
  "run",
  "workspace",
];

const capabilityConsumerFiles = [
  "../../src/main.capability.test.ts",
  "../../src/queries/system/read-health.test.ts",
  "../../src/http/server/system/health.test.ts",
  "../../src/services/home-lock/startup.test.ts",
  "../../docs/proposal/api/system.md",
] as const;

const apiProposalPath = resolve(
  import.meta.dirname,
  "../../docs/proposal/api/README.md",
);

type CompatibilityRow = Readonly<{
  epic: string;
  retired: string;
  declared: string;
}>;

function compatibilityRows(document: string): readonly CompatibilityRow[] {
  const section =
    document.split(/^## Compatibility record$/m)[1]?.split(/^## /m)[0] ?? "";
  return [
    ...section.matchAll(
      /^\|\s*(EPIC \d+(?:\.\d+)?)\s*\|\s*.*?\s*\|\s*`([^`]+)`\s*\|\s*`([^`]+)`\s*\|$/gm,
    ),
  ].map((match) => ({
    epic: match[1]!,
    retired: match[2]!,
    declared: match[3]!,
  }));
}

describe("test/helpers/proposal.test", () => {
  it("blob yields one comment-free normalized statement", () => {
    assert.deepEqual(proposalStatements("blob"), [
      "CREATE TABLE blob ( hash TEXT PRIMARY KEY, size INTEGER NOT NULL, content BLOB NOT NULL, created_at INTEGER NOT NULL ) STRICT",
    ]);
  });

  it("run yields the table and the unique index as two statements in order", () => {
    assert.deepEqual(proposalStatements("run"), [
      "CREATE TABLE run ( id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('objective', 'task')), node_id TEXT NOT NULL REFERENCES node(id), parent_run_id TEXT REFERENCES run(id), driver TEXT NOT NULL CHECK (driver IN ('internal', 'external')), workspace_id TEXT REFERENCES workspace(id), worker TEXT, lease_fence INTEGER NOT NULL, attempt_limit INTEGER NOT NULL, base_oid TEXT, head_oid TEXT, state TEXT NOT NULL CHECK (state IN ('active', 'ended')), outcome TEXT, ended_at INTEGER, CHECK ((kind = 'objective') = (parent_run_id IS NULL)), CHECK ((driver = 'internal') = (workspace_id IS NOT NULL)), CHECK ((driver = 'internal') = (worker IS NOT NULL)), CHECK ((driver = 'internal') = (base_oid IS NOT NULL)), UNIQUE (id, driver) ) STRICT",
      "CREATE UNIQUE INDEX run_one_active ON run (node_id) WHERE state = 'active'",
    ]);
  });

  it("every table file yields exactly one statement except run, edge and node, all normalized and comment-free", () => {
    for (const table of tables) {
      const statements = proposalStatements(table);
      const expected =
        table === "run" ? 2 : table === "edge" ? 2 : table === "node" ? 2 : 1;
      assert.equal(statements.length, expected, table);
      for (const statement of statements) {
        assert.ok(statement.length > 0, table);
        assert.equal(statement, statement.replace(/\s+/g, " ").trim(), table);
        assert.ok(!statement.includes("--"), table);
      }
    }
  });

  it("throws a plain Error naming the file when no sql block exists", () => {
    assert.throws(
      () => proposalStatements("README"),
      (error: unknown) =>
        error instanceof Error && error.message === "no sql block in README.md",
    );
  });

  it("the phase-2 file table and the phase-2 directory agree", () => {
    const directory = resolve(
      import.meta.dirname,
      "../../docs/proposal/phase-2",
    );
    const readme = readFileSync(resolve(directory, "README.md"), "utf8");
    const filesSection = readme.split(/^## Files$/m)[1]?.split(/^## /m)[0];
    assert.ok(filesSection);
    const linkedFiles = [
      ...filesSection.matchAll(/^\| \[([^\]]+)\]\(([^)]+)\)/gm),
    ].map((match) => match[2]!);
    const actualFiles = readdirSync(directory)
      .filter((name) => name.endsWith(".md"))
      .filter((name) => name !== "README.md")
      .sort();

    assert.deepEqual(
      linkedFiles.map((file) => file.replace(/^.*\//, "")).sort(),
      actualFiles,
    );
    for (const file of linkedFiles) {
      assert.equal(existsSync(resolve(directory, file)), true, file);
    }
  });

  it("runs-and-exclusion.md declares no route table", () => {
    const phase2File = resolve(
      import.meta.dirname,
      "../../docs/proposal/phase-2/runs-and-exclusion.md",
    );
    const apiFile = resolve(
      import.meta.dirname,
      "../../docs/proposal/api/runs-and-exclusion.md",
    );

    assert.equal(existsSync(phase2File), true);
    assert.equal(existsSync(apiFile), false);
    assert.equal(
      readRouteMatrix().filter(
        (row) => row.status === "routed" || row.status === "stubbed",
      ).length,
      73,
    );
  });

  it("the run model document names both exclusion refusal codes", () => {
    const document = readFileSync(
      resolve(
        import.meta.dirname,
        "../../docs/proposal/phase-2/runs-and-exclusion.md",
      ),
      "utf8",
    );
    const now = 100;
    const subtree = subtreeExclusion({
      targetId: "node-target",
      ancestorIds: ["node-ancestor"],
      descendantIds: [],
      runs: [
        {
          runId: "run-ancestor",
          nodeId: "node-ancestor",
          state: "active",
          expiresAt: now + 1,
        },
      ],
      now,
    });
    const objective = objectiveBusy({
      objectiveId: "objective-1",
      siblingRuns: [
        {
          runId: "run-sibling",
          nodeId: "node-sibling",
          state: "active",
          expiresAt: now + 1,
        },
      ],
      now,
    });

    assert.equal(subtree?.refusal, "subtree-busy");
    assert.equal(objective?.refusal, "objective-busy");
    assert.ok(document.includes(subtree!.refusal));
    assert.ok(document.includes(objective!.refusal));
  });

  it("the run model document names every ordered claim refusal", () => {
    const document = readFileSync(
      resolve(
        import.meta.dirname,
        "../../docs/proposal/phase-2/runs-and-exclusion.md",
      ),
      "utf8",
    );

    assert.equal(claimRefusalCodes.length, 12);
    for (const refusal of claimRefusalCodes) {
      assert.ok(document.includes(refusal), refusal);
    }
  });

  it("the claim sections state the order and the one-path rule", () => {
    const document = readFileSync(
      resolve(
        import.meta.dirname,
        "../../docs/proposal/phase-2/runs-and-exclusion.md",
      ),
      "utf8",
    );

    assert.ok(document.includes("## The refusal order is fixed"));
    assert.ok(document.includes("## The claim has one path"));
    assert.ok(
      document.indexOf("node-not-found") <
        document.indexOf("ancestor-not-startable"),
    );
  });

  it("every remaining external-drive site names worker-model", () => {
    for (const file of capabilityConsumerFiles) {
      const source = readFileSync(resolve(import.meta.dirname, file), "utf8");
      assert.deepEqual(
        {
          namesDeclaredCapability: source.includes("worker-model"),
          namesRetiredCapability: source.includes("external-drive"),
        },
        {
          namesDeclaredCapability: true,
          namesRetiredCapability: false,
        },
        file,
      );
    }
  });

  it("the compatibility record names every change of this wire generation", () => {
    const rows = compatibilityRows(readFileSync(apiProposalPath, "utf8"));
    assert.deepEqual(rows, [
      {
        epic: "EPIC 050.1",
        retired: "external-drive",
        declared: "worker-model",
      },
      {
        epic: "EPIC 050.2",
        retired: "external-drive",
        declared: "worker-model",
      },
      {
        epic: "EPIC 050.2",
        retired: "external-drive",
        declared: "worker-model",
      },
    ]);
  });

  it("the versioning section carries the exception sentence", () => {
    const document = readFileSync(apiProposalPath, "utf8");
    const versioningSection =
      document.split(/^## Versioning$/m)[1]?.split(/^## /m)[0] ?? "";
    assert.equal(versioningSection.includes("closed by default"), true);
    assert.equal(
      versioningSection.includes("The list is closed. A change outside it is "),
      false,
    );
  });

  it("KANTHORD_VERSION is unchanged", () => {
    const manifest = JSON.parse(
      readFileSync(resolve(import.meta.dirname, "../../package.json"), "utf8"),
    ) as Readonly<{ version: string }>;
    assert.equal(KANTHORD_VERSION, "27.8.1");
    assert.equal(KANTHORD_VERSION, manifest.version);
  });

  it("the proposal states the five authority conditions", () => {
    const document = readFileSync(
      resolve(
        import.meta.dirname,
        "../../docs/proposal/phase-2/runs-and-exclusion.md",
      ),
      "utf8",
    );
    const authoritySection = document
      .split(/^## /m)
      .find(
        (section) =>
          section.split("\n", 1)[0]?.toLowerCase().includes("authority") ===
          true,
      );

    assert.ok(authoritySection, "authority section is missing");
    for (const condition of [
      "active",
      "unexpired",
      "caller",
      "target",
      "current fence",
    ]) {
      assert.ok(authoritySection.includes(condition), condition);
    }

    let previousPosition = -1;
    for (const refusal of runAuthorityRefusals) {
      const position = authoritySection.indexOf(refusal);
      assert.ok(position >= 0, refusal);
      assert.ok(position > previousPosition, refusal);
      previousPosition = position;
    }
  });

  it("the proposal states the renew formula and the lifetime boundary", () => {
    const document = readFileSync(
      resolve(
        import.meta.dirname,
        "../../docs/proposal/phase-2/runs-and-exclusion.md",
      ),
      "utf8",
    );

    assert.ok(document.includes("min(now + runTtlMs, max_lifetime_at)"));
    assert.ok(document.includes("now >= max_lifetime_at"));
  });

  it("the run authority section records renew, release and lease transition behavior", () => {
    const document = readFileSync(
      resolve(
        import.meta.dirname,
        "../../docs/proposal/phase-2/runs-and-exclusion.md",
      ),
      "utf8",
    );
    const authoritySection =
      document.split(/^## Run authority$/m)[1]?.split(/^## /m)[0] ?? "";

    for (const fragment of [
      "A renew never changes the fence.",
      "A release means that a worker voluntarily ends its run with no checkpoint. The node returns to `ready`, the open attempt is cancelled, the run ends and the fence rises.",
      "A transitional renew renews both leases until EPIC 050.4 Story 4 removes the node lease without changing wire shape.",
    ]) {
      assert.ok(authoritySection.includes(fragment), fragment);
    }
  });

  it("the proposal states one terminal event per run", () => {
    const document = readFileSync(
      resolve(
        import.meta.dirname,
        "../../docs/proposal/phase-2/runs-and-exclusion.md",
      ),
      "utf8",
    );

    assert.ok(document.includes("run.ended"));
    assert.ok(document.includes("run.expired"));
    assert.ok(document.includes("never both and never neither"));
  });

  it("the terminal-event rule leaves the report path outstanding for EPIC 050.4 Story 6", () => {
    const document = readFileSync(
      resolve(
        import.meta.dirname,
        "../../docs/proposal/phase-2/runs-and-exclusion.md",
      ),
      "utf8",
    );
    const terminalEventSentence = document
      .split("\n")
      .find((line) => line.startsWith("The expiry pass and release paths"));

    assert.equal(
      terminalEventSentence,
      "The expiry pass and release paths append exactly one of `run.ended` or `run.expired`, never both and never neither, in the same transaction as the transition and the fence raise. The report path remains outstanding for EPIC 050.4 Story 6.",
    );
    assert.equal(terminalEventSentence?.includes("report path"), true);
    assert.equal(terminalEventSentence?.includes("outstanding"), true);
    assert.equal(terminalEventSentence?.includes("EPIC 050.4 Story 6"), true);
  });
});
