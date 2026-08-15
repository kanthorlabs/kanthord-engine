import { deriveReadiness } from "../../domain/readiness.ts";
import type { ReadinessTransition } from "../../domain/readiness.ts";
import type { EventLog } from "../event/index.ts";
import type { Transaction } from "../storage/index.ts";
import type { Readiness, ReadinessInput } from "./index.ts";

export type DependencyReadinessDependencies = Readonly<{
  events: EventLog;
  instanceId: string;
}>;

export class DependencyReadiness implements Readiness {
  private readonly dependencies: DependencyReadinessDependencies;

  constructor(dependencies: DependencyReadinessDependencies) {
    this.dependencies = dependencies;
  }

  apply(
    transaction: Transaction,
    input: ReadinessInput,
  ): readonly ReadinessTransition[] {
    const transitions = deriveReadiness(input.nodes, input.edges);
    for (const transition of transitions) {
      this.dependencies.events.append(transaction, {
        subjectKind: "node",
        subjectId: transition.nodeId,
        type: transition.to === "ready" ? "node.ready" : "node.pending",
        actorKind: "daemon",
        actorId: this.dependencies.instanceId,
        payload: {
          from: transition.from,
          to: transition.to,
          reason:
            transition.to === "ready"
              ? "dependency-satisfied"
              : "dependency-unsatisfied",
          revision: input.cause.revision,
          importId: input.cause.importId,
        },
      });
    }
    return transitions;
  }
}
