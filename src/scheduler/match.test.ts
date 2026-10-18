import assert from "node:assert/strict";
import { test } from "node:test";
import { createIdentity } from "../kernel/identity.ts";
import { ClaimNodeState, ClaimIntent, type Claimant } from "./contract.ts";
import { admits, covered } from "./match.ts";
import { schedulerHarness } from "./test-support.ts";

const MACOS = "platform.macos";
const XCODE = "toolchain.xcode";
const WALL_TIME = 7200000;
const PINNED_BINDING_READ = "workerBindingOf";

const coder: Claimant = {
  declared_node_states: [ClaimNodeState.Available],
  declared_intents: [ClaimIntent.Implement, ClaimIntent.Examine],
  tags: [],
};
const macosCoder: Claimant = { ...coder, tags: [MACOS, XCODE] };
const reviewer: Claimant = {
  declared_node_states: [
    ClaimNodeState.Waiting,
    ClaimNodeState.ExternalRequested,
  ],
  declared_intents: [ClaimIntent.Implement, ClaimIntent.Examine],
  tags: [],
};

test("a claimant admits a node only when its worker declares the intent and its tags include every tag of the node", () => {
  assert.equal(
    admits(coder, { intent: ClaimIntent.Implement, tags: [] }),
    true,
  );
  assert.equal(
    admits(coder, { intent: ClaimIntent.Implement, tags: [MACOS] }),
    false,
  );
  assert.equal(
    admits(macosCoder, { intent: ClaimIntent.Examine, tags: [MACOS] }),
    true,
  );
  assert.equal(
    admits(macosCoder, {
      intent: ClaimIntent.Implement,
      tags: [MACOS, "platform.linux"],
    }),
    false,
  );
  assert.equal(
    admits(
      { ...macosCoder, declared_intents: [ClaimIntent.Examine] },
      { intent: ClaimIntent.Implement, tags: [] },
    ),
    false,
  );
  assert.equal(
    admits(coder, { intent: ClaimIntent.Implement, tags: ["platform.MACOS"] }),
    false,
  );
});

test("a claimant covers a state only when its worker declares the state and it admits the node", () => {
  const facts = { intent: ClaimIntent.Implement, tags: [MACOS] };
  assert.equal(
    covered([coder, reviewer], facts, ClaimNodeState.Available),
    false,
  );
  assert.equal(covered([macosCoder], facts, ClaimNodeState.Available), true);
  assert.equal(covered([macosCoder], facts, ClaimNodeState.Waiting), false);
  assert.equal(covered([], facts, ClaimNodeState.Available), false);
});

test("unmatched claims answer each uncovered pair of Available, Waiting and External.Requested and ignore the instance count", (t) => {
  const h = schedulerHarness(t);
  const projectId = createIdentity("project");
  const linux = createIdentity("node");
  const macos = createIdentity("node");
  const action = createIdentity("node");
  const declarations: Record<string, Claimant["declared_node_states"]> = {
    "coder@1": coder.declared_node_states,
    "reviewer@1": reviewer.declared_node_states,
  };
  h.dependencies.declarations.declarationOf = (workerName) =>
    Object.hasOwn(declarations, workerName)
      ? {
          declared_node_states: declarations[workerName]!,
          declared_intents: [ClaimIntent.Implement, ClaimIntent.Examine],
          resource_budget: { wall_time_ms: WALL_TIME },
        }
      : null;
  const bindings = [
    {
      binding_id: createIdentity("binding"),
      worker_name: "coder@1",
      tags: [MACOS],
    },
    {
      binding_id: createIdentity("binding"),
      worker_name: "reviewer@1",
      tags: [],
    },
    {
      binding_id: createIdentity("binding"),
      worker_name: "unknown@1",
      tags: [MACOS],
    },
  ];
  h.dependencies.bindings.workerBindingsOf = (_tx, id) => {
    assert.equal(id, projectId);
    return bindings;
  };
  h.dependencies.facts.claimFactsOf = (_tx, id) => {
    assert.equal(id, projectId);
    return [
      {
        node_id: linux,
        revision: 1,
        intent: ClaimIntent.Implement,
        tags: [],
        claims: [ClaimNodeState.Available, ClaimNodeState.Waiting],
      },
      {
        node_id: macos,
        revision: 2,
        intent: ClaimIntent.Implement,
        tags: [MACOS],
        claims: [ClaimNodeState.Available, ClaimNodeState.Waiting],
      },
      {
        node_id: action,
        revision: 1,
        intent: ClaimIntent.Examine,
        tags: [MACOS],
        claims: [
          ClaimNodeState.Available,
          ClaimNodeState.Waiting,
          ClaimNodeState.ExternalRequested,
        ],
      },
    ];
  };
  const read = () =>
    h.store.transaction((tx) => h.service.unmatchedClaims(tx, projectId));
  assert.deepEqual(read(), [
    { node_id: macos, revision: 2, claim: ClaimNodeState.Waiting },
    { node_id: action, revision: 1, claim: ClaimNodeState.Waiting },
    { node_id: action, revision: 1, claim: ClaimNodeState.ExternalRequested },
  ]);
  bindings[1]!.tags = [MACOS];
  assert.deepEqual(read(), []);
  bindings.splice(0, 1);
  assert.deepEqual(
    read().map(({ node_id, claim }) => ({ node_id, claim })),
    [
      { node_id: linux, claim: ClaimNodeState.Available },
      { node_id: macos, claim: ClaimNodeState.Available },
      { node_id: action, claim: ClaimNodeState.Available },
    ],
  );
  assert.deepEqual(
    h.calls.filter(({ method }) => method === PINNED_BINDING_READ),
    [],
  );
});
