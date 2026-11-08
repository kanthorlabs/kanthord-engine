import type { Transaction } from "../kernel/store.ts";
import { canonicalJSON } from "../kernel/json.ts";
import { createIdentity } from "../kernel/identity.ts";
import { PROPOSAL_IDENTITY_PREFIX } from "./contract.ts";
import { trustedLinksOf } from "./link-update-read.ts";
import {
  holdsFollowupLink,
  insertProposal,
  listTerminalNodesLinking,
} from "./proposal-store.ts";
import type { Dependencies } from "./service.ts";
import { readCurrentRevision } from "./store.ts";

export function openFollowups(
  tx: Transaction,
  dependencies: Dependencies,
  missionId: string,
  externalLink: string,
  actorId: string,
  now: number,
): void {
  for (const node of listTerminalNodesLinking(tx, missionId, externalLink)) {
    if (holdsFollowupLink(tx, node.id)) continue;
    const revision = readCurrentRevision(tx, node.id);
    if (revision === null) continue;
    const trusted = trustedLinksOf(tx, dependencies.bindings, revision).some(
      (link) =>
        link.external_link === externalLink && link.actor_ids.includes(actorId),
    );
    if (!trusted) continue;
    insertProposal(tx, {
      id: createIdentity(PROPOSAL_IDENTITY_PREFIX),
      node_id: node.id,
      attempt: node.attempt,
      assessment_id: null,
      content: canonicalJSON({ node_revision: revision.revision }),
      created_node_id: null,
      approved_at: null,
      rejected_at: null,
      created_at: now,
    });
  }
}
