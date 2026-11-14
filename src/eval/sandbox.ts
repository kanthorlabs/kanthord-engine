import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import {
  gatewayFixture,
  humanCaller,
  provisionNativeAgent,
  provisionRepositoryCredentials,
  provisionWorkerProject,
} from "../apps/server/test-support.ts";
import { CodedError } from "../kernel/errors.ts";
import { type Operation, OperationRegistry } from "../kernel/operation.ts";
import { ImportFormat, missionOperations } from "../mission/contract.ts";
import { ensureClosedAttempts, seedEvidence } from "../mission/test-support.ts";
import { projectOperations } from "../project/contract.ts";
import { schedulerOperations } from "../scheduler/contract.ts";
import { ageJob, seedExecutionRefusal } from "../scheduler/test-support.ts";
import {
  type WorkbenchConfiguration,
  workbenchOperations,
} from "../workbench/contract.ts";
import type { WorkbenchModelRuntimeFactory } from "../workbench/index.ts";
import {
  ApprovalAnswer,
  type Case,
  EVAL_DIRECTORY,
  type FixtureEntry,
  type FixtureIds,
  type LoadedCase,
  type PlaceholderIds,
  resolvePlaceholders,
  SeedStep,
  type SeedStepValue,
} from "./case.ts";
import {
  type Confirmation,
  type Observation,
  observationOf,
  type RunScore,
  scoreRun,
} from "./score.ts";

const SandboxErrorCode = {
  FixtureInvalid: "eval.sandbox.fixture_invalid",
  SeedInvalid: "eval.sandbox.seed_invalid",
} as const;

export const CheckKind = {
  Setup: "setup",
  Seed: "seed",
  Turn: "turn",
} as const;

const FIXTURE_REASON = "eval fixture";
const GENERAL_BINDING = "general";
const SEED_ATTEMPT = 1;
const POLL_INTERVAL_MS = 50;
const TURN_DEADLINE_MS = 300000;
const FIXTURES_DIRECTORY = "fixtures";
const TEXT_MEDIA_PREFIX = "text/";
const TEXT_ENCODING = "utf8";

type GatewayFixture = Awaited<ReturnType<typeof gatewayFixture>>;

export interface SandboxOptions {
  subject: string;
  key: string;
  configuration: WorkbenchConfiguration;
  runtimeFactory?: WorkbenchModelRuntimeFactory;
}

export interface Sandbox {
  subject: string;
  configuration: WorkbenchConfiguration;
  fixture: GatewayFixture;
  call: ReturnType<typeof humanCaller>;
  operation(id: string): Operation;
}

export interface PlayedCase {
  score: RunScore;
  observation: Observation;
}

export async function openSandbox(
  t: TestContext,
  options: SandboxOptions,
): Promise<Sandbox> {
  const registry = new OperationRegistry();
  const fixture = await gatewayFixture(t, {
    registry,
    repositoryConnector: { gitLsRemote: async () => {} },
    workbenchModelRuntimeFactory: options.runtimeFactory,
    agentDirectory: "",
  });
  await provisionRepositoryCredentials(fixture);
  await provisionNativeAgent(fixture, {
    agentName: options.subject,
    key: options.key,
    configuration: options.configuration,
  });
  return {
    subject: options.subject,
    configuration: options.configuration,
    fixture,
    call: humanCaller(fixture),
    operation: (id) => registry.get(id).operation,
  };
}

async function provisionFixture(
  sandbox: Sandbox,
  key: string,
  entries: FixtureEntry[],
): Promise<FixtureIds> {
  const project = await provisionWorkerProject(sandbox.fixture, key, {
    [GENERAL_BINDING]: 0,
  });
  const mission = await sandbox.call(missionOperations.get, {
    params: { project_id: project.id },
    query: {},
    body: null,
  });
  const params = { mission_id: mission.id };
  const body = {
    format: ImportFormat.Json,
    mission_id: mission.id,
    mission_version: mission.version,
    reason: FIXTURE_REASON,
    entries,
  };
  const preview = await sandbox.call(missionOperations["import.preview"], {
    params,
    query: {},
    body,
  });
  if (preview.violations.length)
    throw new CodedError(
      SandboxErrorCode.FixtureInvalid,
      `The fixture ${key} holds violations: ${preview.violations
        .map((violation) => violation.code)
        .join(", ")}.`,
    );
  const result = await sandbox.call(missionOperations["import.apply"], {
    params,
    query: {},
    body: {
      ...body,
      preview_digest: preview.preview_digest,
      confirmed_retirements: preview.retirements,
    },
  });
  const nodes = Object.fromEntries(
    result.assigned_ids.flatMap((item) =>
      "node_id" in item ? [[item.filename, item.node_id]] : [],
    ),
  );
  return { project_id: project.id, nodes, evidence: {} };
}

function failureDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function runSetup(
  sandbox: Sandbox,
  steps: Case["setup"],
): Promise<string | null> {
  for (const step of steps)
    try {
      await sandbox.call(sandbox.operation(step.operation_id), step.input);
    } catch (error) {
      return `${step.operation_id}: ${failureDetail(error)}`;
    }
  return null;
}

function locate(ids: PlaceholderIds, nodeId: string) {
  for (const [key, fixture] of Object.entries(ids))
    for (const [filename, id] of Object.entries(fixture.nodes))
      if (id === nodeId) return { key, filename, fixture };
  throw new CodedError(
    SandboxErrorCode.SeedInvalid,
    `The seed step names no fixture node: ${nodeId}.`,
  );
}

function assetBytes(
  sandbox: Sandbox,
  file: string,
  media: string,
  ids: PlaceholderIds,
) {
  const bytes = readFileSync(
    join(EVAL_DIRECTORY, sandbox.subject, FIXTURES_DIRECTORY, file),
  );
  if (!media.startsWith(TEXT_MEDIA_PREFIX)) return bytes;
  return Buffer.from(
    resolvePlaceholders(bytes.toString(TEXT_ENCODING), ids),
    TEXT_ENCODING,
  );
}

async function workerBinding(sandbox: Sandbox, projectId: string) {
  const bindings = await sandbox.call(projectOperations["binding.list"], {
    params: { project_id: projectId },
    query: {},
    body: null,
  });
  const binding = bindings.items.find(
    (item) => item.name === GENERAL_BINDING && item.removed_at === null,
  );
  if (!binding)
    throw new CodedError(
      SandboxErrorCode.SeedInvalid,
      "The fixture project holds no general worker binding.",
    );
  return binding;
}

async function seedRefusal(
  sandbox: Sandbox,
  step: Extract<SeedStepValue, { step: typeof SeedStep.ExecutionRefusal }>,
  ids: PlaceholderIds,
): Promise<void> {
  const { fixture } = locate(ids, step.node);
  const binding = await workerBinding(sandbox, fixture.project_id);
  ensureClosedAttempts(sandbox.fixture.store, step.node, SEED_ATTEMPT);
  const executionId = seedExecutionRefusal(sandbox.fixture.store, {
    project_id: fixture.project_id,
    node_id: step.node,
    worker_binding_id: binding.id,
    resource_identity: binding.resource_identity,
    attempt: SEED_ATTEMPT,
    agent: step.agent,
    code: step.code,
  });
  const listed = await sandbox.call(schedulerOperations.executionList, {
    params: { project_id: fixture.project_id },
    query: { node_id: step.node },
    body: null,
  });
  const credential = listed.items.find(
    (item) => item.execution_id === executionId,
  )?.agent_selections[0]?.credential;
  if (credential !== step.credential)
    throw new CodedError(
      SandboxErrorCode.SeedInvalid,
      `The agent ${step.agent} resolves another credential than ${step.credential}.`,
    );
}

function seedEvidenceStep(
  sandbox: Sandbox,
  step: Extract<SeedStepValue, { step: typeof SeedStep.Evidence }>,
  ids: PlaceholderIds,
): void {
  const { key, filename } = locate(ids, step.node);
  const seeded = seedEvidence(sandbox.fixture.store, {
    node_id: step.node,
    attempt: step.attempt,
    assets: step.assets.map((asset) => ({
      media_type: asset.media_type,
      bytes: assetBytes(sandbox, asset.file, asset.media_type, ids),
    })),
  });
  ids[key]!.evidence[filename] = {
    id: seeded.evidence_id,
    assets: seeded.asset_ids,
  };
}

async function seedStep(
  sandbox: Sandbox,
  step: SeedStepValue,
  ids: PlaceholderIds,
): Promise<void> {
  if (step.step === SeedStep.ExecutionRefusal)
    await seedRefusal(sandbox, step, ids);
  if (step.step === SeedStep.Evidence) seedEvidenceStep(sandbox, step, ids);
  if (step.step === SeedStep.JobWithoutTaker)
    ageJob(sandbox.fixture.store, step.node, Date.now() - step.age_ms);
}

