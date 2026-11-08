import assert from "node:assert/strict";
import type {
  ActionFacts,
  Material,
  ReplyActionFacts,
} from "../custody/contract.ts";
import type { CallerIdentity } from "../kernel/caller.ts";
import { canonicalJSON } from "../kernel/json.ts";
import type { Store } from "../kernel/store.ts";
import {
  GITHUB_RESULT_CODE_PREFIX,
  type GitHubFailure,
  GitHubTargetKind,
} from "../repository/github.ts";
import type { ActionCheckDependencies } from "./action-check.ts";
import { gitHubCall } from "./action-merge.ts";
import {
  AddressKind,
  OutboundOperation,
  OutboundRequestState,
  type PlatformAddress,
  replyAccountSchema,
  replyResultSchema,
  type ResultClassAnswer,
} from "./contract.ts";
import {
  type CallAnswer,
  type Finalization,
  FinalizationKind,
  type OutboundAnswer,
  type OutboundScope,
  type ResultCodec,
} from "./outbound.ts";
import { findByKey, findByKeySuffix, recordResult } from "./outbound-store.ts";

const REPLY_KEY_PATTERN = /\.reply\.[0-9]$/;
const EMPTY_TEXT_LENGTH = 0;

export type ReplyHeld = {
  facts: Readonly<ReplyActionFacts>;
  project_id: string;
  request_key: string;
  comment: string;
};

export function isReplyKey(key: string): boolean {
  return REPLY_KEY_PATTERN.test(key);
}

export function isReplyFacts(
  facts: Readonly<ActionFacts | ReplyActionFacts>,
): facts is Readonly<ReplyActionFacts> {
  return "conversation" in facts;
}

export const replyCodec: ResultCodec = {
  encode: (value) => replyResultSchema.parse(value),
  decode: (stored) => replyResultSchema.parse(stored),
};

export function replyLinkSuffix(facts: Readonly<ReplyActionFacts>): string {
  return `:${canonicalJSON(facts.frozen_action.configuration.external_link)}`;
}

function recordedAccountOf(
  store: Store,
  held: ReplyHeld,
): { id: string; actor_id: string | null; succeeded: boolean } {
  return store.transaction((tx) => {
    const row = findByKey(
      tx,
      held.project_id,
      OutboundOperation.GitHubIssueComment,
      held.request_key,
    );
    assert.ok(row !== null, "A reply call runs on its request row.");
    const recorded =
      row.result === null
        ? null
        : replyAccountSchema.safeParse(JSON.parse(row.result));
    const succeeded = findByKeySuffix(
      tx,
      OutboundOperation.GitHubIssueComment,
      replyLinkSuffix(held.facts),
    ).some((item) => item.state === OutboundRequestState.Succeeded);
    return {
      id: row.id,
      actor_id: recorded?.success ? recorded.data.actor_id : null,
      succeeded,
    };
  });
}

function refusal(failure: GitHubFailure): CallAnswer {
  return {
    ok: false,
    class: failure.class,
    code: failure.code,
    message: failure.message,
  };
}

export async function callReply(
  dependencies: ActionCheckDependencies,
  requester: CallerIdentity,
  held: ReplyHeld,
  release: { material: Material | null; scope: OutboundScope },
): Promise<CallAnswer> {
  const call = gitHubCall(requester, release.material, release.scope);
  const link = held.facts.frozen_action.configuration.external_link;
  const known = recordedAccountOf(dependencies.store, held);
  let actorId = known.actor_id;
  if (actorId === null && !known.succeeded) {
    const account = await dependencies.github.readTokenAccount(call);
    if (!account.ok) return refusal(account);
    actorId = account.value;
    dependencies.store.transaction((tx) =>
      recordResult(tx, known.id, { actor_id: actorId }),
    );
  }
  const posted = await dependencies.github.postIssueComment(
    call,
    {
      kind: GitHubTargetKind.Inbound,
      resource: held.facts.conversation.repository,
    },
    link.number,
    held.comment,
  );
  if (!posted.ok) return refusal(posted);
  return {
    ok: true,
    result: {
      update_key: posted.value.update_key,
      actor_id: posted.value.actor_id ?? actorId,
    },
  };
}

export function finalizeReply(
  held: ReplyHeld,
  answer: OutboundAnswer,
): Finalization<PlatformAddress | ResultClassAnswer> {
  if (!answer.ok)
    return {
      kind: FinalizationKind.Answer,
      body: {
        class: answer.class,
        code: GITHUB_RESULT_CODE_PREFIX + answer.class,
        message: answer.message,
      },
    };
  const result = replyResultSchema.parse(answer.result);
  assert.ok(
    held.facts.conversation.resource_identity.length > EMPTY_TEXT_LENGTH,
  );
  return {
    kind: FinalizationKind.Answer,
    body: {
      kind: AddressKind.Comment,
      resource_identity: held.facts.conversation.resource_identity,
      update_key: result.update_key,
    },
  };
}
