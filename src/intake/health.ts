import assert from "node:assert/strict";
import type { ServiceIdentity } from "../kernel/caller.ts";
import { throwIfCancelled } from "../kernel/context.ts";
import { OperationError } from "../kernel/errors.ts";
import { ResourceStatus, type ResourceCheck } from "../kernel/health.ts";
import type { Store, Transaction } from "../kernel/store.ts";
import type { GitHubPlatform } from "../repository/github.ts";
import type { IntakeCustody } from "./action-check.ts";
import { InboundKind, type IntakeInventoryEntry } from "./contract.ts";
import { allInbounds, type InboundRow } from "./inbound-store.ts";
import {
  pollTargetOf,
  releasePollGrant,
  requestPollEvents,
  type Hold,
  type PollTarget,
} from "./poll.ts";

const NO_LENGTH = 0;

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
  github: Pick<GitHubPlatform, "listEvents">;
}

const webhookCheck: ResourceCheck = async () => ResourceStatus.Unknown;

function releaseRefusal(
  dependencies: InboundHealthDependencies,
  target: PollTarget,
  hold: Hold,
): string | null {
  assert.equal(hold.material, null, "A check releases once.");
  assert.ok(target.facts.inboundId.length > NO_LENGTH);
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

function pollCheck(
  dependencies: InboundHealthDependencies,
  target: PollTarget,
): ResourceCheck {
  assert.ok(target.owner.length > NO_LENGTH, "A target names an owner.");
  assert.ok(target.repo.length > NO_LENGTH, "A target names a repository.");
  return async (context, observe) => {
    throwIfCancelled(context);
    const hold: Hold = { material: null };
    try {
      const refusal = releaseRefusal(dependencies, target, hold);
      if (refusal !== null) {
        observe?.(refusal);
        return ResourceStatus.Unhealthy;
      }
      assert.ok(hold.material, "A committed release holds the material.");
      const answer = await requestPollEvents(dependencies.github, {
        requester: dependencies.identity,
        context,
        material: hold.material,
        owner: target.owner,
        repo: target.repo,
        etag: target.checkpoint.etag,
      });
      throwIfCancelled(context);
      if (answer.ok) return ResourceStatus.Healthy;
      observe?.(answer.code);
      return ResourceStatus.Unhealthy;
    } finally {
      hold.material?.drop();
    }
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
    check: pollCheck(dependencies, pollTargetOf(row)),
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
