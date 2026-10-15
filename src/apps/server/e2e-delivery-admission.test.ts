import assert from "node:assert/strict";
import { test } from "node:test";
import { HttpStatus } from "../../kernel/http.ts";
import { createIdentity } from "../../kernel/identity.ts";
import { OperationResultType } from "../../kernel/operation.ts";
import {
  ActorKind,
  ActorService,
  AdmissionRefusal,
  AssetKind,
  Disposition,
  MISSION_SERVICE_NAME,
  MissionErrorCode,
  NodeState,
  Resolution,
  type Evidence,
  type ExternalAction,
} from "../../mission/contract.ts";
import { ActionResultKind } from "../../worker/contract.ts";
import { completed } from "./cli-support.ts";
import {
  FIRST_INDEX,
  GATED_KEY,
  RESOURCE,
  setup,
  type Page,
  type Webhook,
} from "./delivery-support.ts";

const FIRST_ATTEMPT = 1;
const LANDED_EVIDENCE_COUNT = 1;
const FIRST_PULL_REQUEST = 1;
const UNMATCHED_PULL_REQUEST = 9;
const SHARED_PULL_REQUEST = 7;
const ISSUE_NUMBER = 3;
const BAD_GATEWAY_STATUS = 502;
const TIMEOUT = 300000;
const MERGED_COMMIT = "e".repeat(40);
const PUSHED_COMMIT = "a".repeat(40);
const BASE_BRANCH = "main";
const PENDING_THEN_DIRTY_READS = 2;
const SERVICE_MISMATCH = "service_mismatch";
const RETRYABLE_REFUSAL = "repository.platform.github.retryable_refusal";

function issue(): Webhook {
  return {
    event: "issues",
    payload: {
      action: "opened",
      issue: { number: ISSUE_NUMBER },
      repository: { full_name: RESOURCE },
    },
  };
}

function closed(number: number, merged: boolean): Webhook {
  return {
    event: "pull_request",
    payload: {
      action: "closed",
      number,
      pull_request: { merged },
      repository: { full_name: RESOURCE },
    },
  };
}

function pushed(branch: string): Webhook {
  return {
    event: "push",
    payload: {
      ref: `refs/heads/${branch}`,
      after: PUSHED_COMMIT,
      repository: { full_name: RESOURCE },
    },
  };
}

