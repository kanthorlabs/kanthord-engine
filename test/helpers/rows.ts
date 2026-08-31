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

  const repositoryColumns = transaction.all(
    "PRAGMA table_info(repository)",
  ) as readonly Readonly<Record<string, unknown>>[];
  const carriesLegacyBranches = repositoryColumns.some(
    (column) => column.name === "upstream_branch",
  );
  transaction.run(
    carriesLegacyBranches
      ? "INSERT INTO repository (id, name, remote_url, credential_id, home_path, upstream_branch, landing_branch, publish_ref, publish_on_approval, state, diverged_landing_oid, diverged_upstream_oid, fetched_upstream_oid, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      : "INSERT INTO repository (id, name, remote_url, credential_id, home_path, branch, publish_on_approval, state, diverged_landing_oid, diverged_upstream_oid, fetched_upstream_oid, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    carriesLegacyBranches
      ? [
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
        ]
      : [
          fixtureIds.repository,
          "kanthord-verify",
          "https://example.invalid/r.git",
          fixtureIds.provider,
          "repos/r.git",
          "main",
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
  const columns = transaction.all(
    "PRAGMA table_info(plan_revision)",
  ) as readonly Readonly<Record<string, unknown>>[];
  const carriesOrigin = columns.some((column) => column.name === "origin");
  const values = [
    fixtureIds.planRevision,
    fixtureIds.project,
    null,
    "imp_a",
    fixtureIds.instructionBlob,
    fixtureIds.instructionBlob,
    fixtureIds.instructionBlob,
  ];
  transaction.run(
    carriesOrigin
      ? "INSERT INTO plan_revision (id, project_id, parent_id, origin, import_id, submitted_blob, choices_blob, accepted_blob) VALUES (?, ?, ?, 'import', ?, ?, ?, ?)"
      : "INSERT INTO plan_revision (id, project_id, parent_id, import_id, submitted_blob, choices_blob, accepted_blob) VALUES (?, ?, ?, ?, ?, ?, ?)",
    values,
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

export function seedSiblingTask(transaction: Transaction): void {
  transaction.run(
    "INSERT INTO node (id, project_id, kind, parent_id, title, instruction_blob, acceptance_blob, worker, repository_id, state, block_reason, discard_reason, revision, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [
      "task_b",
      fixtureIds.project,
      "task",
      fixtureIds.objective,
      "Second task",
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

export function seedSiblingObjective(transaction: Transaction): void {
  transaction.run(
    "INSERT INTO node (id, project_id, kind, parent_id, title, instruction_blob, acceptance_blob, worker, repository_id, state, block_reason, discard_reason, revision, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', NULL, NULL, ?, ?)",
    [
      "objective_sibling",
      fixtureIds.project,
      "objective",
      fixtureIds.initiative,
      "Sibling objective",
      fixtureIds.instructionBlob,
      null,
      null,
      fixtureIds.repository,
      fixtureIds.planRevision,
      1,
    ],
  );
}

export function seedSecondRevisionWithTask(transaction: Transaction): void {
  const columns = transaction.all(
    "PRAGMA table_info(plan_revision)",
  ) as readonly Readonly<Record<string, unknown>>[];
  const carriesOrigin = columns.some((column) => column.name === "origin");
  const values = [
    "revision_b",
    fixtureIds.project,
    fixtureIds.planRevision,
    "imp_b",
    fixtureIds.instructionBlob,
    fixtureIds.instructionBlob,
    fixtureIds.instructionBlob,
  ];
  transaction.run(
    carriesOrigin
      ? "INSERT INTO plan_revision (id, project_id, parent_id, origin, import_id, submitted_blob, choices_blob, accepted_blob) VALUES (?, ?, ?, 'import', ?, ?, ?, ?)"
      : "INSERT INTO plan_revision (id, project_id, parent_id, import_id, submitted_blob, choices_blob, accepted_blob) VALUES (?, ?, ?, ?, ?, ?, ?)",
    values,
  );

  transaction.run(
    "INSERT INTO node (id, project_id, kind, parent_id, title, instruction_blob, acceptance_blob, worker, repository_id, state, block_reason, discard_reason, revision, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [
      "task_b",
      fixtureIds.project,
      "task",
      fixtureIds.objective,
      "Second task",
      fixtureIds.instructionBlob,
      fixtureIds.acceptanceBlob,
      null,
      null,
      "pending",
      null,
      null,
      "revision_b",
      1,
    ],
  );
}

export function seedNodeState(
  transaction: Transaction,
  id: string,
  state: string,
): void {
  transaction.run(
    "UPDATE node SET state = ?, block_reason = CASE WHEN ? = 'blocked' THEN 'abandoned' ELSE NULL END WHERE id = ?",
    [state, state, id],
  );
}

export function seedNodeWorker(
  transaction: Transaction,
  id: string,
  worker: string | null,
): void {
  transaction.run("UPDATE node SET worker = ? WHERE id = ?", [worker, id]);
}

export function seedNodeBlockReason(
  transaction: Transaction,
  id: string,
  blockReason: string | null,
): void {
  transaction.run("UPDATE node SET block_reason = ? WHERE id = ?", [
    blockReason,
    id,
  ]);
}

export function seedNode(
  transaction: Transaction,
  input: Readonly<{
    id: string;
    kind: string;
    parentId: string | null;
    title: string;
    state: string;
    acceptanceBlob?: string | null;
    worker?: string | null;
    repositoryId?: string | null;
  }>,
): void {
  transaction.run(
    "INSERT INTO node (id, project_id, kind, parent_id, title, instruction_blob, acceptance_blob, worker, repository_id, state, block_reason, discard_reason, revision, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)",
    [
      input.id,
      fixtureIds.project,
      input.kind,
      input.parentId,
      input.title,
      fixtureIds.instructionBlob,
      input.acceptanceBlob ?? null,
      input.worker ?? null,
      input.repositoryId ?? null,
      input.state,
      fixtureIds.planRevision,
      1,
    ],
  );
}

export function seedNodeWithDeliverable(
  transaction: Transaction,
  input: Readonly<{
    id: string;
    kind: string;
    parentId: string | null;
    title: string;
    deliverable: string;
    verifyJson?: string | null;
  }>,
): void {
  transaction.run(
    "INSERT INTO node (id, project_id, kind, parent_id, title, instruction_blob, acceptance_blob, worker, repository_id, state, block_reason, discard_reason, revision, updated_at, deliverable, verify_json, assignment) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, 'pending', NULL, NULL, ?, ?, ?, ?, NULL)",
    [
      input.id,
      fixtureIds.project,
      input.kind,
      input.parentId,
      input.title,
      fixtureIds.instructionBlob,
      input.kind === "task" ? fixtureIds.acceptanceBlob : null,
      input.kind === "objective" ? fixtureIds.repository : null,
      fixtureIds.planRevision,
      1,
      input.deliverable,
      input.verifyJson ?? null,
    ],
  );
}

export function seedEdge(
  transaction: Transaction,
  input: Readonly<{ id: string; fromNode: string; toNode: string }>,
): void {
  transaction.run(
    "INSERT INTO edge (id, from_node, to_node, waived_at) VALUES (?, ?, ?, NULL)",
    [input.id, input.fromNode, input.toNode],
  );
}

export function probeNodeTitle(
  transaction: Transaction,
  input: Readonly<{ id: string; title: string }>,
): void {
  transaction.run("UPDATE node SET title = ? WHERE id = ?", [
    input.title,
    input.id,
  ]);
}

const SECOND_PROJECT_NODES = [
  {
    id: "initiative_pb",
    kind: "initiative",
    parentId: null,
    title: "Second project initiative",
    acceptanceBlob: null,
    repositoryId: null,
  },
  {
    id: "objective_pb",
    kind: "objective",
    parentId: "initiative_pb",
    title: "Second project objective",
    acceptanceBlob: null,
    repositoryId: fixtureIds.repository,
  },
  {
    id: "task_pb",
    kind: "task",
    parentId: "objective_pb",
    title: "Second project task",
    acceptanceBlob: fixtureIds.acceptanceBlob,
    repositoryId: null,
  },
] as const;

export function seedSecondProjectGraph(transaction: Transaction): void {
  const columns = transaction.all(
    "PRAGMA table_info(plan_revision)",
  ) as readonly Readonly<Record<string, unknown>>[];
  const carriesOrigin = columns.some((column) => column.name === "origin");
  transaction.run(
    "INSERT INTO project (id, name, worker, e2e_json, updated_at) VALUES (?, ?, ?, ?, ?)",
    ["project_b", "kanthord-verify-b", "general@1", null, 1],
  );
  const values = [
    "revision_pb",
    "project_b",
    null,
    "imp_pb",
    fixtureIds.instructionBlob,
    fixtureIds.instructionBlob,
    fixtureIds.instructionBlob,
  ];
  transaction.run(
    carriesOrigin
      ? "INSERT INTO plan_revision (id, project_id, parent_id, origin, import_id, submitted_blob, choices_blob, accepted_blob) VALUES (?, ?, ?, 'import', ?, ?, ?, ?)"
      : "INSERT INTO plan_revision (id, project_id, parent_id, import_id, submitted_blob, choices_blob, accepted_blob) VALUES (?, ?, ?, ?, ?, ?, ?)",
    values,
  );
  for (const node of SECOND_PROJECT_NODES) {
    transaction.run(
      "INSERT INTO node (id, project_id, kind, parent_id, title, instruction_blob, acceptance_blob, worker, repository_id, state, block_reason, discard_reason, revision, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', NULL, NULL, ?, ?)",
      [
        node.id,
        "project_b",
        node.kind,
        node.parentId,
        node.title,
        fixtureIds.instructionBlob,
        node.acceptanceBlob,
        null,
        node.repositoryId,
        "revision_pb",
        1,
      ],
    );
  }
}

const LIST_FILTER_PROJECT_B_NODES = [
  {
    id: "initiative_pb",
    kind: "initiative",
    parentId: null,
    repositoryId: null,
    state: "pending",
    blockReason: null,
  },
  {
    id: "objective_pb",
    kind: "objective",
    parentId: "initiative_pb",
    repositoryId: "repo_b",
    state: "ready",
    blockReason: null,
  },
  {
    id: "task_pb1",
    kind: "task",
    parentId: "objective_pb",
    repositoryId: null,
    state: "ready",
    blockReason: null,
  },
  {
    id: "task_pb2",
    kind: "task",
    parentId: "objective_pb",
    repositoryId: null,
    state: "ready",
    blockReason: null,
  },
] as const;

export function seedListFilterFixture(transaction: Transaction): void {
  seedRegistry(transaction);
  seedGraph(transaction);
  transaction.run(
    "INSERT INTO repository (id, name, remote_url, credential_id, home_path, branch, publish_on_approval, state, diverged_landing_oid, diverged_upstream_oid, fetched_upstream_oid, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [
      "repo_b",
      "second",
      "https://example.invalid/r2.git",
      fixtureIds.provider,
      "repos/r2.git",
      "main",
      1,
      "ready",
      null,
      null,
      null,
      1,
    ],
  );
  transaction.run(
    "INSERT INTO project (id, name, worker, e2e_json, updated_at) VALUES (?, ?, ?, ?, ?)",
    ["project_b", "second-project", "general@1", null, 1],
  );
  for (const node of LIST_FILTER_PROJECT_B_NODES) {
    transaction.run(
      "INSERT INTO node (id, project_id, kind, parent_id, title, instruction_blob, acceptance_blob, worker, repository_id, state, block_reason, discard_reason, revision, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        node.id,
        "project_b",
        node.kind,
        node.parentId,
        "Second project",
        fixtureIds.instructionBlob,
        node.kind === "task" ? fixtureIds.acceptanceBlob : null,
        null,
        node.repositoryId,
        node.state,
        node.blockReason,
        null,
        fixtureIds.planRevision,
        1,
      ],
    );
  }
  transaction.run(
    "INSERT INTO node (id, project_id, kind, parent_id, title, instruction_blob, acceptance_blob, worker, repository_id, state, block_reason, discard_reason, revision, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [
      "task_a2",
      fixtureIds.project,
      "task",
      fixtureIds.objective,
      "Second task",
      fixtureIds.instructionBlob,
      fixtureIds.acceptanceBlob,
      null,
      null,
      "blocked",
      "dirty-recovery",
      null,
      fixtureIds.planRevision,
      1,
    ],
  );
  transaction.run("UPDATE node SET state = 'ready' WHERE id = ?", [
    fixtureIds.objective,
  ]);
  transaction.run("UPDATE node SET state = 'running' WHERE id = ?", [
    fixtureIds.task,
  ]);
}

const EMPTY_OBJECTIVE_NODES = [
  {
    id: "initiative_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    kind: "initiative",
    parentId: null,
    acceptanceBlob: null,
    repositoryId: null,
  },
  {
    id: "objective_01BQZ3NDEKTSV4RRFFQ69G5FAV",
    kind: "objective",
    parentId: "initiative_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    acceptanceBlob: null,
    repositoryId: fixtureIds.repository,
  },
  {
    id: "objective_01FRZ3NDEKTSV4RRFFQ69G5FAW",
    kind: "objective",
    parentId: "initiative_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    acceptanceBlob: null,
    repositoryId: fixtureIds.repository,
  },
  {
    id: "task_01ERZ3NDEKTSV4RRFFQ69G5FAV",
    kind: "task",
    parentId: "objective_01FRZ3NDEKTSV4RRFFQ69G5FAW",
    acceptanceBlob: fixtureIds.acceptanceBlob,
    repositoryId: null,
  },
] as const;

// One project whose first objective holds no task, beside a second complete
// objective under the same initiative. The empty objective is the claim whose
// completeness check must refuse; the complete one stays claimable.
export function seedEmptyObjectiveGraph(transaction: Transaction): void {
  const columns = transaction.all(
    "PRAGMA table_info(plan_revision)",
  ) as readonly Readonly<Record<string, unknown>>[];
  const carriesOrigin = columns.some((column) => column.name === "origin");
  const values = [
    fixtureIds.planRevision,
    fixtureIds.project,
    null,
    "imp_a",
    fixtureIds.instructionBlob,
    fixtureIds.instructionBlob,
    fixtureIds.instructionBlob,
  ];
  transaction.run(
    carriesOrigin
      ? "INSERT INTO plan_revision (id, project_id, parent_id, origin, import_id, submitted_blob, choices_blob, accepted_blob) VALUES (?, ?, ?, 'import', ?, ?, ?, ?)"
      : "INSERT INTO plan_revision (id, project_id, parent_id, import_id, submitted_blob, choices_blob, accepted_blob) VALUES (?, ?, ?, ?, ?, ?, ?)",
    values,
  );
  for (const node of EMPTY_OBJECTIVE_NODES) {
    transaction.run(
      "INSERT INTO node (id, project_id, kind, parent_id, title, instruction_blob, acceptance_blob, worker, repository_id, state, block_reason, discard_reason, revision, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', NULL, NULL, ?, ?)",
      [
        node.id,
        fixtureIds.project,
        node.kind,
        node.parentId,
        "Fixture",
        fixtureIds.instructionBlob,
        node.acceptanceBlob,
        null,
        node.repositoryId,
        fixtureIds.planRevision,
        1,
      ],
    );
  }
}

export function seedWaivedEdge(
  transaction: Transaction,
  input: Readonly<{
    id: string;
    fromNode: string;
    toNode: string;
    waivedAt: number;
  }>,
): void {
  transaction.run(
    "INSERT INTO edge (id, from_node, to_node, waived_at) VALUES (?, ?, ?, ?)",
    [input.id, input.fromNode, input.toNode, input.waivedAt],
  );
}

export function seedWorkspaceOnNode(
  transaction: Transaction,
  input: Readonly<{ id: string; nodeId: string }>,
): void {
  transaction.run(
    "INSERT INTO workspace (id, node_id, repository_id, path, clone_base_oid, upstream_oid_at_clone, profile_blob, convention_version, ambient_blob, state, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [
      input.id,
      input.nodeId,
      fixtureIds.repository,
      `workspaces/${input.id}`,
      "a".repeat(40),
      "a".repeat(40),
      fixtureIds.profileBlob,
      "coding/v1",
      null,
      "ready",
      1,
    ],
  );
}

export function seedLeaseOnNode(
  transaction: Transaction,
  nodeId: string,
): void {
  transaction.run(
    "INSERT INTO lease (subject_kind, subject_id, owner, owner_kind, fence, acquired_at, renewed_at, expires_at) VALUES ('node', ?, ?, 'daemon', 1, 1, 1, 2)",
    [nodeId, "daemon_test"],
  );
}

export function seedReleasedLeaseOnNode(
  transaction: Transaction,
  nodeId: string,
): void {
  transaction.run(
    "INSERT INTO lease (subject_kind, subject_id, owner, fence, acquired_at, renewed_at, expires_at) VALUES ('node', ?, NULL, 1, 1, 1, 2)",
    [nodeId],
  );
}

export function seedRunRow(
  transaction: Transaction,
  input: Readonly<{
    id: string;
    kind: "objective" | "task";
    nodeId: string;
    parentRunId: string | null;
    workspaceId: string;
    state?: "active" | "ended";
  }>,
): void {
  transaction.run(
    "INSERT INTO run (id, kind, node_id, parent_run_id, driver, workspace_id, worker, lease_fence, attempt_limit, base_oid, head_oid, state, outcome, ended_at) VALUES (?, ?, ?, ?, 'internal', ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [
      input.id,
      input.kind,
      input.nodeId,
      input.parentRunId,
      input.workspaceId,
      "general@1",
      1,
      3,
      "a".repeat(40),
      null,
      input.state ?? "active",
      null,
      null,
    ],
  );
}

