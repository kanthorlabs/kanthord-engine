import assert from "node:assert/strict";
import { test } from "node:test";
import { background } from "../kernel/context.ts";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import { createIdentity } from "../kernel/identity.ts";
import type { ExecutionClaim } from "../kernel/operation.ts";
import { IntakeErrorCode } from "../intake/contract.ts";
import { MissionErrorCode } from "../mission/contract.ts";
import {
  type IntakeActionCall,
  LINK_UPDATE_LIMIT_DEFAULT,
  type MissionLinkUpdates,
} from "./contract.ts";
import { linkUpdatePage } from "./link-update.ts";
import type { Dependencies } from "./service.ts";

const FIRST_ATTEMPT = 1;
const SECOND_ATTEMPT = 2;
const THIRD_ATTEMPT = 3;
const OPENED_AT = new Map([
  [FIRST_ATTEMPT, 10],
  [SECOND_ATTEMPT, 20],
  [THIRD_ATTEMPT, 30],
]);
const NOT_LIVE = "scheduler.execution.not_running";
const CLAIM_NOT_LIVE = "claim_not_live";
const NO_CALLS = 0;
const EVENT_TIME = 1000;
const AUTHOR = "octocat";

interface Row {
  id: string;
  inbound_event_id: string;
  occurred_at: number;
  inserted_at: number;
  trusted: boolean;
}

const LINK = {
  kind: "github_issue",
  resource_identity: "conversation:github:octo/widgets",
  number: 7,
};

interface Described {
  author: string | null;
  body: string | null;
  url: string | null;
  occurred_at: number | null;
}

function row(occurredAt: number, insertedAt: number, trusted = true): Row {
  return {
    id: createIdentity("link_update"),
    inbound_event_id: createIdentity("inbound_event"),
    occurred_at: occurredAt,
    inserted_at: insertedAt,
    trusted,
  };
}

function claim(attempt: number): ExecutionClaim {
  return {
    executionId: createIdentity("execution"),
    runtimeIdentity: "runtime",
    projectId: createIdentity("project"),
    nodeId: createIdentity("node"),
    attempt,
    pinnedRevision: 1,
  } as ExecutionClaim;
}

function callOf(held: ExecutionClaim): IntakeActionCall {
  return {
    context: background,
    identity: { kind: "client" } as IntakeActionCall["identity"],
    executionId: held.executionId,
  };
}

function harness(
  rows: readonly Row[],
  missing: ReadonlySet<string> = new Set(),
  answer?: Described,
) {
  const calls = { linkUpdatesOf: 0, describe: 0, live: true };
  const dependencies = {
    store: { transaction: (work: (tx: unknown) => unknown) => work({}) },
    schedulerClaims: {
      requireRunning: () => {
        if (!calls.live)
          throw new OperationError(
            HttpStatus.Conflict,
            NOT_LIVE,
            "The execution is not running.",
          );
      },
    },
    missionActions: {
      linkUpdatesOf: (
        _tx: unknown,
        _nodeId: string,
        attempt: number,
        page: { cursor?: string; limit?: number },
      ): MissionLinkUpdates => {
        calls.linkUpdatesOf += 1;
        const since = OPENED_AT.get(attempt - 1) ?? null;
        const trusted = rows
          .filter((item) => item.trusted)
          .sort(
            (left, right) =>
              right.occurred_at - left.occurred_at ||
              right.id.localeCompare(left.id),
          );
        const start =
          page.cursor === undefined
            ? 0
            : trusted.findIndex((item) => item.id === page.cursor) + 1;
        const slice = trusted.slice(
          start,
          start + (page.limit ?? trusted.length),
        );
        const last = slice.at(-1);
        return {
          items: slice.map((item) => ({
            id: item.id,
            external_link: LINK,
            update_key: `issue_comment:${item.occurred_at}`,
            inbound_event_id: item.inbound_event_id,
            actor_id: "583231",
            occurred_at: item.occurred_at,
            new: since === null || item.inserted_at >= since,
          })),
          next_cursor:
            last !== undefined && start + slice.length < trusted.length
              ? last.id
              : null,
          total: trusted.length,
        };
      },
    },
    intakeActions: {
      describe: async (_call: IntakeActionCall, inboundEventId: string) => {
        calls.describe += 1;
        if (missing.has(inboundEventId))
          throw new OperationError(
            HttpStatus.NotFound,
            IntakeErrorCode.InboundEventNotFound,
            "Inbound event not found.",
          );
        if (answer !== undefined) return answer;
        return {
          author: AUTHOR,
          body: `body of ${inboundEventId}`,
          url: "https://github.com/octo/widgets/issues/7#issuecomment-1",
          occurred_at: EVENT_TIME,
        };
      },
    },
  } as unknown as Pick<
    Dependencies,
    "store" | "schedulerClaims" | "missionActions" | "intakeActions"
  >;
  return { dependencies, calls };
}

const page = { limit: LINK_UPDATE_LIMIT_DEFAULT };

test("a row whose event answers 404 answers content null", async () => {
  const stored = row(100, 1);
  const gone = row(200, 1);
  const h = harness([stored, gone], new Set([gone.inbound_event_id]));
  const held = claim(FIRST_ATTEMPT);
  const answer = await linkUpdatePage(h.dependencies, callOf(held), held, page);
  assert.equal(answer.items[0]!.content, null);
  assert.equal(answer.items[1]!.content?.author, AUTHOR);
});

test("a claim that is not live answers 403 claim_not_live and calls nothing", async () => {
  const h = harness([row(100, 1)]);
  h.calls.live = false;
  const held = claim(FIRST_ATTEMPT);
  const error = await linkUpdatePage(
    h.dependencies,
    callOf(held),
    held,
    page,
  ).then(
    () => null,
    (failure: unknown) => failure,
  );
  assert.ok(error instanceof OperationError);
  assert.equal(error.status, HttpStatus.Forbidden);
  assert.equal(error.code, MissionErrorCode.AuthorizationRefused);
  assert.deepEqual(error.details, { reason: CLAIM_NOT_LIVE });
  assert.equal(h.calls.linkUpdatesOf, NO_CALLS);
  assert.equal(h.calls.describe, NO_CALLS);
});

test("an answer of four null fields answers content null", async () => {
  const h = harness([row(100, 1)], new Set(), {
    author: null,
    body: null,
    url: null,
    occurred_at: null,
  });
  const held = claim(FIRST_ATTEMPT);
  const answer = await linkUpdatePage(h.dependencies, callOf(held), held, page);
  assert.equal(answer.items[0]!.content, null);
});

test("a partly null answer fails and hides nothing behind null", async () => {
  const h = harness([row(100, 1)], new Set(), {
    author: AUTHOR,
    body: null,
    url: null,
    occurred_at: EVENT_TIME,
  });
  const held = claim(FIRST_ATTEMPT);
  await assert.rejects(
    linkUpdatePage(h.dependencies, callOf(held), held, page),
  );
});
