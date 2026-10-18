const MISSION_VERSION = 1;
const REVISION = 1;
const PLAN_CONTENT = {
  name: "Add login",
  requirement: "Users sign in with a password.",
  criterion: "A user signs in with a valid password.",
  verifications: ["pnpm test"],
  bindings: ["main-repo"],
};
const PLAN_FILENAME = "add-login.md";
const NODE_WRITE = {
  filename: PLAN_FILENAME,
  content: { ...PLAN_CONTENT, intent: "implement" },
  tasks: [],
  reason: "Describe the reason of the change.",
  expected_mission_version: MISSION_VERSION,
};
const HUMAN_ACT = {
  reason: "Describe the reason of the act.",
  expected_mission_version: MISSION_VERSION,
  expected_state: "Available",
  expected_attempt: 0,
};
const EXECUTION_CONTEXT = {
  execution_id: "execution_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  attempt: 1,
  node_revision: REVISION,
};
const IMPORT_SNAPSHOT = {
  format: "json",
  mission_version: MISSION_VERSION,
  reason: "Describe the reason of the import.",
  entries: [{ filename: PLAN_FILENAME, ...PLAN_CONTENT, intent: "implement" }],
};
const SHA256 =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const GRAPH_EDIT = {
  reason: "Describe the reason of the edit.",
  expected_mission_version: MISSION_VERSION,
};

export const IMPORT_MARKDOWN_NOTE =
  "For format markdown, pass the plan files as arguments and leave out entries.";

export const missionExamples = {
  nodeCheck: { expected_mission_version: MISSION_VERSION },
  ready: HUMAN_ACT,
  pause: HUMAN_ACT,
  discard: HUMAN_ACT,
  block: { ...HUMAN_ACT, expected_state: "Paused" },
  resume: { ...HUMAN_ACT, expected_state: "Paused", target: "Available" },
  unblock: {
    blocked_attempt: 1,
    expected_revision: REVISION,
    expected_mission_version: MISSION_VERSION,
  },
  override: { ...HUMAN_ACT, expected_state: "Evaluating" },
  nodeCreate: NODE_WRITE,
  nodeUpdate: { ...NODE_WRITE, expected_revision: REVISION },
  rebind: GRAPH_EDIT,
  prioritySet: { value: 10, expected_mission_version: MISSION_VERSION },
  graphEdit: GRAPH_EDIT,
  criterionSet: {
    criterion: PLAN_CONTENT.criterion,
    verifications: PLAN_CONTENT.verifications,
    reason: "Describe the reason of the change.",
    expected_revision: REVISION,
    expected_mission_version: MISSION_VERSION,
  },
  retire: {
    reason: "Describe the reason of the retirement.",
    expected_mission_version: MISSION_VERSION,
    preview_digest: SHA256,
  },
  importPreview: IMPORT_SNAPSHOT,
  importApply: {
    ...IMPORT_SNAPSHOT,
    preview_digest: SHA256,
    confirmed_retirements: [],
  },
  evidenceSubmit: {
    ...EXECUTION_CONTEXT,
    subject: "Test report",
    assets: [
      {
        kind: "produced",
        content: {
          media_type: "text/plain",
          encoding: "base64",
          data: "cGFzcw==",
        },
      },
    ],
  },
  assessmentSubmit: {
    ...EXECUTION_CONTEXT,
    evidence_ids: ["evidence_01ARZ3NDEKTSV4RRFFQ69G5FAV"],
    dependency_outcome_ids: [],
    result: "success",
    rationale: "Describe why the evidence meets the criterion.",
    tested_input: {
      kind: "repository",
      binding_id: "binding_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      commit: COMMIT,
    },
  },
  proposalApprove: { expected_mission_version: MISSION_VERSION },
};
