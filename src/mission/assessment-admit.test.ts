import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { OperationError } from "../kernel/errors.ts";
import { createIdentity } from "../kernel/identity.ts";
import { canonicalJSON } from "../kernel/json.ts";
import { testHumanIdentity } from "../kernel/test-identity.ts";
import {
  AssessmentResult,
  AssetKind,
  MissionErrorCode,
  NodeKind,
  type AssessmentSubmit,
  type Verification,
} from "./contract.ts";
import { admitAssessment } from "./assessment-admit.ts";
import { getRevision } from "./node-read.ts";
import {
  insertEvidence,
  readOpenAttempt,
  insertAssessment,
  insertOutcome,
} from "./record-store.ts";
import { readNode, insertNode, insertRevision } from "./store.ts";
import { executionHarness } from "./test-support.ts";

const IDENTITY = testHumanIdentity("ulrich", "Ulrich", "token");
const FIRST = 1;
const ZERO = 0;
const NOW = 200;
const VALIDATION = "gateway.request.validation_failed";
const INPUT = { kind: AssetKind.Produced, sha256: "a".repeat(64) } as const;
const RESULT = {
  command: "true",
  exitCode: ZERO,
  signal: null,
  timedOut: false,
};

function fixture(t: TestContext) {
  const h = executionHarness(t, IDENTITY);
  const body: AssessmentSubmit = {
    ...h.context,
    evidenceIds: [],
    childOutcomeIds: [],
    result: AssessmentResult.Success,
    rationale: "Checked",
    testedInput: INPUT,
  };
  const seed = (
    verification: Verification | null,
    published = true,
    attempt = FIRST,
    expiredAt: number | null = null,
  ) => {
    const id = createIdentity("evidence");
    h.store.transaction((tx) =>
      insertEvidence(
        tx,
        {
          id,
          node_id: h.nodeId,
          attempt,
          subject: "Proof",
          requirement_key: null,
          end_state: null,
          verification:
            verification === null ? null : canonicalJSON(verification),
          provenance: canonicalJSON(h.executionActor),
          created_at: NOW,
        },
        [
          {
            id: createIdentity("evidence_asset"),
            evidence_id: id,
            kind: AssetKind.Produced,
            content: canonicalJSON({
              mediaType: "text/plain",
              data: "",
              sha256: INPUT.sha256,
            }),
            published_at: published ? NOW : null,
            expired_at: expiredAt,
          },
        ],
      ),
    );
    return id;
  };
  const admit = (input = body, objective = false) =>
    h.store.transaction((tx) => {
      const node = readNode(tx, h.nodeId)!;
      const revision = getRevision(tx, h.nodeId, FIRST);
      if (objective) {
        node.kind = NodeKind.Objective;
        revision.tasks = [
          {
            id: createIdentity("node"),
            filename: "task.md",
            content: { ...revision.content, verifications: ["task"] },
          },
        ];
      }
      admitAssessment(
        tx,
        h.dependencies,
        node,
        readOpenAttempt(tx, h.nodeId)!,
        revision,
        input,
      );
    });
  assert.equal(body.attempt, FIRST);
  assert.equal(body.evidenceIds.length, ZERO);
  return { ...h, body, seed, admit };
}

function refusal(run: () => void, code: string, field?: string) {
  assert.throws(run, (error) => {
    assert.ok(error instanceof OperationError);
    assert.equal(error.code, code);
    if (field)
      assert.deepEqual(error.details, [{ path: [field], code: "custom" }]);
    return true;
  });
}

test("assessment admission requires one passing verification with matching tested input and all pinned task commands", (t) => {
  const h = fixture(t);
  refusal(() => h.admit(), MissionErrorCode.AssessmentVerificationFailed);
  const passing = { testedInput: INPUT, results: [RESULT] };
  h.body.evidenceIds = [h.seed(passing)];
  h.admit();
  refusal(
    () => h.admit(h.body, true),
    MissionErrorCode.AssessmentVerificationFailed,
  );
  refusal(
    () =>
      h.admit({ ...h.body, testedInput: { ...INPUT, sha256: "b".repeat(64) } }),
    VALIDATION,
    "testedInput",
  );
  h.body.evidenceIds.push(h.seed(passing));
  refusal(() => h.admit(), MissionErrorCode.AssessmentVerificationFailed);
});

