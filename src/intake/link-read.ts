import assert from "node:assert/strict";
import type { z } from "zod";
import { apiKeySecretSchema, type Material } from "../custody/contract.ts";
import { isServiceIdentity, type ServiceIdentity } from "../kernel/caller.ts";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import type { CallerContext } from "../kernel/operation.ts";
import type { Store, Transaction } from "../kernel/store.ts";
import { MISSION_SERVICE_NAME } from "../mission/contract.ts";
import type { ConversationBinding } from "../project/contract.ts";
import {
  type GitHubCall,
  type GitHubEvent,
  type GitHubPlatform,
  GitHubTargetKind,
} from "../repository/github.ts";
import { type IntakeCustody, platformFailure } from "./action-check.ts";
import {
  IntakeErrorCode,
  type intakeOperations,
  PLATFORM_CALL_DEADLINE_MS,
} from "./contract.ts";
import { findEvent, insertEvent } from "./event-store.ts";
import { newestInboundOf } from "./inbound-store.ts";
import { releasePollGrant } from "./poll.ts";

const VALIDATION_FAILED_CODE = "gateway.request.validation_failed";

type LinkReadInput = z.output<
  (typeof intakeOperations)["link.read"]["input"]
>["body"];

export interface LinkBindings {
  conversationBindingOf(
    tx: Transaction,
    bindingId: string,
  ): ConversationBinding | null;
}

export interface LinkReadDependencies {
  store: Store;
  identity: ServiceIdentity;
  custody: Pick<IntakeCustody, "authorizeOperation" | "release">;
  github: Pick<GitHubPlatform, "listIssueCommentsOf">;
  linkBindings: LinkBindings;
}

interface Hold {
  material: Material | null;
}

interface LinkTarget {
  inboundId: string;
  repository: string;
}

function authorizeLinkRead(caller: CallerContext): void {
  assert.ok(caller.identity, "A service operation holds an identity.");
  assert.ok(isServiceIdentity(caller.identity));
  assert.equal(caller.identity.service, MISSION_SERVICE_NAME);
}

function bindingOf(
  linkBindings: LinkBindings,
  tx: Transaction,
  input: LinkReadInput,
): ConversationBinding {
  const binding = linkBindings.conversationBindingOf(tx, input.binding_id);
  if (
    binding === null ||
    binding.project_id !== input.project_id ||
    binding.resource_identity !== input.external_link.resource_identity
  )
    throw new OperationError(
      HttpStatus.BadRequest,
      VALIDATION_FAILED_CODE,
      "Request validation failed.",
    );
  return binding;
}

function releaseLinkTarget(
  dependencies: LinkReadDependencies,
  tx: Transaction,
  input: LinkReadInput,
  hold: Hold,
): LinkTarget {
  assert.equal(hold.material, null, "A link read releases once.");
  const binding = bindingOf(dependencies.linkBindings, tx, input);
  const inbound = newestInboundOf(
    tx,
    input.project_id,
    binding.resource_identity,
  );
  if (inbound === null)
    throw new OperationError(
      HttpStatus.Conflict,
      IntakeErrorCode.LinkInboundMissing,
      "The link resource has no inbound.",
      { external_link: input.external_link },
    );
  hold.material = releasePollGrant(dependencies, tx, {
    inboundId: inbound.id,
    projectId: input.project_id,
    credential: binding.credential,
    platform: binding.platform,
    resource: binding.repository,
  });
  return { inboundId: inbound.id, repository: binding.repository };
}

async function listItems(
  dependencies: LinkReadDependencies,
  caller: CallerContext,
  target: LinkTarget,
  material: Material,
  number: number,
): Promise<GitHubEvent[]> {
  const call: GitHubCall = {
    token: apiKeySecretSchema.parse(material.value()).key,
    requester: dependencies.identity,
    signal: caller.context.signal,
    deadlineAt: Date.now() + PLATFORM_CALL_DEADLINE_MS,
  };
  const answer = await dependencies.github.listIssueCommentsOf(
    call,
    { kind: GitHubTargetKind.Inbound, resource: target.repository },
    number,
  );
  if (!answer.ok) throw platformFailure(answer);
  return answer.value;
}

function storeItems(
  tx: Transaction,
  inboundId: string,
  events: GitHubEvent[],
): { inbound_event_id: string }[] {
  return events.map((event) => ({
    inbound_event_id:
      findEvent(tx, inboundId, event.id) ??
      insertEvent(tx, {
        inbound_id: inboundId,
        event_id: event.id,
        event: event.body,
        metadata: { event: event.type },
        created_at: Date.now(),
      }),
  }));
}

export async function readLink(
  dependencies: LinkReadDependencies,
  caller: CallerContext,
  input: LinkReadInput,
): Promise<{ items: { inbound_event_id: string }[] }> {
  authorizeLinkRead(caller);
  const hold: Hold = { material: null };
  try {
    const target = dependencies.store.transaction((tx) =>
      releaseLinkTarget(dependencies, tx, input, hold),
    );
    assert.ok(hold.material, "A committed release holds the material.");
    const events = await listItems(
      dependencies,
      caller,
      target,
      hold.material,
      input.external_link.number,
    );
    return caller.commit((tx) => ({
      items: storeItems(tx, target.inboundId, events),
    }));
  } finally {
    hold.material?.drop();
  }
}
