import { identitySchema } from "../kernel/identity.ts";
import type { Transaction } from "../kernel/store.ts";
import {
  NODE_LIST_LIMIT_DEFAULT,
  PROPOSAL_IDENTITY_PREFIX,
  proposalContentSchema,
  proposalSchema,
  type Proposal,
} from "./contract.ts";
import { requireRunnable } from "./control.ts";
import { decode, encode, invalidCursor, requireNode } from "./node-read.ts";
import { recordNotFound } from "./record-list.ts";
import {
  listProposals,
  readProposal,
  type ProposalRow,
} from "./proposal-store.ts";

const SLICE_FROM_START = 0;
const PAGINATION_LOOKAHEAD = 1;
const LAST_ITEM_OFFSET = 1;

export function proposalRecord(row: ProposalRow): Proposal {
  return proposalSchema.parse({
    ...row,
    content: proposalContentSchema.parse(JSON.parse(row.content)),
  });
}

export function requireProposal(tx: Transaction, id: string): ProposalRow {
  const row = readProposal(tx, id);
  if (row === null) recordNotFound();
  return row;
}

export function proposalPage(
  tx: Transaction,
  nodeId: string,
  query: { attempt?: number; limit?: number; cursor?: string },
) {
  requireRunnable(requireNode(tx, nodeId));
  const after = query.cursor === undefined ? null : decode(query.cursor);
  if (
    after !== null &&
    !identitySchema(PROPOSAL_IDENTITY_PREFIX).safeParse(after).success
  )
    invalidCursor();
  const limit = query.limit ?? NODE_LIST_LIMIT_DEFAULT;
  const rows = listProposals(
    tx,
    nodeId,
    query.attempt ?? null,
    after,
    limit + PAGINATION_LOOKAHEAD,
  );
  const items = rows.slice(SLICE_FROM_START, limit).map(proposalRecord);
  return {
    items,
    next_cursor:
      rows.length > limit ? encode(items.at(-LAST_ITEM_OFFSET)!.id) : null,
  };
}