test("assessment result order permits criterion-not-met for a failed run but rejects undetermined", (t) => {
  const h = fixture(t);
  h.body.evidenceIds = [
    h.seed({ testedInput: INPUT, results: [{ ...RESULT, exitCode: FIRST }] }),
  ];
  refusal(() => h.admit(), MissionErrorCode.AssessmentVerificationFailed);
  h.admit({ ...h.body, result: AssessmentResult.CriterionNotMet });
  refusal(
    () => h.admit({ ...h.body, result: AssessmentResult.Undetermined }),
    VALIDATION,
    "result",
  );
});

test("assessment admission checks rationale and evidence ownership before publication and child sets", (t) => {
  const h = fixture(t);
  const pending = h.seed(null, false);
  const foreignAttempt = h.seed(null, true, ZERO);
  h.body.evidenceIds = [pending, foreignAttempt];
  refusal(() => h.admit(), VALIDATION, "evidenceIds");
  assert.throws(
    () =>
      h.admit({
        ...h.body,
        rationale: "x".repeat(h.dependencies.config.textMaxBytes + FIRST),
      }),
    (error) =>
      error instanceof OperationError &&
      error.code === VALIDATION &&
      canonicalJSON(error.details).includes("rationale"),
  );
  h.body.evidenceIds = [pending];
  h.body.childOutcomeIds = [createIdentity("outcome")];
  refusal(() => h.admit(), MissionErrorCode.AssessmentEvidenceUnpublished);
  h.body.evidenceIds = [h.seed(null, false, FIRST, ZERO)];
  refusal(() => h.admit(), MissionErrorCode.AssessmentEvidenceUnpublished);
  h.body.evidenceIds = [h.seed(null)];
  refusal(() => h.admit(), VALIDATION, "childOutcomeIds");
  refusal(() => h.admit(h.body, true), VALIDATION, "childOutcomeIds");
  h.body.childOutcomeIds = [];
  refusal(
    () => h.admit({ ...h.body, result: AssessmentResult.Undetermined }),
    VALIDATION,
    "result",
  );
});

test("non-success assessments retain the verification's tested input", (t) => {
  const h = fixture(t);
  h.body.evidenceIds = [h.seed({ testedInput: INPUT, results: [RESULT] })];
  for (const result of [
    AssessmentResult.CriterionNotMet,
    AssessmentResult.Undetermined,
  ])
    refusal(
      () =>
        h.admit({
          ...h.body,
          result,
          testedInput: { ...INPUT, sha256: "b".repeat(64) },
        }),
      VALIDATION,
      "testedInput",
    );
});

test("initiative admission tracks replacement child outcomes and excludes retired children", (t) => {
  const h = fixture(t);
  h.body.evidenceIds = [h.seed({ testedInput: INPUT, results: [RESULT] })];
  const childId = createIdentity("node");
  h.store.transaction((tx) => {
    const base = getRevision(tx, h.nodeId, FIRST);
    insertNode(tx, {
      id: childId,
      mission_id: h.missionId,
      kind: NodeKind.Objective,
      parent_id: h.nodeId,
      filename: "child.md",
      created_at: NOW,
    });
    insertRevision(tx, {
      ...base,
      nodeId: childId,
      filename: "child.md",
      tasks: [],
    });
  });
  const outcome = () =>
    h.store.transaction((tx) => {
      const id = createIdentity("assessment");
      insertAssessment(tx, {
        id,
        node_id: childId,
        attempt: ZERO,
        result: AssessmentResult.Undetermined,
        rationale: "Blocked",
        evidence_ids: "[]",
        child_outcome_ids: "[]",
        tested_input: null,
        actor: canonicalJSON(h.actor),
        execution_id: null,
        node_revision: FIRST,
        created_at: NOW,
      });
      return insertOutcome(tx, {
        id: createIdentity("outcome"),
        node_id: childId,
        result: AssessmentResult.Undetermined,
        assessment_id: id,
        evidence_ids: "[]",
        created_at: NOW,
      });
    });
  h.body.childOutcomeIds = [outcome().id];
  h.admit();
  const replacement = outcome();
  refusal(() => h.admit(), VALIDATION, "childOutcomeIds");
  h.body.childOutcomeIds = [replacement.id];
  h.admit();
  h.store.transaction((tx) =>
    tx.database
      .prepare("UPDATE mission_node SET retired_at = ? WHERE id = ?")
      .run(NOW, childId),
  );
  refusal(() => h.admit(), VALIDATION, "childOutcomeIds");
  h.body.childOutcomeIds = [];
  h.admit();
});
