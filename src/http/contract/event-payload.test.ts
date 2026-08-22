import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { eventTypes, retiredEventTypes } from "../../domain/event-type.ts";
import { eventPayloads } from "./event-payload.ts";
import { eventView } from "./event.ts";
import { buildOpenApiDocument } from "./openapi.ts";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const grammar = /^[a-z][a-zA-Z]*(\.[a-z][a-zA-Z]*)+$/;

const H40 = "0123456789abcdef0123456789abcdef01234567";

const nonEventLiterals = [
  "config.json",
  "config.lock",
  "daemon.lock.db",
  "daemon.lock.identity",
  "gc.pid",
  "http.allowedHosts",
  "http.allowedOrigins",
  "http.bind",
  "http.event.maxWait",
  "http.idempotency.joinTimeout",
  "http.idempotency.maxBytes",
  "http.idempotency.maxEntries",
  "http.idempotency.ttl",
  "http.port",
  "http.token",
  "http.tokenFile",
  "index.lock",
  "kanthord.config.json",
  "remote.origin.fetch",
  "shallow.lock",
  "tools.git",
  "tools.ssh",
  "tools.sshKeyscan",
] as const;

const recordedPayloads: Readonly<Record<string, readonly unknown[]>> = {
  "actor.registered": [
    {
      actorId: "actor_1",
      kind: "harness",
      name: "harness-one",
      registeredBy: "actor_0",
    },
  ],
  "actor.revoked": [
    {
      actorId: "actor_1",
      kind: "harness",
      name: "harness-one",
      revokedBy: "actor_0",
      revokedAt: 1234,
      leasesFenced: 2,
    },
  ],
  "actor.tokenRotated": [
    {
      actorId: "actor_1",
      kind: "harness",
      name: "harness-one",
      rotatedBy: "actor_0",
      rotatedAt: 1234,
    },
  ],
  "lease.claimed": [
    {
      subjectId: "task_1",
      objectiveId: "objective_1",
      fence: 1,
      objectiveFence: 2,
      expiresAt: 1234,
      runId: "run_1",
      objectiveRunId: "run_2",
      attemptId: "attempt_1",
      attemptNo: 1,
    },
  ],
  "lease.released": [
    { subjectId: "task_1", objectiveId: "objective_1", fence: 1 },
  ],
  "lease.renewed": [
    {
      subjectId: "task_1",
      objectiveId: "objective_1",
      fence: 1,
      objectiveFence: 2,
      expiresAt: 1234,
      objectiveExpiresAt: 2345,
    },
  ],
  "node.awaitingApproval": [
    {
      from: "running",
      to: "awaiting_approval",
      reason: "object-attested",
      objectId: H40,
      projection: "done",
      objectiveRunId: "run_2",
    },
  ],
  "node.created": [
    { kind: "task", parentId: "objective_1", revision: "rev_1" },
  ],
  "node.deleted": [
    { kind: "task", parentId: "objective_1", revision: "rev_2" },
  ],
  "node.discarded": [
    {
      from: "running",
      to: "discarded",
      reason: "objectives-terminal",
      objectiveStates: ["discarded"],
    },
  ],
  "node.done": [
    {
      from: "awaiting_approval",
      to: "done",
      reason: "human-close",
      objectId: H40,
      objectiveRunId: "run_2",
      acknowledgePartial: false,
    },
    {
      from: "running",
      to: "done",
      reason: "objectives-terminal",
      objectiveStates: ["done"],
    },
  ],
  "node.imported": [{ revision: "rev_1", source: "submitted" }],
  "node.partial": [
    {
      from: "awaiting_approval",
      to: "partial",
      reason: "human-close",
      objectId: H40,
      objectiveRunId: "run_2",
      acknowledgePartial: true,
    },
    {
      from: "running",
      to: "partial",
      reason: "objectives-terminal",
      objectiveStates: ["done", "partial"],
    },
  ],
  "node.pending": [
    {
      from: "running",
      to: "pending",
      reason: "dependency-unsatisfied",
      revision: "rev_1",
      importId: null,
    },
  ],
  "node.ready": [
    {
      from: "pending",
      to: "ready",
      reason: "dependency-satisfied",
      revision: "rev_1",
      importId: null,
    },
  ],
  "node.running": [
    {
      from: "ready",
      to: "running",
      reason: "claim-taken",
      revision: "rev_1",
      importId: null,
    },
  ],
  "node.unblocked": [
    { from: "blocked", to: "pending", clearedReason: "attempt-limit" },
  ],
  "node.updated": [{ fields: ["title"], revision: "rev_2" }],
  "outcome.reported": [
    {
      runId: "run_1",
      attemptId: "attempt_1",
      attemptNo: 1,
      outcome: "rejected",
      reason: "merge conflict",
      objectId: null,
      attemptsRemaining: 2,
      fromState: "running",
      toState: "ready",
    },
  ],
  "plan.imported": [
    { revision: "rev_1", importId: "import_1", nodes: 3, absent: [] },
  ],
  "project.created": [{ name: "project-one" }],
  "project.repositoriesReplaced": [{ repositories: ["origin"] }],
  "provider.defaultSet": [{ name: "primary", kind: "git", setDefaultAt: 1234 }],
  "provider.defaultUnset": [{ name: "primary", kind: "llm", unsetAt: 1234 }],
  "provider.registered": [{ name: "primary", kind: "git" }],
  "provider.removed": [{ name: "primary", kind: "git" }],
  "provider.renamed": [{ from: "primary", to: "secondary" }],
  "recovery.childReaped": [
    {
      gitOperationId: "gitop_1",
      pidFile: "gitop-gitop_1.pid",
      finding: "process-absent",
    },
  ],
  "recovery.journalReconciled": [
    {
      gitOperationId: "gitop_1",
      intent: "publish",
      ref: "refs/heads/main",
      observed: H40,
      verdict: "complete",
    },
  ],
  "recovery.leaseBlocked": [
    { target: "blocked", clean: false, headOid: null, baseOid: H40, fence: 1 },
  ],
  "recovery.leaseRecovered": [
    {
      target: "ready",
      clean: false,
      headOid: null,
      baseOid: H40,
      fence: 1,
      driver: "external",
      runId: "run_1",
    },
    {
      target: "ready",
      clean: false,
      headOid: null,
      baseOid: H40,
      fence: 1,
    },
  ],
  "recovery.publishReconcilePending": [
    { gitOperationId: "gitop_1", ref: "refs/heads/main", proposedHeadOid: H40 },
  ],
  "recovery.remnantRefused": [
    {
      path: "/tmp/remnant",
      class: "lock",
      reason: "outside-boundary",
    },
  ],
  "recovery.remnantRemoved": [{ path: "/tmp/remnant", class: "lock" }],
  "repository.outsideWriter": [
    {
      ref: "refs/heads/main",
      intent: "publish",
      expectedOid: H40,
      observedOid: H40,
    },
  ],
  "repository.register.credentialRejected": [
    {
      failure: "auth-failed",
      name: "origin",
      publishRef: "refs/heads/main",
      credentialId: "credential_1",
    },
  ],
  "repository.registered": [
    {
      name: "origin",
      upstreamBranch: "main",
      landingBranch: "main",
      publishRef: "refs/heads/main",
      publishOnApproval: true,
      credentialId: "credential_1",
      fetchedUpstreamOid: H40,
      landingOid: H40,
    },
  ],
};

