import assert from "node:assert/strict";
import type { ServiceIdentity } from "../kernel/caller.ts";
import { throwIfCancelled, type Context } from "../kernel/context.ts";
import { OperationError } from "../kernel/errors.ts";
import { ResourceStatus, type ResourceCheck } from "../kernel/health.ts";
import type { Store, Transaction } from "../kernel/store.ts";
import type { IntakeCustody } from "./action-check.ts";
import { InboundKind, type IntakeInventoryEntry } from "./contract.ts";
import { allInbounds, type InboundRow } from "./inbound-store.ts";
import {
  etagOf,
  POLL_READS,
  pollTargetOf,
  releasePollGrant,
  requestPollRead,
  type Hold,
  type PollGitHub,
  type PollRead,
  type PollTarget,
} from "./poll.ts";

const EMPTY_IDENTIFIER_LENGTH = 0;

export const INBOUND_TARGET_KIND = "inbound";
export const InboundCapability = {
  PollAcquisition: "poll acquisition",
  Webhook: "webhook",
} as const;
export type InboundCapabilityValue =
  (typeof InboundCapability)[keyof typeof InboundCapability];

export interface InboundHealthDependencies {
  store: Store;
  identity: ServiceIdentity;
  custody: Pick<IntakeCustody, "authorizeOperation" | "release">;
  github: PollGitHub;
}

const webhookCheck: ResourceCheck = async () => ResourceStatus.Unknown;

function releaseRefusal(
  dependencies: InboundHealthDependencies,
  target: PollTarget,
  hold: Hold,
): string | null {
  assert.equal(hold.material, null, "A check releases once.");
  assert.ok(target.facts.inboundId.length > EMPTY_IDENTIFIER_LENGTH);
  try {
    dependencies.store.transaction((tx) => {
      hold.material = releasePollGrant(dependencies, tx, target.facts);
    });
    return null;
  } catch (error) {
    if (!(error instanceof OperationError)) throw error;
    return error.code;
  }
}

async function readFailure(
  dependencies: InboundHealthDependencies,
  target: PollTarget,
  read: PollRead,
  context: Context,
): Promise<string | null> {
  const hold: Hold = { material: null };
  try {
    const refusal = releaseRefusal(dependencies, target, hold);
    if (refusal !== null) return refusal;
    assert.ok(hold.material, "A committed release holds the material.");
    const answer = await requestPollRead(dependencies.github, read, {
      requester: dependencies.identity,
      context,
      material: hold.material,
      owner: target.owner,
      repo: target.repo,
      etag: etagOf(target.checkpoint, read),
    });
    throwIfCancelled(context);
    return answer.ok ? null : answer.code;
  } finally {
    hold.material?.drop();
  }
}

function pollCheck(
  dependencies: InboundHealthDependencies,
  row: InboundRow,
): ResourceCheck {
  assert.equal(
    row.kind,
    InboundKind.Poll,
    "A poll check reads a poll inbound.",
  );
  assert.ok(
    row.id.length > EMPTY_IDENTIFIER_LENGTH,
    "A poll check names its inbound.",
  );
  return async (context, observe) => {
    throwIfCancelled(context);
    const target = pollTargetOf(row);
    assert.ok(
      target.owner.length > EMPTY_IDENTIFIER_LENGTH,
      "A target names an owner.",
    );
    assert.ok(
      target.repo.length > EMPTY_IDENTIFIER_LENGTH,
      "A target names a repository.",
    );
    for (const read of POLL_READS) {
      const failure = await readFailure(dependencies, target, read, context);
      if (failure === null) continue;
      observe?.(failure);
      return ResourceStatus.Unhealthy;
    }
    return ResourceStatus.Healthy;
  };
}

function checkOf(
  dependencies: InboundHealthDependencies,
  row: InboundRow,
): { capability: InboundCapabilityValue; check: ResourceCheck } {
  assert.ok(Object.values(InboundKind).includes(row.kind));
  if (row.kind === InboundKind.Webhook)
    return { capability: InboundCapability.Webhook, check: webhookCheck };
  return {
    capability: InboundCapability.PollAcquisition,
    check: pollCheck(dependencies, row),
  };
}

export function inboundInventory(
  dependencies: InboundHealthDependencies,
  tx: Transaction,
): IntakeInventoryEntry[] {
  const entries = allInbounds(tx).map((row) => ({
    project_id: row.project_id,
    name: encodeURIComponent(row.id),
    target: `${INBOUND_TARGET_KIND}:${row.id}`,
    ...checkOf(dependencies, row),
  }));
  assert.equal(
    new Set(entries.map((entry) => entry.target)).size,
    entries.length,
    "Each inbound answers one target.",
  );
  return entries;
}
