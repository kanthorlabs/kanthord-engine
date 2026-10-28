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
} from "./contract.ts";
import { getWorkerDeclaration, type WorkerDeclaration } from "./catalog.ts";

export const unusedHostTools: HostTools = {
  evidenceUpload: () =>
    Promise.reject(new Error("Unexpected evidence upload in fixture")),
};
import { ChainLevel } from "../agent/contract.ts";
import { SHIPPED_TEMPLATES } from "../agent/prompt-templates.ts";
import { alwaysAvailable, ExecutionIntent } from "./contract.ts";

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
    prompt: { final: SETUP_PROMPT },
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
}
