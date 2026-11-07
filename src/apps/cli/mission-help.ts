import type { ControlResult, NodeChange } from "../../mission/contract.ts";

export const RESUME_HELP = `
Notes:
  The body field "target" takes "Available" (default) or "Waiting".
  "Waiting" sends the node to review with no coder run and uses one round of rework_limit.
  Resume keeps the pinned revision and the consecutive failure count.
`;

export const BLOCK_HELP = `
Notes:
  Block closes the open attempt of a Paused node.
`;

export const UNBLOCK_HELP = `
Notes:
  The optional "change" holds a full revision.
  The unblock opens the next attempt on the revision left current.
  "start_point" takes "node_branch" (default) or "base_branch".
`;

export const OVERRIDE_HELP = `
Notes:
  An override from a Paused node with an open pull request does not merge it.
  Give "landed_commit" when a human merged the change.
`;

export const REVISION_HELP = `
Notes:
  A new revision does not reach an open attempt.
  Use block, then unblock with "change".
`;

function note(
  attempt: number,
  nodeId: string,
  kept: number,
  applied: number,
): string {
  return `note: attempt ${attempt} of ${nodeId} keeps revision ${kept}; block, then unblock with change, to apply revision ${applied}\n`;
}

export function nodeChangeNotes(change: NodeChange): void {
  for (const open of change.open_attempts_unchanged) {
    const revision = change.revisions.find(
      (candidate) => candidate.node_id === open.node_id,
    );
    const kept = revision?.change.previous_revision;
    if (revision === undefined || kept === null || kept === undefined) continue;
    process.stderr.write(
      note(open.attempt, open.node_id, kept, revision.revision),
    );
  }
}

export function resumeNote(result: ControlResult): void {
  const { attempt, node } = result;
  if (attempt === null || attempt.node_revision >= node.visible_revision)
    return;
  process.stderr.write(
    note(
      attempt.attempt,
      node.id,
      attempt.node_revision,
      node.visible_revision,
    ),
  );
}
