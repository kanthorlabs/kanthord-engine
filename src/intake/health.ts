import assert from "node:assert/strict";
import type { InboundGrantInput, Material } from "../custody/contract.ts";
import type { ServiceIdentity } from "../kernel/caller.ts";
import { throwIfCancelled } from "../kernel/context.ts";
import { OperationError } from "../kernel/errors.ts";
import { ResourceStatus, type ResourceCheck } from "../kernel/health.ts";
import type { Store, Transaction } from "../kernel/store.ts";
import {
  GitHubTargetKind,
  repositoryOf,
  type GitHubPlatform,
} from "../repository/github.ts";
import type { IntakeCustody } from "./action-check.ts";
import { configurationSchemaOf } from "./configuration.ts";
import { InboundKind, type IntakeInventoryEntry } from "./contract.ts";
import { allInbounds, type InboundRow } from "./inbound-store.ts";
import { checkpointOf, releasePollGrant, requestPollEvents } from "./poll.ts";

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

interface PollProbe {
  facts: InboundGrantInput;
  owner: string;
  repo: string;
  etag: string | null;
}

interface Hold {
  material: Material | null;
}

const webhookCheck: ResourceCheck = async () => ResourceStatus.Unknown;

function probeOf(row: InboundRow): PollProbe {
  assert.equal(row.kind, InboundKind.Poll, "A probe reads a poll inbound.");
  assert.ok(row.credential !== null, "A poll names a credential.");
  const { resource } = configurationSchemaOf(row.kind, row.platform).parse(
    JSON.parse(row.configuration),
  );
  const { owner, repo } = repositoryOf({
    kind: GitHubTargetKind.Inbound,
    resource,
  });
  return {
    facts: {
      inboundId: row.id,
      projectId: row.project_id,
      credential: row.credential,
      platform: row.platform,
      resource,
    },
    owner,
    repo,
    etag: checkpointOf(row.checkpoint).etag,
  };
}

function releaseRefusal(
  dependencies: InboundHealthDependencies,
  probe: PollProbe,
  hold: Hold,
): string | null {
  assert.equal(hold.material, null, "A check releases once.");
  assert.ok(probe.facts.inboundId.length > NO_LENGTH);
  try {
    dependencies.store.transaction((tx) => {
      hold.material = releasePollGrant(dependencies, tx, probe.facts);
    });
    return null;
  } catch (error) {
    if (!(error instanceof OperationError)) throw error;
    return error.code;
  }
}

function pollCheck(
  dependencies: InboundHealthDependencies,
  probe: PollProbe,
): ResourceCheck {
  assert.ok(probe.owner.length > NO_LENGTH, "A probe names an owner.");
  assert.ok(probe.repo.length > NO_LENGTH, "A probe names a repository.");
  return async (context, observe) => {
    throwIfCancelled(context);
    const hold: Hold = { material: null };
    try {
      const refusal = releaseRefusal(dependencies, probe, hold);
      if (refusal !== null) {
        observe?.(refusal);
        return ResourceStatus.Unhealthy;
      }
      assert.ok(hold.material, "A committed release holds the material.");
      const answer = await requestPollEvents(dependencies.github, {
        requester: dependencies.identity,
        context,
        material: hold.material,
        owner: probe.owner,
        repo: probe.repo,
        etag: probe.etag,
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
    check: pollCheck(dependencies, probeOf(row)),
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
