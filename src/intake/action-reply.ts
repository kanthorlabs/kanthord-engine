import assert from "node:assert/strict";
import type {
  ActionFacts,
  Material,
  ReplyActionFacts,
} from "../custody/contract.ts";
import type { CallerIdentity } from "../kernel/caller.ts";
import { ExternalLinkKind } from "../kernel/external-link.ts";
import { canonicalJSON } from "../kernel/json.ts";
import type { Store } from "../kernel/store.ts";
import {
  GITHUB_RESULT_CODE_PREFIX,
  GitHubTargetKind,
} from "../repository/github.ts";
import type { ActionCheckDependencies } from "./action-check.ts";
import { deadlineOf, gitHubCall } from "./action-merge.ts";
import {
  AddressKind,
  OutboundOperation,
  type OutboundOperationValue,
  OutboundRequestState,
  PLATFORM_CALL_DEADLINE_MS,
  type PlatformAddress,
  replyAccountSchema,
  replyResultSchema,
  type ResultClassAnswer,
  type ResultClassValue,
} from "./contract.ts";
import { Platform } from "./credential-platform.ts";
import {
  type JiraAnswer,
  type JiraCall,
  jiraCredentialsOf,
  jiraSiteOf,
  postJiraComment,
  readJiraAccount,
} from "./jira.ts";
import { platformFailureCode } from "./platform-failure.ts";
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
  operation: OutboundOperationValue;
  metadata: unknown;
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
      held.operation,
      held.request_key,
    );
    assert.ok(row !== null, "A reply call runs on its request row.");
    const recorded =
      row.result === null
        ? null
        : replyAccountSchema.safeParse(JSON.parse(row.result));
    const succeeded = findByKeySuffix(
      tx,
      held.operation,
      replyLinkSuffix(held.facts),
    ).some((item) => item.state === OutboundRequestState.Succeeded);
    return {
      id: row.id,
      actor_id: recorded?.success ? recorded.data.actor_id : null,
      succeeded,
    };
  });
}

type ReplyAnswer<T> =
  | { ok: true; value: T }
  | { ok: false; class: ResultClassValue; code: string; message: string };

interface ReplyPlatform {
  readAccount(): Promise<ReplyAnswer<string>>;
  postComment(): Promise<
    ReplyAnswer<{ update_key: string; actor_id: string | null }>
  >;
}

function refusal(failure: {
  class: ResultClassValue;
  code: string;
  message: string;
}): CallAnswer {
  return {
    ok: false,
    class: failure.class,
    code: failure.code,
    message: failure.message,
  };
}

function gitHubReply(
  dependencies: ActionCheckDependencies,
  requester: CallerIdentity,
  held: ReplyHeld,
  release: { material: Material | null; scope: OutboundScope },
  number: number,
): ReplyPlatform {
  const call = gitHubCall(requester, release.material, release.scope);
  return {
    readAccount: () => dependencies.github.readTokenAccount(call),
    postComment: () =>
      dependencies.github.postIssueComment(
        call,
        {
          kind: GitHubTargetKind.Inbound,
          resource: held.facts.conversation.repository,
        },
        number,
        held.comment,
      ),
  };
}

function jiraReply(
  held: ReplyHeld,
  release: { material: Material | null; scope: OutboundScope },
  key: string,
): ReplyPlatform {
  assert.ok(release.material, "A Jira reply holds a released material.");
  const call: JiraCall = {
    credentials: jiraCredentialsOf(held.metadata, release.material.value()),
    signal: release.scope.signal,
    deadlineAt: deadlineOf(release.scope, PLATFORM_CALL_DEADLINE_MS),
  };
  const target = {
    site: jiraSiteOf(held.facts.conversation.repository),
    key,
  };
  const coded = <T>(answer: JiraAnswer<T>): ReplyAnswer<T> =>
    answer.ok
      ? answer
      : { ...answer, code: platformFailureCode(Platform.Jira, answer.class) };
  return {
    readAccount: async () => coded(await readJiraAccount(call)),
    postComment: async () =>
      coded(await postJiraComment(call, target, held.comment)),
  };
}

export async function callReply(
  dependencies: ActionCheckDependencies,
  requester: CallerIdentity,
  held: ReplyHeld,
  release: { material: Material | null; scope: OutboundScope },
): Promise<CallAnswer> {
  const link = held.facts.frozen_action.configuration.external_link;
  const platform =
    link.kind === ExternalLinkKind.JiraIssue
      ? jiraReply(held, release, link.key)
      : gitHubReply(dependencies, requester, held, release, link.number);
  const known = recordedAccountOf(dependencies.store, held);
  let actorId = known.actor_id;
  if (actorId === null && !known.succeeded) {
    const account = await platform.readAccount();
    if (!account.ok) return refusal(account);
    actorId = account.value;
    dependencies.store.transaction((tx) =>
      recordResult(tx, known.id, { actor_id: actorId }),
    );
  }
  const posted = await platform.postComment();
  if (!posted.ok) return refusal(posted);
  return {
    ok: true,
    result: {
      update_key: posted.value.update_key,
      actor_id: posted.value.actor_id ?? actorId,
    },
  };
}

function resultCodeOf(held: ReplyHeld, resultClass: ResultClassValue): string {
  return held.operation === OutboundOperation.JiraIssueComment
    ? platformFailureCode(Platform.Jira, resultClass)
    : GITHUB_RESULT_CODE_PREFIX + resultClass;
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
        code: resultCodeOf(held, answer.class),
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