type ScanResult = Readonly<{ files: string[]; literals: Set<string> }>;

function scanEventTypeLiterals(directory: string): ScanResult {
  const files: string[] = [];
  const literals = new Set<string>();
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (
        entry.isFile() &&
        entry.name.endsWith(".ts") &&
        !entry.name.endsWith(".test.ts")
      ) {
        files.push(full);
        const content = readFileSync(full, "utf8");
        for (const match of content.matchAll(/"([^"\n]+)"/g)) {
          const candidate = match[1];
          if (candidate !== undefined && grammar.test(candidate)) {
            literals.add(candidate);
          }
        }
      }
    }
  };
  walk(directory);
  return { files, literals };
}

function scanProducers(): ScanResult {
  const commands = scanEventTypeLiterals(join(repositoryRoot, "src/commands"));
  const services = scanEventTypeLiterals(join(repositoryRoot, "src/services"));
  return {
    files: [...commands.files, ...services.files],
    literals: new Set([...commands.literals, ...services.literals]),
  };
}

function payloadKeyDiff(
  keys: readonly string[],
): Readonly<{ missing: string[]; extra: string[] }> {
  const declared = eventTypes as readonly string[];
  return {
    missing: declared.filter((type) => !keys.includes(type)),
    extra: keys.filter((key) => !declared.includes(key)),
  };
}