export function seedAttemptRow(
  transaction: Transaction,
  input: Readonly<{ id: string; runId: string }>,
): void {
  transaction.run(
    "INSERT INTO attempt (id, run_id, driver, attempt_no, provider_id, provider_model, timeout_ms, base_oid, head_oid, outcome, ended_at) VALUES (?, ?, 'internal', ?, ?, ?, ?, ?, ?, ?, ?)",
    [
      input.id,
      input.runId,
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

export function seedCandidateRow(
  transaction: Transaction,
  input: Readonly<{
    id: string;
    nodeId: string;
    runId: string;
    workspaceId: string;
  }>,
): void {
  transaction.run(
    "INSERT INTO candidate (id, node_id, run_id, workspace_id, revision, candidate_oid, landing_base_oid, merge_oid, projected_outcome, evidence_blob, profile_blob, convention_version, state, acknowledged_partial, publish_requested, approved_actor, approved_at, invalidated_at, invalidated_reason, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [
      input.id,
      input.nodeId,
      input.runId,
      input.workspaceId,
      "candidate_revision",
      "b".repeat(40),
      "b".repeat(40),
      null,
      "done",
      fixtureIds.profileBlob,
      fixtureIds.profileBlob,
      "coding/v1",
      "open",
      null,
      null,
      null,
      null,
      null,
      null,
      1,
    ],
  );
}

export function seedCheckResultRow(
  transaction: Transaction,
  input: Readonly<{ id: string; nodeId: string }>,
): void {
  transaction.run(
    "INSERT INTO check_result (id, subject_kind, subject_id, node_id, run_id, commit_oid, manifest_blob, check_name, command_json, cwd, env_identity, toolchain_version, timeout_ms, authoritative, result, exit_code, output_blob, profile_blob, convention_version, invalidated_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [
      input.id,
      "candidate",
      null,
      input.nodeId,
      null,
      "c".repeat(40),
      null,
      "check-lint",
      "{}",
      "repos/r.git",
      "verify",
      "coding/v1",
      60000,
      1,
      "passed",
      0,
      null,
      fixtureIds.profileBlob,
      "coding/v1",
      null,
      null,
    ],
  );
}

export function seedGitOperationRow(
  transaction: Transaction,
  input: Readonly<{ id: string; nodeId: string }>,
): void {
  transaction.run(
    "INSERT INTO git_operation (id, repository_id, intent, node_id, run_id, candidate_id, lease_fence, ref, base_oid, proposed_head_oid, result_head_oid, expected_remote_oid, state, outcome, detail_blob, child_token, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [
      input.id,
      fixtureIds.repository,
      "merge",
      input.nodeId,
      null,
      null,
      1,
      "refs/heads/main",
      "d".repeat(40),
      "d".repeat(40),
      null,
      null,
      "open",
      null,
      null,
      null,
      null,
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
    "INSERT INTO run (id, kind, node_id, parent_run_id, driver, workspace_id, worker, lease_fence, attempt_limit, base_oid, head_oid, state, outcome, ended_at) VALUES (?, ?, ?, ?, 'internal', ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
    "INSERT INTO run (id, kind, node_id, parent_run_id, driver, workspace_id, worker, lease_fence, attempt_limit, base_oid, head_oid, state, outcome, ended_at) VALUES (?, ?, ?, ?, 'internal', ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
    "INSERT INTO attempt (id, run_id, driver, attempt_no, provider_id, provider_model, timeout_ms, base_oid, head_oid, outcome, ended_at) VALUES (?, ?, 'internal', ?, ?, ?, ?, ?, ?, ?, ?)",
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
