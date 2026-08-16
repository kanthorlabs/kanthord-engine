import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  leaseRelations,
  liveLeaseRefusal,
  type LeaseHierarchyInput,
  type LiveLease,
} from "./lease-hierarchy.ts";
import type { NodeKind } from "./state.ts";

const OBJECTIVE = "node_01JQ8ZDV5W6X7Y8Z9A0B1C2D3E";
const TASK = "node_01JQ8ZDV5W6X7Y8Z9A0B1C2D40";
const TASK_B = "node_01JQ8ZDV5W6X7Y8Z9A0B1C2D41";
const INITIATIVE = "node_01JQ8ZDV5W6X7Y8Z9A0B1C2D42";
const TASK_C = "node_01JQ8ZDV5W6X7Y8Z9A0B1C2D43";
const SIBLING_OBJECTIVE = "node_01JQ8ZDV5W6X7Y8Z9A0B1C2D44";
const OWNER_A = "actor_01JQ8ZDV5W6X7Y8Z9A0B1C2D50";
const OWNER_B = "actor_01JQ8ZDV5W6X7Y8Z9A0B1C2D51";

const lease = (
  subjectId: string,
  overrides: Partial<LiveLease> = {},
): LiveLease => ({
  subjectId,
  owner: OWNER_B,
  ownerKind: "actor",
  fence: 4,
  expiresAt: 1700000000000,
  ...overrides,
});

const taskInput = (
  overrides: Partial<LeaseHierarchyInput> = {},
): LeaseHierarchyInput => ({
  targetId: TASK,
  targetKind: "task",
  parentId: OBJECTIVE,
  childIds: [],
  siblingIds: [TASK_B],
  owner: OWNER_A,
  liveLeases: [],
  ...overrides,
});

const objectiveInput = (
  overrides: Partial<LeaseHierarchyInput> = {},
): LeaseHierarchyInput => ({
  targetId: OBJECTIVE,
  targetKind: "objective",
  parentId: INITIATIVE,
  childIds: [TASK, TASK_B],
  siblingIds: [SIBLING_OBJECTIVE],
  owner: OWNER_A,
  liveLeases: [],
  ...overrides,
});

const initiativeInput = (
  overrides: Partial<LeaseHierarchyInput> = {},
): LeaseHierarchyInput => ({
  targetId: INITIATIVE,
  targetKind: "initiative",
  parentId: null,
  childIds: [OBJECTIVE],
  siblingIds: [],
  owner: OWNER_A,
  liveLeases: [],
  ...overrides,
});