describe("src/http/contract/event-payload.test", () => {
  it("every scanned candidate that names an event type is declared", () => {
    const scanned = scanProducers().literals;
    for (const literal of nonEventLiterals) {
      assert.ok(
        scanned.has(literal),
        `${literal} is allowlisted but is no longer scanned`,
      );
      assert.ok(
        !(eventTypes as readonly string[]).includes(literal),
        `${literal} is allowlisted and is an event type`,
      );
    }
    for (const literal of scanned) {
      if ((eventTypes as readonly string[]).includes(literal)) continue;
      if ((nonEventLiterals as readonly string[]).includes(literal)) continue;
      assert.fail(
        `${literal} is scanned but is neither an event type nor a known non-event literal`,
      );
    }
  });

  it("every declared type except the retired ones is produced", () => {
    const scanned = scanProducers().literals;
    for (const type of eventTypes) {
      if ((retiredEventTypes as readonly string[]).includes(type)) continue;
      assert.ok(
        scanned.has(type),
        `${type} is declared but no producer writes it`,
      );
    }
  });

  it("the eventPayloads keys equal eventTypes", () => {
    assert.deepEqual(payloadKeyDiff(Object.keys(eventPayloads)), {
      missing: [],
      extra: [],
    });
  });

  it("the scan read at least one file", () => {
    const scanned = scanProducers();
    assert.ok(
      scanned.files.length > 20,
      `scanned ${scanned.files.length} files`,
    );
    assert.ok(
      scanned.files.includes(
        join(repositoryRoot, "src/commands/plan/import-plan.ts"),
      ),
    );
    assert.ok(
      scanned.files.includes(
        join(repositoryRoot, "src/services/readiness/dependency.ts"),
      ),
    );
  });

  it("the scan reports an undeclared nineteenth type", () => {
    const directory = mkdtempSync(join(tmpdir(), "kanthord-event-scan-"));
    try {
      writeFileSync(
        join(directory, "fixture.ts"),
        'export const fixture = { type: "node.legacy" };\n',
        "utf8",
      );
      const scanned = scanEventTypeLiterals(directory);
      assert.ok(scanned.literals.has("node.legacy"));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("a key in eventPayloads that eventTypes does not hold is a failure", () => {
    const copy = { ...eventPayloads, "node.extra": eventPayloads["node.done"] };
    assert.deepEqual(payloadKeyDiff(Object.keys(copy)), {
      missing: [],
      extra: ["node.extra"],
    });
  });

  it("eventPayloads holds one schema per member", () => {
    for (const type of eventTypes) {
      assert.ok(
        eventPayloads[type] !== undefined,
        `${type} has no schema in eventPayloads`,
      );
    }
  });

  it("every recorded payload parses through its own schema", () => {
    assert.deepEqual(Object.keys(recordedPayloads), [...eventTypes]);
    assert.equal(recordedPayloads["node.done"]?.length, 2);
    assert.equal(recordedPayloads["node.partial"]?.length, 2);
    for (const type of eventTypes) {
      const shapes = recordedPayloads[type];
      const schema = eventPayloads[type];
      assert.ok(
        shapes !== undefined && shapes.length > 0,
        `${type} has no fixture`,
      );
      assert.ok(schema !== undefined, `${type} has no schema`);
      for (const shape of shapes) {
        schema.parse(shape);
      }
    }
  });

  it("an outcome.reported payload with a tenth key fails", () => {
    const recorded = recordedPayloads["outcome.reported"];
    const shape = recorded?.[0] as Readonly<Record<string, unknown>>;
    const schema = eventPayloads["outcome.reported"];
    assert.ok(shape !== undefined && schema !== undefined);
    assert.throws(() => schema.parse({ ...shape, extra: 1 }));
  });

  it("lease event payloads reject invented string fences", () => {
    const claimed = eventPayloads["lease.claimed"];
    const released = eventPayloads["lease.released"];
    const renewed = eventPayloads["lease.renewed"];
    assert.ok(
      claimed !== undefined && released !== undefined && renewed !== undefined,
    );
    assert.doesNotThrow(() =>
      claimed.parse({
        subjectId: "task_1",
        objectiveId: "objective_1",
        fence: 1,
        objectiveFence: 2,
        expiresAt: 1234,
        runId: "run_1",
        objectiveRunId: "run_2",
        attemptId: "attempt_1",
        attemptNo: 1,
      }),
    );
    assert.throws(() =>
      claimed.parse({
        subjectId: "task_1",
        objectiveId: "objective_1",
        fence: "1",
        objectiveFence: 2,
        expiresAt: 1234,
        runId: "run_1",
        objectiveRunId: "run_2",
        attemptId: "attempt_1",
        attemptNo: 1,
      }),
    );
    assert.throws(() =>
      released.parse({
        subjectId: "task_1",
        objectiveId: "objective_1",
        fence: "1",
      }),
    );
    assert.throws(() =>
      renewed.parse({
        subjectId: "task_1",
        objectiveId: "objective_1",
        fence: 1,
        objectiveFence: "2",
        expiresAt: 1234,
        objectiveExpiresAt: 2345,
      }),
    );
  });

  it("credential rejection payloads reject failures the producer never emits", () => {
    const schema = eventPayloads["repository.register.credentialRejected"];
    assert.ok(schema !== undefined);
    assert.doesNotThrow(() =>
      schema.parse({
        failure: "auth-failed",
        name: "origin",
        publishRef: "refs/heads/main",
        credentialId: "credential_1",
      }),
    );
    assert.throws(() =>
      schema.parse({
        failure: "transport-failed",
        name: "origin",
        publishRef: "refs/heads/main",
        credentialId: "credential_1",
      }),
    );
  });

  it("eventView parses every recorded payload", () => {
    for (const type of eventTypes) {
      const shapes = recordedPayloads[type];
      assert.ok(
        shapes !== undefined && shapes.length > 0,
        `${type} has no fixture`,
      );
      for (const shape of shapes) {
        eventView.parse({
          id: "event_1",
          type,
          subjectKind: "node",
          subjectId: "task_1",
          actorKind: "harness",
          actorId: "actor_1",
          payload: shape,
          createdAt: 1234,
        });
      }
    }
  });

  it("event.list still serves a row an earlier build wrote", () => {
    eventView.parse({
      id: "event_1",
      type: "legacy.somethingRemoved",
      subjectKind: "node",
      subjectId: "task_1",
      actorKind: "harness",
      actorId: "actor_1",
      payload: { legacyKey: 1 },
      createdAt: 1234,
    });
  });

  it("each payload schema emits as a named component", () => {
    const document = buildOpenApiDocument();
    const components = document.components as Readonly<Record<string, unknown>>;
    const schemas = components.schemas as Readonly<Record<string, unknown>>;
    for (const type of eventTypes) {
      assert.ok(
        Object.hasOwn(schemas, type),
        `${type} is not a named component`,
      );
    }
  });
});
