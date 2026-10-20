import assert from "node:assert/strict";
import type {
  AgentSetup,
  ExecutionSetup,
  HostTools,
  PlacementStatus,
  PoolHost,
  PoolPlacement,
  PoolSlot,
} from "./contract.ts";
import { getWorkerDeclaration, type WorkerDeclaration } from "./catalog.ts";

export const unusedHostTools: HostTools = {
  evidenceUpload: () =>
    Promise.reject(new Error("Unexpected evidence upload in fixture")),
};
import { createIdentity } from "../kernel/identity.ts";
import { ChainLevel } from "../agent/contract.ts";
import { SHIPPED_TEMPLATES } from "../agent/prompt-templates.ts";
import { ExecutionIntent, alwaysAvailable } from "./contract.ts";

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
export const WORKING_LAYER_ALL_ON = {
  agents_md: true,
  agents_local_md: true,
  claude_md: true,
  claude_local_md: true,
  project_prompt: true,
};

export function anthropicAgent(
  overrides: Partial<AgentSetup> = {},
): AgentSetup {
  return {
    agent_name: "swe@1",
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

export class FakePoolHost implements PoolHost {
  readonly started: PoolSlot[] = [];
  readonly drained: PoolSlot[] = [];
  prepared = 0;
  readonly removed: PoolSlot[] = [];
  readonly swept: Array<ReadonlySet<string>> = [];
  private listener: (clientId: string) => void = () => {};
  clientIdentity(
    projectId: string,
    resourceIdentity: string,
    generation: number,
    slot: number,
  ): string {
    const key = [projectId, resourceIdentity, generation, slot].join("/");
    let identity = this.identities.get(key);
    if (!identity) {
      identity = createIdentity("client_identity");
      this.identities.set(key, identity);
    }
    return identity;
  }
  prepare(): void {
    this.prepared++;
  }
  remove(slot: PoolSlot): Promise<void> {
    this.removed.push({ ...slot });
    return Promise.resolve();
  }
  sweep(live: ReadonlySet<string>): Promise<void> {
    this.swept.push(live);
    return Promise.resolve();
  }
  start(slot: PoolSlot): void {
    this.started.push({ ...slot });
  }
  drain(slot: PoolSlot): void {
    this.drained.push({ ...slot });
  }
  stopped = false;
  private readonly identities = new Map<string, string>();
  async stop(): Promise<void> {
    this.stopped = true;
  }
  onEnded(listener: (clientId: string) => void): void {
    this.listener = listener;
  }
  end(clientId: string): void {
    this.listener(clientId);
  }
  statuses = new Map<PoolPlacement, PlacementStatus>();
  statusReads = 0;
  async placementStatus(placement: PoolPlacement): Promise<PlacementStatus> {
    this.statusReads++;
    return this.statuses.get(placement) ?? alwaysAvailable(placement);
  }
}