test("E08 delivery admission journey", { timeout: TIMEOUT }, async (t) => {
  const h = await setup(t);
  const I = await h.create("initiative-1.md");
  const P = await h.objective("objective-p.md", I);
  const action = await h.actionRequest(P.x2);
  assert.equal(action.items[FIRST_INDEX]?.kind, ActionResultKind.Submitted);
  await h.release(P.x2.execution_id);
  assert.equal((await h.node(P.nodeId)).state, NodeState.ExternalRequested);
  const check = await h.check(P.nodeId);
  assert.equal(check.results[FIRST_INDEX]?.resolution, Resolution.Unresolved);
  const shared = [];
  for (const filename of ["objective-r.md", "objective-u.md"]) {
    const o = await h.objective(filename, I);
    const request = await h.requestPullRequest(o.x2, SHARED_PULL_REQUEST);
    assert.equal(request.requirement_key, GATED_KEY);
    await h.release(o.x2.execution_id);
    assert.equal((await h.node(o.nodeId)).state, NodeState.ExternalRequested);
    shared.push(o.nodeId);
  }
  const R = shared[FIRST_INDEX]!;

  await t.test("E08.1 an issue event is undecodable", async () => {
    const answer = completed(
      await h.admit(issue(), createIdentity("inbound_event")),
    );
    assert.deepEqual(answer, {
      disposition: Disposition.Refused,
      reason: AdmissionRefusal.Undecodable,
    });
  });
  await t.test("E08.2 an unknown pull request is unmatched", async () => {
    const answer = completed(
      await h.admit(
        closed(UNMATCHED_PULL_REQUEST, true),
        createIdentity("inbound_event"),
      ),
    );
    assert.deepEqual(answer, {
      disposition: Disposition.Refused,
      reason: AdmissionRefusal.Unmatched,
    });
  });
  await t.test("E08.3 a failed platform read fails the admission", async () => {
    h.gitHub.failPulls(BAD_GATEWAY_STATUS);
    const result = await h.admit(
      closed(FIRST_PULL_REQUEST, true),
      createIdentity("inbound_event"),
    );
    h.gitHub.failPulls(null);
    assert.ok(
      result.type === OperationResultType.Failure,
      JSON.stringify(result),
    );
    assert.equal(result.error.error.code, RETRYABLE_REFUSAL);
    assert.equal((await h.node(P.nodeId)).state, NodeState.ExternalRequested);
  });
  await t.test("E08.4 a merged pull request completes P", async () => {
    h.gitHub.merge(FIRST_PULL_REQUEST, MERGED_COMMIT);
    const i4 = createIdentity("inbound_event");
    const answer = completed(
      await h.admit(closed(FIRST_PULL_REQUEST, true), i4),
    );
    assert.deepEqual(answer, {
      disposition: Disposition.AcceptedObservation,
      reason: null,
    });
    assert.equal((await h.node(P.nodeId)).state, NodeState.Completed);
    const evidence = await h.read<Page<Evidence>>([
      "mission",
      "evidence",
      "list",
      P.nodeId,
      "--attempt",
      String(FIRST_ATTEMPT),
    ]);
    const landed = evidence.items.filter(
      (item) => item.provenance.kind === ActorKind.Service,
    );
    assert.equal(landed.length, LANDED_EVIDENCE_COUNT);
    assert.deepEqual(landed[FIRST_INDEX]!.provenance, {
      kind: ActorKind.Service,
      service: ActorService.Mission,
      inbound_event_id: i4,
    });
    const asset = landed[FIRST_INDEX]!.assets[FIRST_INDEX]!;
    assert.ok(asset.kind === AssetKind.Repository);
    assert.equal(asset.address.commit, MERGED_COMMIT);
  });
  await t.test("E08.5 a repeat event is a duplicate", async () => {
    const answer = completed(
      await h.admit(
        closed(FIRST_PULL_REQUEST, true),
        createIdentity("inbound_event"),
      ),
    );
    assert.deepEqual(answer, {
      disposition: Disposition.Duplicate,
      reason: null,
    });
  });
  await t.test("E08.6 two requests of one address are ambiguous", async () => {
    const answer = completed(
      await h.admit(
        closed(SHARED_PULL_REQUEST, true),
        createIdentity("inbound_event"),
      ),
    );
    assert.deepEqual(answer, {
      disposition: Disposition.Refused,
      reason: AdmissionRefusal.Ambiguous,
    });
    const actions = await h.read<Page<ExternalAction>>([
      "mission",
      "external-action",
      "list",
      R,
      "--attempt",
      String(FIRST_ATTEMPT),
    ]);
    assert.equal(actions.items[FIRST_INDEX]?.resolution, Resolution.Unresolved);
  });
  await t.test("E08.7 a service other than intake is refused", async () => {
    const result = await h.admit(
      closed(SHARED_PULL_REQUEST, true),
      createIdentity("inbound_event"),
      MISSION_SERVICE_NAME,
    );
    assert.ok(
      result.type === OperationResultType.Failure,
      JSON.stringify(result),
    );
    assert.equal(result.status, HttpStatus.Forbidden);
    assert.equal(
      result.error.error.code,
      MissionErrorCode.AuthorizationRefused,
    );
    assert.deepEqual(result.error.error.details, {
      reason: SERVICE_MISMATCH,
    });
  });
});

test(
  "E08.8 a base push rereads a null mergeable and returns the conflicting node to rework",
  { timeout: TIMEOUT },
  async (t) => {
    const h = await setup(t);
    const I = await h.create("initiative-1.md");
    const P = await h.objective("objective-p.md", I);
    const action = await h.actionRequest(P.x2);
    assert.equal(action.items[FIRST_INDEX]?.kind, ActionResultKind.Submitted);
    await h.release(P.x2.execution_id);
    assert.equal((await h.node(P.nodeId)).state, NodeState.ExternalRequested);
    h.gitHub.mergeability(FIRST_PULL_REQUEST, [
      { mergeable: null, mergeable_state: "unknown" },
      { mergeable: false, mergeable_state: "dirty" },
    ]);
    const before = h.gitHub.calls.length;
    const answer = completed(
      await h.admit(pushed(BASE_BRANCH), createIdentity("inbound_event")),
    );
    assert.deepEqual(answer, {
      disposition: Disposition.AcceptedObservation,
      reason: null,
    });
    const reads = h.gitHub.calls
      .slice(before)
      .filter(
        (call) =>
          call.path === `/repos/owner/gated/pulls/${FIRST_PULL_REQUEST}`,
      );
    assert.equal(reads.length, PENDING_THEN_DIRTY_READS);
    assert.equal((await h.node(P.nodeId)).state, NodeState.Available);
  },
);
