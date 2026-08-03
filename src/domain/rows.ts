import { agentInvocationRow } from "./agent-invocation.ts";
import { attemptRow } from "./attempt.ts";
import { blobRow } from "./blob.ts";
import { candidateRow } from "./candidate.ts";
import { checkResultRow } from "./check-result.ts";
import { edgeRow } from "./edge.ts";
import { eventRow } from "./event.ts";
import { gitOperationRow } from "./git-operation.ts";
import { leaseRow } from "./lease.ts";
import { migrationRow } from "./migration.ts";
import { nodeRow } from "./node.ts";
import { planRevisionRow } from "./plan-revision.ts";
import { profileRow } from "./profile.ts";
import { projectRow } from "./project.ts";
import { projectBindingRow } from "./project-binding.ts";
import { providerRow } from "./provider.ts";
import { repositoryRow } from "./repository.ts";
import { runRow } from "./run.ts";
import { workspaceRow } from "./workspace.ts";

export const rows = {
  agent_invocation: agentInvocationRow,
  attempt: attemptRow,
  blob: blobRow,
  candidate: candidateRow,
  check_result: checkResultRow,
  edge: edgeRow,
  event: eventRow,
  git_operation: gitOperationRow,
  lease: leaseRow,
  migration: migrationRow,
  node: nodeRow,
  plan_revision: planRevisionRow,
  profile: profileRow,
  project: projectRow,
  project_binding: projectBindingRow,
  provider: providerRow,
  repository: repositoryRow,
  run: runRow,
  workspace: workspaceRow,
} as const;

export type TableName = keyof typeof rows;
