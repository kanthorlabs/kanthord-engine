import assert from "node:assert/strict";
import { z } from "zod";
import type { Context } from "../kernel/context.ts";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import type { Transaction } from "../kernel/store.ts";
import { IntakeErrorCode } from "../intake/contract.ts";
import { authorizeBinding } from "./authorization.ts";
import {
  type AdmissionAnswer,
  Disposition,
  type ExternalLink,
  externalLinksSchema,
  type MissionBindings,
} from "./contract.ts";
import type { Dependencies } from "./service.ts";
import type { RevisionRow } from "./store.ts";

const NO_COUNT = 0;
const COUNT_STEP = 1;
const bindingIdsSchema = z.array(z.string());

export interface PinnedLink {
  external_link: ExternalLink;
  binding_id: string;
}

export interface LinkUpdateCount {
  external_link: ExternalLink;
  admitted: number;
  duplicate: number;
  refused: number;
}

export function pinnedLinksOf(
  tx: Transaction,
  bindings: MissionBindings,
  revision: RevisionRow,
): PinnedLink[] {
  const pinned = bindingIdsSchema
    .parse(JSON.parse(revision.bindings))
    .map((bindingId) => bindings.getBindingRevision(tx, bindingId))
    .filter((binding) => binding !== null);
  return externalLinksSchema
    .parse(JSON.parse(revision.external_links))
    .map((link) => {
      const binding = pinned.find(
        (candidate) => candidate.resource_identity === link.resource_identity,
      );
      assert.ok(binding, "A link resource has a pinned binding.");
      authorizeBinding(tx, bindings, binding.binding_id);
      return { external_link: link, binding_id: binding.binding_id };
    });
}

export function requireInbounds(
  tx: Transaction,
  dependencies: Pick<Dependencies, "intakeLinks">,
  projectId: string,
  links: readonly PinnedLink[],
): void {
  for (const { external_link: link } of links)
    if (
      !dependencies.intakeLinks.hasInbound(
        tx,
        projectId,
        link.resource_identity,
      )
    )
      throw new OperationError(
        HttpStatus.Conflict,
        IntakeErrorCode.LinkInboundMissing,
        "The link resource has no inbound.",
        { external_link: link },
      );
}

function countOf(count: LinkUpdateCount, answer: AdmissionAnswer | null): void {
  if (answer?.disposition === Disposition.AcceptedObservation)
    count.admitted += COUNT_STEP;
  else if (answer?.disposition === Disposition.Refused)
    count.refused += COUNT_STEP;
  else count.duplicate += COUNT_STEP;
}

export async function admitLinkUpdates(
  dependencies: Pick<Dependencies, "intakeLinks">,
  context: Context,
  projectId: string,
  links: readonly PinnedLink[],
): Promise<LinkUpdateCount[]> {
  const counts: LinkUpdateCount[] = [];
  for (const link of links) {
    const { items } = await dependencies.intakeLinks.read(context, {
      project_id: projectId,
      external_link: link.external_link,
      binding_id: link.binding_id,
    });
    const count: LinkUpdateCount = {
      external_link: link.external_link,
      admitted: NO_COUNT,
      duplicate: NO_COUNT,
      refused: NO_COUNT,
    };
    const ids = items.map((item) => item.inbound_event_id);
    try {
      for (const id of ids)
        countOf(count, await dependencies.intakeLinks.handoff(context, id));
    } finally {
      dependencies.intakeLinks.releaseHeld(ids);
    }
    counts.push(count);
  }
  return counts;
}