interface Tally {
  confirmations: Confirmation[];
  answered: Set<string>;
  unexpected: boolean;
}

async function answerPending(
  sandbox: Sandbox,
  sessionId: string,
  approvals: Case["turns"][number]["approvals"],
  tally: Tally,
): Promise<void> {
  const listed = await sandbox.call(workbenchOperations["session.list"], {
    params: {},
    query: { agent_name: sandbox.subject },
    body: null,
  });
  const pending = listed.items.find(
    (item) => item.id === sessionId,
  )?.pending_approval;
  if (!pending || tally.answered.has(pending.tool_call_id)) return;
  const named = approvals[pending.operation_id];
  const answer = named ?? ApprovalAnswer.Reject;
  if (!named) tally.unexpected = true;
  tally.answered.add(pending.tool_call_id);
  await sandbox.call(workbenchOperations["session.approve"], {
    params: { session_id: sessionId },
    query: {},
    body: {
      tool_call_id: pending.tool_call_id,
      approved: answer === ApprovalAnswer.Approve,
    },
  });
  tally.confirmations.push({
    operation_id: pending.operation_id,
    tool_call_id: pending.tool_call_id,
    answer,
  });
}

async function settleTurn(
  sandbox: Sandbox,
  sessionId: string,
  approvals: Case["turns"][number]["approvals"],
  tally: Tally,
): Promise<boolean> {
  const deadline = Date.now() + TURN_DEADLINE_MS;
  while (Date.now() < deadline) {
    const session = await sandbox.call(workbenchOperations["session.get"], {
      params: { session_id: sessionId },
      query: {},
      body: null,
    });
    if (!session.run_active) return true;
    await answerPending(sandbox, sessionId, approvals, tally);
    await sleep(POLL_INTERVAL_MS);
  }
  return false;
}

export async function runTurns(
  sandbox: Sandbox,
  run: Pick<Case, "turns" | "checks">,
): Promise<PlayedCase> {
  const created = await sandbox.call(workbenchOperations["session.create"], {
    params: {},
    query: {},
    body: { agent_name: sandbox.subject, ...sandbox.configuration },
  });
  const params = { session_id: created.id };
  const tally: Tally = {
    confirmations: [],
    answered: new Set(),
    unexpected: false,
  };
  let timedOut = false;
  for (const turn of run.turns) {
    await sandbox.call(workbenchOperations["session.message"], {
      params,
      query: {},
      body: { text: turn.human },
    });
    timedOut = !(await settleTurn(sandbox, created.id, turn.approvals, tally));
    if (timedOut) break;
  }
  if (timedOut)
    await sandbox.call(workbenchOperations["session.abort"], {
      params,
      query: {},
      body: null,
    });
  const final = await sandbox.call(workbenchOperations["session.get"], {
    params,
    query: {},
    body: null,
  });
  const observation: Observation = {
    ...observationOf(final.entries),
    confirmations: tally.confirmations,
    unexpected_approval: tally.unexpected,
  };
  const score = await scoreRun(run.checks, observation, (id, input) =>
    sandbox.call(sandbox.operation(id), input),
  );
  if (!timedOut) return { score, observation };
  return {
    score: {
      passed: false,
      checks: [
        {
          kind: CheckKind.Turn,
          passed: false,
          detail: "A turn did not finish before the deadline.",
        },
        ...score.checks,
      ],
    },
    observation,
  };
}

function failedPlay(kind: string, detail: string): PlayedCase {
  return {
    score: { passed: false, checks: [{ kind, passed: false, detail }] },
    observation: {
      ...observationOf([]),
      confirmations: [],
      unexpected_approval: false,
    },
  };
}

export async function playCase(
  sandbox: Sandbox,
  loaded: LoadedCase,
): Promise<PlayedCase> {
  const ids: PlaceholderIds = {};
  for (const key of Object.keys(loaded.fixtures).sort())
    ids[key] = await provisionFixture(
      sandbox,
      key,
      loaded.fixture_entries[key]!,
    );
  const setup = await runSetup(sandbox, resolvePlaceholders(loaded.setup, ids));
  if (setup) return failedPlay(CheckKind.Setup, setup);
  for (const step of loaded.seed)
    try {
      await seedStep(sandbox, resolvePlaceholders(step, ids), ids);
    } catch (error) {
      return failedPlay(CheckKind.Seed, failureDetail(error));
    }
  return runTurns(
    sandbox,
    resolvePlaceholders({ turns: loaded.turns, checks: loaded.checks }, ids),
  );
}
