import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  satisfiesDependency,
  isReady,
  deriveReadiness,
  blockReasonClearance,
  clearedByUnblock,
} from "./readiness.ts";
import { nodeStates, blockReasons } from "./state.ts";
import type { NodeState, BlockReason } from "./state.ts";
import type {
  Dependency,
  ReadinessNode,
  ReadinessTransition,
} from "./readiness.ts";
import type { StoredEdge } from "./plan-graph.ts";

describe("src/domain/readiness.test", () => {
  describe("satisfiesDependency", () => {
    for (const state of nodeStates) {
      it(`satisfiesDependency("${state}") === ${state === "done" || state === "partial"}`, () => {
        assert.equal(
          satisfiesDependency(state),
          state === "done" || state === "partial",
        );
      });
    }
  });

  describe("isReady", () => {
    it("isReady([]) is true", () => {
      assert.equal(isReady([]), true);
    });

    it('isReady([{ state: "done", waived: false }]) is true', () => {
      assert.equal(isReady([{ state: "done", waived: false }]), true);
    });

    it('isReady([{ state: "partial", waived: false }]) is true', () => {
      assert.equal(isReady([{ state: "partial", waived: false }]), true);
    });

    it('isReady(["done", "partial"]) is true', () => {
      assert.equal(
        isReady([
          { state: "done", waived: false },
          { state: "partial", waived: false },
        ]),
        true,
      );
    });

    const nonSatisfyingStates: NodeState[] = [
      "pending",
      "ready",
      "running",
      "blocked",
      "awaiting_approval",
      "discarded",
    ];

    for (const state of nonSatisfyingStates) {
      it(`isReady([{ state: "${state}", waived: false }]) is false`, () => {
        assert.equal(isReady([{ state, waived: false }]), false);
      });

      it(`isReady(["done", "${state}"]) is false when not waived`, () => {
        assert.equal(
          isReady([
            { state: "done", waived: false },
            { state, waived: false },
          ]),
          false,
        );
      });
    }

    for (const state of nonSatisfyingStates) {
      it(`isReady([{ state: "${state}", waived: true }]) is true — waived edge is ignored`, () => {
        assert.equal(isReady([{ state, waived: true }]), true);
      });
    }

    it("isReady([discarded waived, running not waived]) is false", () => {
      assert.equal(
        isReady([
          { state: "discarded", waived: true },
          { state: "running", waived: false },
        ]),
        false,
      );
    });
  });

  describe("deriveReadiness", () => {
    const edge = (
      id: string,
      fromNode: string,
      toNode: string,
      waivedAt: number | null = null,
    ): StoredEdge => ({ id, fromNode, toNode, waivedAt });

    const promotion = (nodeId: string): ReadinessTransition => ({
      nodeId,
      from: "pending",
      to: "ready",
      trigger: "readiness-promoted",
    });

    const demotion = (nodeId: string): ReadinessTransition => ({
      nodeId,
      from: "ready",
      to: "pending",
      trigger: "readiness-demoted",
    });

    const applyTransitions = (
      nodes: readonly ReadinessNode[],
      transitions: readonly ReadinessTransition[],
    ): ReadinessNode[] =>
      nodes.map((n) => {
        const t = transitions.find((x) => x.nodeId === n.id);
        return t === undefined ? n : { id: n.id, state: t.to };
      });

    it("deriveReadiness([], []) deep-equals []", () => {
      assert.deepEqual(deriveReadiness([], []), []);
    });

    it("a pending node with no edge yields exactly one promotion", () => {
      assert.deepEqual(
        deriveReadiness([{ id: "task_1", state: "pending" }], []),
        [promotion("task_1")],
      );
    });

    it("three pending nodes with no edge yield three promotions in bytewise order", () => {
      const nodes: ReadinessNode[] = [
        { id: "initiative_1", state: "pending" },
        { id: "objective_1", state: "pending" },
        { id: "task_1", state: "pending" },
      ];
      assert.deepEqual(deriveReadiness(nodes, []), [
        promotion("initiative_1"),
        promotion("objective_1"),
        promotion("task_1"),
      ]);
    });

    const satisfyingStates: NodeState[] = ["done", "partial"];
    for (const depState of satisfyingStates) {
      it(`a pending node whose dependency is in ${depState} yields one promotion`, () => {
        const nodes: ReadinessNode[] = [
          { id: "subject", state: "pending" },
          { id: `dep_${depState}`, state: depState },
        ];
        const edges: StoredEdge[] = [edge("e1", "subject", `dep_${depState}`)];
        assert.deepEqual(deriveReadiness(nodes, edges), [promotion("subject")]);
      });
    }

    const nonSatisfyingStates: NodeState[] = [
      "pending",
      "ready",
      "running",
      "blocked",
      "awaiting_approval",
      "discarded",
    ];
    for (const depState of nonSatisfyingStates) {
      it(`a pending node whose dependency is in ${depState} yields []`, () => {
        const nodes: ReadinessNode[] = [
          { id: "subject", state: "pending" },
          { id: `dep_${depState}`, state: depState },
        ];
        const edges: StoredEdge[] = [edge("e1", "subject", `dep_${depState}`)];
        if (depState === "pending") {
          nodes.push({ id: "blocked_x", state: "blocked" });
          edges.push(edge("e2", "dep_pending", "blocked_x"));
        }
        assert.deepEqual(deriveReadiness(nodes, edges), []);
      });
    }

    it("a waived edge satisfies its dependency", () => {
      const nodes: ReadinessNode[] = [
        { id: "subject", state: "pending" },
        { id: "waived_dep", state: "pending" },
        { id: "blocked_x", state: "blocked" },
      ];
      const edges: StoredEdge[] = [
        edge("e1", "subject", "waived_dep", 1),
        edge("e2", "waived_dep", "blocked_x"),
      ];
      assert.deepEqual(deriveReadiness(nodes, edges), [promotion("subject")]);
    });

    it("a ready node with one unsatisfied dependency yields exactly one demotion", () => {
      const nodes: ReadinessNode[] = [
        { id: "subject", state: "ready" },
        { id: "dep_pending", state: "pending" },
        { id: "blocked_x", state: "blocked" },
      ];
      const edges: StoredEdge[] = [
        edge("e1", "subject", "dep_pending"),
        edge("e2", "dep_pending", "blocked_x"),
      ];
      assert.deepEqual(deriveReadiness(nodes, edges), [demotion("subject")]);
    });

    it("a ready node whose dependencies are all satisfied yields []", () => {
      const nodes: ReadinessNode[] = [
        { id: "subject", state: "ready" },
        { id: "dep_done", state: "done" },
      ];
      const edges: StoredEdge[] = [edge("e1", "subject", "dep_done")];
      assert.deepEqual(deriveReadiness(nodes, edges), []);
    });

    it("both directions come from one pass", () => {
      const nodes: ReadinessNode[] = [
        { id: "node_pending_a", state: "pending" },
        { id: "node_ready_b", state: "ready" },
        { id: "node_done_x", state: "done" },
        { id: "node_blocked_y", state: "blocked" },
      ];
      const edges: StoredEdge[] = [
        edge("e1", "node_pending_a", "node_done_x"),
        edge("e2", "node_ready_b", "node_blocked_y"),
      ];
      assert.deepEqual(deriveReadiness(nodes, edges), [
        promotion("node_pending_a"),
        demotion("node_ready_b"),
      ]);
    });

    it("the fixed point holds on the promotion fixture", () => {
      const nodes: ReadinessNode[] = [
        { id: "node_pending_a", state: "pending" },
        { id: "node_done_x", state: "done" },
      ];
      const edges: StoredEdge[] = [edge("e1", "node_pending_a", "node_done_x")];
      const first = deriveReadiness(nodes, edges);
      assert.deepEqual(
        deriveReadiness(applyTransitions(nodes, first), edges),
        [],
      );
    });

    it("the fixed point holds on the demotion fixture", () => {
      const nodes: ReadinessNode[] = [
        { id: "node_ready_b", state: "ready" },
        { id: "node_blocked_y", state: "blocked" },
      ];
      const edges: StoredEdge[] = [
        edge("e1", "node_ready_b", "node_blocked_y"),
      ];
      const first = deriveReadiness(nodes, edges);
      assert.deepEqual(
        deriveReadiness(applyTransitions(nodes, first), edges),
        [],
      );
    });

    it("no node yields two transitions", () => {
      const nodes: ReadinessNode[] = [
        { id: "node_pending_a", state: "pending" },
        { id: "node_ready_b", state: "ready" },
        { id: "node_done_x", state: "done" },
        { id: "node_blocked_y", state: "blocked" },
      ];
      const edges: StoredEdge[] = [
        edge("e1", "node_pending_a", "node_done_x"),
        edge("e2", "node_ready_b", "node_blocked_y"),
      ];
      const result = deriveReadiness(nodes, edges);
      assert.equal(
        new Set(result.map((t: ReadinessTransition) => t.nodeId)).size,
        result.length,
      );
    });

    const untouchedStates: NodeState[] = [
      "running",
      "blocked",
      "awaiting_approval",
      "done",
      "partial",
      "discarded",
    ];
    for (const state of untouchedStates) {
      it(`a node in ${state} with all dependencies satisfied yields []`, () => {
        const nodes: ReadinessNode[] = [
          { id: "subject", state },
          { id: "dep_done", state: "done" },
        ];
        const edges: StoredEdge[] = [edge("e1", "subject", "dep_done")];
        assert.deepEqual(deriveReadiness(nodes, edges), []);
      });

      it(`a node in ${state} with one unsatisfied dependency yields []`, () => {
        const nodes: ReadinessNode[] = [
          { id: "subject", state },
          { id: "dep_blocked", state: "blocked" },
        ];
        const edges: StoredEdge[] = [edge("e1", "subject", "dep_blocked")];
        assert.deepEqual(deriveReadiness(nodes, edges), []);
      });
    }

    it("an edge whose toNode is absent from the node set is skipped", () => {
      const nodes: ReadinessNode[] = [{ id: "subject", state: "pending" }];
      const edges: StoredEdge[] = [edge("e1", "subject", "ghost")];
      assert.deepEqual(deriveReadiness(nodes, edges), [promotion("subject")]);
    });

    it("ordering is bytewise, not locale-sensitive", () => {
      const nodes: ReadinessNode[] = [
        { id: "node_Z", state: "pending" },
        { id: "node_a", state: "pending" },
        { id: "node_B", state: "pending" },
      ];
      const result = deriveReadiness(nodes, []);
      assert.deepEqual(
        result.map((t: ReadinessTransition) => t.nodeId),
        ["node_B", "node_Z", "node_a"],
      );
      assert.notDeepEqual(
        ["node_Z", "node_a", "node_B"].toSorted((l, r) => l.localeCompare(r)),
        ["node_B", "node_Z", "node_a"],
      );
    });

    it("deriveReadiness stamps the declared trigger on every transition", () => {
      const nodes: ReadinessNode[] = [
        { id: "node_pending_a", state: "pending" },
        { id: "node_ready_b", state: "ready" },
        { id: "node_done_x", state: "done" },
        { id: "node_blocked_y", state: "blocked" },
      ];
      const edges: StoredEdge[] = [
        edge("e1", "node_pending_a", "node_done_x"),
        edge("e2", "node_ready_b", "node_blocked_y"),
      ];
      const result = deriveReadiness(nodes, edges);
      assert.deepEqual(result, [
        promotion("node_pending_a"),
        demotion("node_ready_b"),
      ]);
      assert.deepEqual(
        result.map((t) => t.trigger),
        ["readiness-promoted", "readiness-demoted"],
      );
    });
  });

  describe("blockReasonClearance", () => {
    it("has 6 entries, one per blockReason", () => {
      assert.equal(Object.keys(blockReasonClearance).length, 6);
      for (const reason of blockReasons) {
        assert.ok(reason in blockReasonClearance, `missing key "${reason}"`);
      }
    });

    const expectedClearances: Record<BlockReason, readonly string[]> = {
      "attempt-limit": ["unblock"],
      "dependency-discarded": ["waive", "import"],
      "stale-base": ["unblock"],
      "dirty-recovery": ["unblock"],
      "e2e-failed": ["import"],
      abandoned: ["unblock"],
    };

    for (const [reason, clearances] of Object.entries(expectedClearances)) {
      it(`blockReasonClearance["${reason}"] deep-equals ${JSON.stringify(clearances)}`, () => {
        assert.deepEqual(
          blockReasonClearance[reason as BlockReason],
          clearances,
        );
      });
    }

    it("every list is non-empty and contains only valid clearances", () => {
      const validClearances = ["unblock", "waive", "import"];
      for (const reason of blockReasons) {
        const list = blockReasonClearance[reason];
        assert.ok(list.length > 0, `empty list for "${reason}"`);
        for (const clearance of list) {
          assert.ok(
            validClearances.includes(clearance),
            `invalid clearance "${clearance}" for "${reason}"`,
          );
        }
      }
    });
  });

  describe("clearedByUnblock", () => {
    it('blockReasons.filter(clearedByUnblock) deep-equals ["attempt-limit", "stale-base", "dirty-recovery", "abandoned"]', () => {
      assert.deepEqual(blockReasons.filter(clearedByUnblock), [
        "attempt-limit",
        "stale-base",
        "dirty-recovery",
        "abandoned",
      ]);
    });

    it('clearedByUnblock("dependency-discarded") is false', () => {
      assert.equal(clearedByUnblock("dependency-discarded"), false);
    });

    it('clearedByUnblock("e2e-failed") is false', () => {
      assert.equal(clearedByUnblock("e2e-failed"), false);
    });
  });
});
