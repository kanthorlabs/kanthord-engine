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
const FIRST_ATTEMPT = 1;
const FIRST_REVISION = 1;
const FAILURE_EXIT_CODE = 1;
const TEXT_OVERFLOW = 1;
const SUCCESS_EXIT_CODE = 0;
const NO_EVIDENCE = 0;
const NO_ATTEMPT = 0;
const EXPIRED_TIMESTAMP = 0;
const NOW = 200;
const VALIDATION = "gateway.request.validation_failed";
const INPUT = { kind: AssetKind.Produced, sha256: "a".repeat(64) } as const;
const RESULT = {
  command: "true",
  exit_code: SUCCESS_EXIT_CODE,
  signal: null,
  timed_out: false,
};

function fixture(t: TestContext) {
  const h = executionHarness(t, IDENTITY);
  const body: AssessmentSubmit = {
    ...h.context,
    evidence_ids: [],
    child_outcome_ids: [],
    result: AssessmentResult.Success,
    rationale: "Checked",
    tested_input: INPUT,
  };
  const seed = (
    verification: Verification | null,
    published = true,
    attempt = FIRST_ATTEMPT,
    expiredAt: number | null = null,
  ) => {
    const id = createIdentity("evidence");
    h.store.transaction((tx) =>
      insertEvidence(
        tx,
        {
          id,
          node_id: h.node_id,
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
              media_type: "text/plain",
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
      const node = readNode(tx, h.node_id)!;
      const revision = getRevision(tx, h.node_id, FIRST_REVISION);
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
        readOpenAttempt(tx, h.node_id)!,
        revision,
        input,
      );
    });
  assert.equal(body.attempt, FIRST_ATTEMPT);
  assert.equal(body.evidence_ids.length, NO_EVIDENCE);
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
  const passing = { tested_input: INPUT, results: [RESULT] };
  h.body.evidence_ids = [h.seed(passing)];
  h.admit();
  refusal(
    () => h.admit(h.body, true),
    MissionErrorCode.AssessmentVerificationFailed,
  );
  refusal(
    () =>
      h.admit({
        ...h.body,
        tested_input: { ...INPUT, sha256: "b".repeat(64) },
      }),
    VALIDATION,
    "tested_input",
  );
  h.body.evidence_ids.push(h.seed(passing));
  refusal(() => h.admit(), MissionErrorCode.AssessmentVerificationFailed);
});

test("assessment success counts only the verification that covers every required command", (t) => {
  const h = fixture(t);
  const partial = h.seed({ tested_input: INPUT, results: [RESULT] });
  const full = {
    tested_input: INPUT,
    results: [RESULT, { ...RESULT, command: "task" }],
  };
  const failing = {
    ...full,
    results: [
      RESULT,
      { ...RESULT, command: "task", exit_code: FAILURE_EXIT_CODE },
    ],
  };
  const fullId = h.seed(full);
  h.body.evidence_ids = [partial, fullId];
  h.admit(h.body, true);
  h.body.evidence_ids = [partial, fullId, h.seed(full)];
  refusal(
    () => h.admit(h.body, true),
    MissionErrorCode.AssessmentVerificationFailed,
  );
  h.body.evidence_ids = [partial];
  refusal(
    () => h.admit(h.body, true),
    MissionErrorCode.AssessmentVerificationFailed,
  );
  h.body.evidence_ids = [h.seed(failing), partial];
  refusal(
    () => h.admit(h.body, true),
    MissionErrorCode.AssessmentVerificationFailed,
  );
});

test("assessment result order permits criterion-not-met for a failed run but rejects undetermined", (t) => {
  const h = fixture(t);
  h.body.evidence_ids = [
    h.seed({
      tested_input: INPUT,
      results: [{ ...RESULT, exit_code: FAILURE_EXIT_CODE }],
    }),
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
  const foreignAttempt = h.seed(null, true, NO_ATTEMPT);
  h.body.evidence_ids = [pending, foreignAttempt];
  refusal(() => h.admit(), VALIDATION, "evidence_ids");
  assert.throws(
    () =>
      h.admit({
        ...h.body,
        rationale: "x".repeat(
          h.dependencies.config.text_max_bytes + TEXT_OVERFLOW,
        ),
      }),
    (error) =>
      error instanceof OperationError &&
      error.code === VALIDATION &&
      canonicalJSON(error.details).includes("rationale"),
  );
  h.body.evidence_ids = [pending];
  h.body.child_outcome_ids = [createIdentity("outcome")];
  refusal(() => h.admit(), MissionErrorCode.AssessmentEvidenceUnpublished);
  h.body.evidence_ids = [h.seed(null, false, FIRST_ATTEMPT, EXPIRED_TIMESTAMP)];
  refusal(() => h.admit(), MissionErrorCode.AssessmentEvidenceUnpublished);
  h.body.evidence_ids = [h.seed(null)];
  refusal(() => h.admit(), VALIDATION, "child_outcome_ids");
  refusal(() => h.admit(h.body, true), VALIDATION, "child_outcome_ids");
  h.body.child_outcome_ids = [];
  refusal(
    () => h.admit({ ...h.body, result: AssessmentResult.Undetermined }),
    VALIDATION,
    "result",
  );
});

test("non-success assessments retain the verification's tested input", (t) => {
  const h = fixture(t);
  h.body.evidence_ids = [h.seed({ tested_input: INPUT, results: [RESULT] })];
  for (const result of [
    AssessmentResult.CriterionNotMet,
    AssessmentResult.Undetermined,
  ])
    refusal(
      () =>
        h.admit({
          ...h.body,
          result,
          tested_input: { ...INPUT, sha256: "b".repeat(64) },
        }),
      VALIDATION,
      "tested_input",
    );
});

test("initiative admission tracks replacement child outcomes and excludes retired children", (t) => {
  const h = fixture(t);
  h.body.evidence_ids = [h.seed({ tested_input: INPUT, results: [RESULT] })];
  const childId = createIdentity("node");
  h.store.transaction((tx) => {
    const base = getRevision(tx, h.node_id, FIRST_REVISION);
    insertNode(tx, {
      id: childId,
      mission_id: h.mission_id,
      kind: NodeKind.Objective,
      parent_id: h.node_id,
      filename: "child.md",
      created_at: NOW,
    });
    insertRevision(tx, {
      ...base,
      node_id: childId,
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
        attempt: NO_ATTEMPT,
        result: AssessmentResult.Undetermined,
        rationale: "Blocked",
        evidence_ids: "[]",
        child_outcome_ids: "[]",
        tested_input: null,
        actor: canonicalJSON(h.actor),
        execution_id: null,
        node_revision: FIRST_REVISION,
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
  h.body.child_outcome_ids = [outcome().id];
  h.admit();
  const replacement = outcome();
  refusal(() => h.admit(), VALIDATION, "child_outcome_ids");
  h.body.child_outcome_ids = [replacement.id];
  h.admit();
  h.store.transaction((tx) =>
    tx.database
      .prepare("UPDATE mission_node SET retired_at = ? WHERE id = ?")
      .run(NOW, childId),
  );
  refusal(() => h.admit(), VALIDATION, "child_outcome_ids");
  h.body.child_outcome_ids = [];
  h.admit();
});
