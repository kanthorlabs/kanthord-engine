import assert from "node:assert/strict";
import { test } from "node:test";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import {
  IN_MEMORY_DATABASE,
  Store,
  type Transaction,
} from "../kernel/store.ts";
import { AGENT_COMPONENT_NAME, AgentErrorCode } from "./contract.ts";
import { agentMigrations } from "./migrations.ts";
import {
  createVariant,
  deleteVariant,
  getVariant,
  updateVariant,
  type VariantCreate,
} from "./variants.ts";

const BASE = "ops@1";
const VALID: VariantCreate = {
  agent_name: BASE,
  display_name: "Planner",
  instruction: "Plan first.",
};

function withStore(work: (tx: Transaction) => void): void {
  const store = new Store(IN_MEMORY_DATABASE);
  try {
    store.migrate([
      { service: AGENT_COMPONENT_NAME, migrations: agentMigrations },
    ]);
    store.transaction(work);
  } finally {
    store.close();
  }
}

function refusal(work: () => unknown): OperationError {
  try {
    work();
  } catch (error) {
    assert.ok(error instanceof OperationError);
    return error;
  }
  throw new Error("The call did not throw.");
}

test("a variant name with a period answers agent.variant.name_invalid", () => {
  withStore((tx) => {
    const error = refusal(() =>
      createVariant(tx, { ...VALID, display_name: "Plan.ner" }),
    );
    assert.equal(error.status, HttpStatus.BadRequest);
    assert.equal(error.code, AgentErrorCode.VariantNameInvalid);
  });
});

test("a variant name equal to a catalog name in lower case answers agent.variant.name_taken", () => {
  withStore((tx) => {
    const error = refusal(() =>
      createVariant(tx, { ...VALID, display_name: "yumi" }),
    );
    assert.equal(error.status, HttpStatus.Conflict);
    assert.equal(error.code, AgentErrorCode.VariantNameTaken);
  });
});

test("an unknown base answers agent.catalog.not_found", () => {
  withStore((tx) => {
    const error = refusal(() =>
      createVariant(tx, { ...VALID, agent_name: "nobody@1" }),
    );
    assert.equal(error.status, HttpStatus.NotFound);
    assert.equal(error.code, AgentErrorCode.AgentNotFound);
  });
});

test("a guard@1 base answers agent.variant.base_refused", () => {
  withStore((tx) => {
    const error = refusal(() =>
      createVariant(tx, { ...VALID, agent_name: "guard@1" }),
    );
    assert.equal(error.status, HttpStatus.Conflict);
    assert.equal(error.code, AgentErrorCode.VariantBaseRefused);
  });
});

test("a stale expected_revision on update answers agent.variant.revision_conflict and keeps the row", () => {
  withStore((tx) => {
    const created = createVariant(tx, VALID);
    const error = refusal(() =>
      updateVariant(tx, created.id, {
        display_name: "Other",
        instruction: "Changed.",
        expected_revision: created.revision + 1,
      }),
    );
    assert.equal(error.status, HttpStatus.Conflict);
    assert.equal(error.code, AgentErrorCode.VariantRevisionConflict);
    assert.deepEqual(error.details, {
      variant_id: created.id,
      current: created,
    });
    assert.deepEqual(getVariant(tx, created.id), created);
  });
});

test("a stale expected_revision on delete answers agent.variant.revision_conflict and keeps the row", () => {
  withStore((tx) => {
    const created = createVariant(tx, VALID);
    const error = refusal(() =>
      deleteVariant(tx, created.id, {
        expected_revision: created.revision + 1,
        inUse: () => false,
      }),
    );
    assert.equal(error.status, HttpStatus.Conflict);
    assert.equal(error.code, AgentErrorCode.VariantRevisionConflict);
    assert.deepEqual(error.details, {
      variant_id: created.id,
      current: created,
    });
    assert.deepEqual(getVariant(tx, created.id), created);
  });
});
