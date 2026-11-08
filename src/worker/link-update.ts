import assert from "node:assert/strict";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import type { ExecutionClaim } from "../kernel/operation.ts";
import type { Transaction } from "../kernel/store.ts";
import { IntakeErrorCode } from "../intake/contract.ts";
import { MissionErrorCode } from "../mission/contract.ts";
import { EXECUTION_NOT_RUNNING } from "../scheduler/contract.ts";
import {
  type IntakeActionCall,
  type LinkUpdateContent,
  linkUpdateContentSchema,
  type LinkUpdatePageQuery,
  type LinkUpdateRead,
  type MissionLinkUpdates,
} from "./contract.ts";
import type { Dependencies } from "./service.ts";

const CLAIM_NOT_LIVE = "claim_not_live";

type LinkUpdateDependencies = Pick<
  Dependencies,
  "store" | "schedulerClaims" | "missionActions" | "intakeActions"
>;

function claimNotLive(): never {
  throw new OperationError(
    HttpStatus.Forbidden,
    MissionErrorCode.AuthorizationRefused,
    "The facility refuses the operation.",
    { reason: CLAIM_NOT_LIVE },
  );
}

function requireLive(
  tx: Transaction,
  dependencies: LinkUpdateDependencies,
  claim: ExecutionClaim,
): void {
  try {
    dependencies.schedulerClaims.requireRunning(
      tx,
      claim.executionId,
      claim.runtimeIdentity,
      Date.now(),
    );
  } catch (error) {
    if (error instanceof OperationError && error.code === EXECUTION_NOT_RUNNING)
      claimNotLive();
    throw error;
  }
}

function isEventNotFound(error: unknown): boolean {
  return (
    error instanceof OperationError &&
    error.status === HttpStatus.NotFound &&
    error.code === IntakeErrorCode.InboundEventNotFound
  );
}

async function contentOf(
  dependencies: LinkUpdateDependencies,
  call: IntakeActionCall,
  inboundEventId: string,
): Promise<LinkUpdateContent | null> {
  try {
    const described = await dependencies.intakeActions.describe(
      call,
      inboundEventId,
    );
    if (
      described.author === null &&
      described.body === null &&
      described.url === null &&
      described.occurred_at === null
    )
      return null;
    return linkUpdateContentSchema.parse(described);
  } catch (error) {
    if (isEventNotFound(error)) return null;
    throw error;
  }
}

export async function linkUpdatePage(
  dependencies: LinkUpdateDependencies,
  call: IntakeActionCall,
  claim: ExecutionClaim,
  page: LinkUpdatePageQuery,
): Promise<LinkUpdateRead> {
  assert.equal(call.executionId, claim.executionId);
  const read: MissionLinkUpdates = dependencies.store.transaction((tx) => {
    requireLive(tx, dependencies, claim);
    return dependencies.missionActions.linkUpdatesOf(
      tx,
      claim.nodeId,
      claim.attempt,
      page,
    );
  });
  const items: LinkUpdateRead["items"] = [];
  for (const update of read.items)
    items.push({
      id: update.id,
      external_link: update.external_link,
      update_key: update.update_key,
      occurred_at: update.occurred_at,
      new: update.new,
      content: await contentOf(dependencies, call, update.inbound_event_id),
    });
  return { items, next_cursor: read.next_cursor, total: read.total };
}