describe("src/domain/lease-hierarchy.test", () => {
  it("leaseRelations holds exactly four members in the declared order", () => {
    assert.deepEqual(leaseRelations, [
      "self",
      "ancestor",
      "descendant",
      "sibling",
    ]);
    for (const relation of leaseRelations) {
      assert.equal(typeof relation, "string", relation);
    }
  });

  it("an empty live lease set is never a refusal", () => {
    for (const targetKind of ["task", "objective", "initiative"] as const) {
      const base = { targetId: TASK, targetKind, owner: OWNER_A };
      assert.equal(
        liveLeaseRefusal(
          targetKind === "task"
            ? taskInput(base)
            : targetKind === "objective"
              ? objectiveInput(base)
              : initiativeInput(base),
        ),
        null,
      );
    }
  });

  it("a task claim is refused on another owner's lease over the task itself", () => {
    const input = taskInput({ liveLeases: [lease(TASK)] });
    const refusal = liveLeaseRefusal(input);
    assert.deepEqual(refusal, {
      subjectId: TASK,
      holder: OWNER_B,
      holderKind: "actor",
      fence: 4,
      relation: "self",
      expiresAt: 1700000000000,
    });
  });

  it("a task claim is refused on another owner's lease over its parent objective", () => {
    const input = taskInput({ liveLeases: [lease(OBJECTIVE)] });
    const refusal = liveLeaseRefusal(input);
    assert.deepEqual(refusal, {
      subjectId: OBJECTIVE,
      holder: OWNER_B,
      holderKind: "actor",
      fence: 4,
      relation: "ancestor",
      expiresAt: 1700000000000,
    });
  });

  it("a task claim is refused on another owner's lease over a sibling task", () => {
    const input = taskInput({ liveLeases: [lease(TASK_B)] });
    const refusal = liveLeaseRefusal(input);
    assert.deepEqual(refusal, {
      subjectId: TASK_B,
      holder: OWNER_B,
      holderKind: "actor",
      fence: 4,
      relation: "sibling",
      expiresAt: 1700000000000,
    });
  });

  it("an objective claim is refused on another owner's lease over the objective itself", () => {
    const input = objectiveInput({ liveLeases: [lease(OBJECTIVE)] });
    const refusal = liveLeaseRefusal(input);
    assert.deepEqual(refusal, {
      subjectId: OBJECTIVE,
      holder: OWNER_B,
      holderKind: "actor",
      fence: 4,
      relation: "self",
      expiresAt: 1700000000000,
    });
  });

  it("an objective claim is refused on another owner's lease over one of its tasks", () => {
    const input = objectiveInput({ liveLeases: [lease(TASK)] });
    const refusal = liveLeaseRefusal(input);
    assert.deepEqual(refusal, {
      subjectId: TASK,
      holder: OWNER_B,
      holderKind: "actor",
      fence: 4,
      relation: "descendant",
      expiresAt: 1700000000000,
    });
  });

  it("an objective claim is not refused on another owner's lease over a sibling objective", () => {
    const input = objectiveInput({ liveLeases: [lease(SIBLING_OBJECTIVE)] });
    assert.equal(liveLeaseRefusal(input), null);
  });

  it("an objective claim is not refused on another owner's lease over the initiative", () => {
    const input = objectiveInput({ liveLeases: [lease(INITIATIVE)] });
    assert.equal(liveLeaseRefusal(input), null);
  });

  it("a same-owner lease is never a refusal at any relation", () => {
    const relations = [
      ["self", TASK],
      ["ancestor", OBJECTIVE],
      ["descendant", TASK_C],
      ["sibling", TASK_B],
    ] as const;
    for (const [relation, subjectId] of relations) {
      const input = taskInput({
        owner: OWNER_B,
        liveLeases: [lease(subjectId, { owner: OWNER_B })],
      });
      assert.equal(liveLeaseRefusal(input), null, relation);
    }
    const objectiveRelations = [
      ["self", OBJECTIVE],
      ["descendant", TASK],
    ] as const;
    for (const [relation, subjectId] of objectiveRelations) {
      const input = objectiveInput({
        owner: OWNER_B,
        liveLeases: [lease(subjectId, { owner: OWNER_B })],
      });
      assert.equal(liveLeaseRefusal(input), null, relation);
    }
  });

  it("an initiative claim is never refused", () => {
    for (const subjectId of [INITIATIVE, OBJECTIVE, TASK, TASK_B]) {
      const input = initiativeInput({ liveLeases: [lease(subjectId)] });
      assert.equal(liveLeaseRefusal(input), null, subjectId);
    }
  });

  it("relation precedence beats identity order", () => {
    assert.ok(
      Buffer.compare(Buffer.from(OBJECTIVE), Buffer.from(TASK)) < 0,
      "the ancestor objective identity must sort before the self task identity",
    );
    const input = taskInput({
      liveLeases: [lease(TASK), lease(OBJECTIVE), lease(TASK_B)],
    });
    const refusal = liveLeaseRefusal(input);
    assert.deepEqual(refusal, {
      subjectId: TASK,
      holder: OWNER_B,
      holderKind: "actor",
      fence: 4,
      relation: "self",
      expiresAt: 1700000000000,
    });
  });

  it("identity order breaks a tie inside one relation", () => {
    assert.ok(
      Buffer.compare(Buffer.from(TASK_B), Buffer.from(TASK_C)) < 0,
      "TASK_B must sort before TASK_C",
    );
    const input = taskInput({
      siblingIds: [TASK_C, TASK_B],
      liveLeases: [lease(TASK_C), lease(TASK_B)],
    });
    const refusal = liveLeaseRefusal(input);
    assert.equal(refusal?.relation, "sibling");
    assert.equal(refusal?.subjectId, TASK_B);
  });

  it("the refusal carries the holder's fence", () => {
    const input = taskInput({ liveLeases: [lease(TASK, { fence: 9 })] });
    const refusal = liveLeaseRefusal(input);
    assert.equal(refusal?.fence, 9);
  });

  it("the function reads no clock", () => {
    const atZero = taskInput({
      liveLeases: [lease(OBJECTIVE, { expiresAt: 0 })],
    });
    const atMaximum = taskInput({
      liveLeases: [lease(OBJECTIVE, { expiresAt: Number.MAX_SAFE_INTEGER })],
    });
    assert.equal(liveLeaseRefusal(atZero)?.relation, "ancestor");
    assert.equal(
      liveLeaseRefusal(atMaximum)?.relation,
      liveLeaseRefusal(atZero)?.relation,
    );
  });
});
