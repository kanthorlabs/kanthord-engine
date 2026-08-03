import type { Transaction } from "../../src/services/storage/index.ts";

export const fixtureIds = {
  provider: "provider_a",
  repository: "repo_a",
  project: "project_a",
  profile: "profile_a",
  instructionBlob: `sha256:${"0".repeat(64)}`,
  acceptanceBlob: `sha256:${"1".repeat(64)}`,
  profileBlob: `sha256:${"2".repeat(64)}`,
  planRevision: "revision_a",
  initiative: "initiative_a",
  objective: "objective_a",
  task: "task_a",
  workspace: "workspace_a",
  objectiveRun: "run_a",
  taskRun: "run_b",
  attempt: "attempt_a",
} as const;

export function seedRegistry(transaction: Transaction): void {
  for (const hash of [
    fixtureIds.instructionBlob,
    fixtureIds.acceptanceBlob,
    fixtureIds.profileBlob,
  ]) {
    transaction.run(
      "INSERT INTO blob (hash, size, content, created_at) VALUES (?, ?, ?, ?)",
      [hash, 1, new Uint8Array([0]), 1],
    );
  }

  transaction.run(
    "INSERT INTO provider (id, name, kind, set_default_at, payload_ciphertext, payload_iv, payload_tag, key_version, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [
      fixtureIds.provider,
      "work-anthropic",
      "llm",
      null,
      new Uint8Array([1]),
      new Uint8Array(12),
      new Uint8Array(16),
      1,
      1,
    ],
  );

  transaction.run(
    "INSERT INTO project (id, name, worker, e2e_json, updated_at) VALUES (?, ?, ?, ?, ?)",
    [fixtureIds.project, "kanthord-verify", "general@1", null, 1],
  );

  transaction.run(
    "INSERT INTO repository (id, name, remote_url, credential_id, home_path, upstream_branch, landing_branch, publish_ref, publish_on_approval, state, diverged_landing_oid, diverged_upstream_oid, fetched_upstream_oid, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [
      fixtureIds.repository,
      "kanthord-verify",
      "https://example.invalid/r.git",
      fixtureIds.provider,
      "repos/r.git",
      "main",
      "main",
      "refs/heads/main",
      1,
      "ready",
      null,
      null,
      null,
      1,
    ],
  );

  transaction.run(
    "INSERT INTO project_binding (project_id, kind, target_id, created_at) VALUES (?, ?, ?, ?)",
    [fixtureIds.project, "git", fixtureIds.repository, 1],
  );
}

export function seedGraph(transaction: Transaction): void {
  transaction.run(
    "INSERT INTO plan_revision (id, project_id, parent_id, import_id, submitted_blob, choices_blob, accepted_blob) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [
      fixtureIds.planRevision,
      fixtureIds.project,
      null,
      "imp_a",
      fixtureIds.instructionBlob,
      fixtureIds.instructionBlob,
      fixtureIds.instructionBlob,
    ],
  );

  transaction.run(
    "INSERT INTO node (id, project_id, kind, parent_id, title, instruction_blob, acceptance_blob, worker, repository_id, state, block_reason, discard_reason, revision, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [
      fixtureIds.initiative,
      fixtureIds.project,
      "initiative",
      null,
      "Harden the verify CLI",
      fixtureIds.instructionBlob,
      null,
      null,
      null,
      "pending",
      null,
      null,
      fixtureIds.planRevision,
      1,
    ],
  );

  transaction.run(
    "INSERT INTO node (id, project_id, kind, parent_id, title, instruction_blob, acceptance_blob, worker, repository_id, state, block_reason, discard_reason, revision, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [
      fixtureIds.objective,
      fixtureIds.project,
      "objective",
      fixtureIds.initiative,
      "Harden the verify CLI",
      fixtureIds.instructionBlob,
      null,
      null,
      fixtureIds.repository,
      "pending",
      null,
      null,
      fixtureIds.planRevision,
      1,
    ],
  );

  transaction.run(
    "INSERT INTO node (id, project_id, kind, parent_id, title, instruction_blob, acceptance_blob, worker, repository_id, state, block_reason, discard_reason, revision, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [
      fixtureIds.task,
      fixtureIds.project,
      "task",
      fixtureIds.objective,
      "Harden the verify CLI",
      fixtureIds.instructionBlob,
      fixtureIds.acceptanceBlob,
      null,
      null,
      "pending",
      null,
      null,
      fixtureIds.planRevision,
      1,
    ],
  );
}

export function seedExecution(transaction: Transaction): void {
  transaction.run(
    "INSERT INTO workspace (id, node_id, repository_id, path, clone_base_oid, upstream_oid_at_clone, profile_blob, convention_version, ambient_blob, state, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [
      fixtureIds.workspace,
      fixtureIds.objective,
      fixtureIds.repository,
      "workspaces/objective_a",
      "a".repeat(40),
      "a".repeat(40),
      fixtureIds.profileBlob,
      "coding/v1",
      null,
      "ready",
      1,
    ],
  );

  transaction.run(
    "INSERT INTO run (id, kind, node_id, parent_run_id, workspace_id, worker, lease_fence, attempt_limit, base_oid, head_oid, state, outcome, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [
      fixtureIds.objectiveRun,
      "objective",
      fixtureIds.objective,
      null,
      fixtureIds.workspace,
      "general@1",
      1,
      3,
      "a".repeat(40),
      null,
      "active",
      null,
      null,
    ],
  );

  transaction.run(
    "INSERT INTO run (id, kind, node_id, parent_run_id, workspace_id, worker, lease_fence, attempt_limit, base_oid, head_oid, state, outcome, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [
      fixtureIds.taskRun,
      "task",
      fixtureIds.task,
      fixtureIds.objectiveRun,
      fixtureIds.workspace,
      "general@1",
      1,
      3,
      "a".repeat(40),
      null,
      "active",
      null,
      null,
    ],
  );

  transaction.run(
    "INSERT INTO attempt (id, run_id, attempt_no, provider_id, provider_model, timeout_ms, base_oid, head_oid, outcome, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [
      fixtureIds.attempt,
      fixtureIds.taskRun,
      1,
      fixtureIds.provider,
      "claude-opus-5",
      60000,
      "a".repeat(40),
      null,
      null,
      null,
    ],
  );
}
