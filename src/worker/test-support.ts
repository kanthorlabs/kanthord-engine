import assert from "node:assert/strict";
import type {
  AgentSetup,
  ExecutionSetup,
  HostTools,
  PlacementStatus,
  PoolEntry,
  PoolHost,
  PoolInstance,
  PoolPlacement,
  SessionRead,
  SessionReadResult,
} from "./contract.ts";
import { getWorkerDeclaration, type WorkerDeclaration } from "./catalog.ts";

export const unusedHostTools: HostTools = {
  evidenceUpload: () =>
    Promise.reject(new Error("Unexpected evidence upload in fixture")),
};
import { ChainLevel, type PromptPartAnswer } from "../agent/contract.ts";
import { framingPart } from "../agent/prompt-files.ts";
import { PromptConsumer } from "../agent/prompt-render.ts";
import {
  SHIPPED_TEMPLATE_SET,
  SHIPPED_TEMPLATES,
} from "../agent/prompt-templates.ts";
import type { AgentPromptFacts } from "./prompt-telemetry.ts";
import {
  alwaysAvailable,
  ExecutionIntent,
  SessionReadOutcome,
} from "./contract.ts";

export const TWO_AGENT_WORKER = "two-agent@1";
export function twoAgentDeclarationOf(name: string): WorkerDeclaration | null {
  if (name !== TWO_AGENT_WORKER) return getWorkerDeclaration(name) ?? null;
  return {
    ...getWorkerDeclaration("coder@1")!,
    name: TWO_AGENT_WORKER,
    agent_names: ["swe@1", "re@1"],
  };
}

export const SETUP_PROMPT = "setup prompt";

export function shippedFraming(): PromptPartAnswer {
  return framingPart(SHIPPED_TEMPLATE_SET, PromptConsumer.Worker, null);
}

export function memoryPromptTelemetry(): {
  agentPrompted(executionId: string, facts: AgentPromptFacts): void;
  promptRecordOf(
    executionId: string,
    agentName: string,
  ): AgentPromptFacts | null;
  records: Map<string, AgentPromptFacts>;
} {
  const records = new Map<string, AgentPromptFacts>();
  const key = (executionId: string, agentName: string) =>
    `${executionId}:${agentName}`;
  return {
    records,
    agentPrompted: (executionId, facts) => {
      if (!records.has(key(executionId, facts.agent_name)))
        records.set(key(executionId, facts.agent_name), facts);
    },
    promptRecordOf: (executionId, agentName) =>
      records.get(key(executionId, agentName)) ?? null,
  };
}
export const TEST_SSH_HOST_KEY = {
  known_hosts:
    "github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl\n",
};
export const TEST_SSH_PUBLIC_KEY =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIK/1WjvJ+fY2mkZ9670QDeSr+uQmk08SfSTmqmUDvbbH kanthord-test";

export function anthropicAgent(
  overrides: Partial<AgentSetup> = {},
): AgentSetup {
  return {
    agent_name: "swe@1",
    enablement_id: null,
    worker_binding_id: "binding_01ARZ3NDEKTSV4RRFFQ69G5FAB",
    credential_id: "credential_01ARZ3NDEKTSV4RRFFQ69G5FAA",
    effective_configuration: {
      agent_provider: "default",
      provider: "anthropic",
      credential: "anthro-1",
      model_identifier: "claude-sonnet-4-5",
      reasoning_effort: "off",
    },
    position: 0,
    level: ChainLevel.Enablement,
    metadata: null,
    prompt: { final: SETUP_PROMPT, sources: [] },
    ...overrides,
  };
}

export function anthropicSetup(
  overrides: Partial<ExecutionSetup> = {},
): ExecutionSetup {
  const setup: ExecutionSetup = {
    execution_id: "execution_01ARZ3NDEKTSV4RRFFQ69G5FAA",
    worker_name: "coder@1",
    agents: [anthropicAgent()],
    templates: SHIPPED_TEMPLATES,
    resource_budget: { turns: 200, wall_time_ms: 7200000 },
    intent: ExecutionIntent.Implement,
    repositories: [],
    ...overrides,
  };
  assert.ok(setup.agents.length);
  assert.ok(setup.execution_id);
  return setup;
}

export interface FakeStart {
  instance: PoolInstance;
  entries: readonly PoolEntry[];
}

export class FakePoolHost implements PoolHost {
  readonly started: FakeStart[] = [];
  readonly updated: FakeStart[] = [];
  readonly restarted: PoolInstance[] = [];
  readonly archived: PoolInstance[] = [];
  readonly images = new Map<string, string>();
  prepared = 0;
  readonly swept: Array<ReadonlySet<string>> = [];
  stopped = false;
  statuses = new Map<PoolPlacement, PlacementStatus>();
  statusReads = 0;
  prepare(): void {
    this.prepared++;
  }
  start(instance: PoolInstance, entries: readonly PoolEntry[]): void {
    this.started.push({ instance, entries });
  }
  update(instance: PoolInstance, entries: readonly PoolEntry[]): void {
    this.updated.push({ instance, entries });
  }
  restart(instance: PoolInstance): void {
    this.restarted.push(instance);
  }
  imageOf(instance: PoolInstance): string | null {
    return this.images.get(instance.name) ?? null;
  }
  archive(instance: PoolInstance): Promise<void> {
    this.archived.push(instance);
    return Promise.resolve();
  }
  sweep(live: ReadonlySet<string>): Promise<void> {
    this.swept.push(live);
    return Promise.resolve();
  }
  async stop(): Promise<void> {
    this.stopped = true;
  }
  async placementStatus(placement: PoolPlacement): Promise<PlacementStatus> {
    this.statusReads++;
    return this.statuses.get(placement) ?? alwaysAvailable(placement);
  }
  readonly sessionReads: Array<{ instance: PoolInstance; read: SessionRead }> =
    [];
  sessionReadResult: SessionReadResult = {
    outcome: SessionReadOutcome.EntryAbsent,
  };
  async readSessionEntry(
    instance: PoolInstance,
    read: SessionRead,
  ): Promise<SessionReadResult> {
    this.sessionReads.push({ instance, read });
    return this.sessionReadResult;
  }
}
