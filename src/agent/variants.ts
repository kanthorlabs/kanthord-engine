import type { z } from "zod";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import { createIdentity } from "../kernel/identity.ts";
import type { Transaction } from "../kernel/store.ts";
import {
  AGENT_DECLARATIONS,
  getAgentDeclaration,
  workbenchAgentNames,
} from "./catalog.ts";
import {
  AGENT_VARIANT_PREFIX,
  AgentErrorCode,
  agentVariantSchema,
} from "./contract.ts";

export type AgentVariant = z.infer<typeof agentVariantSchema>;

export type AgentVariantItem = Pick<
  AgentVariant,
  "id" | "agent_name" | "display_name" | "revision"
>;

export interface VariantCreate {
  agent_name: string;
  display_name: string;
  instruction: string;
}

export interface VariantUpdate {
  display_name: string;
  instruction: string;
  expected_revision: number;
}

export interface VariantDelete {
  expected_revision: number;
  inUse: (agentName: string, variantId: string) => boolean;
}

const INITIAL_REVISION = 1;
const REVISION_INCREMENT = 1;
const NAME_MAX_LENGTH = 40;
const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*( [A-Za-z0-9_-]+)*$/;
const NAME_UNIQUE_FAILURE =
  /UNIQUE constraint failed: index 'agent_variant_display_name'/;

function nameTaken(): OperationError {
  return new OperationError(
    HttpStatus.Conflict,
    AgentErrorCode.VariantNameTaken,
    "The variant name is taken.",
  );
}

export function listVariants(tx: Transaction): AgentVariantItem[] {
  return tx.database
    .prepare(
      "SELECT id, agent_name, display_name, revision FROM agent_variant ORDER BY agent_name, display_name",
    )
    .all() as unknown as AgentVariantItem[];
}

export function getVariant(tx: Transaction, id: string): AgentVariant | null {
  const row = tx.database
    .prepare(
      "SELECT id, agent_name, display_name, instruction, revision FROM agent_variant WHERE id = ?",
    )
    .get(id);
  return row ? agentVariantSchema.parse({ ...row }) : null;
}

function requireVariant(tx: Transaction, id: string): AgentVariant {
  const row = getVariant(tx, id);
  if (row) return row;
  throw new OperationError(
    HttpStatus.NotFound,
    AgentErrorCode.VariantNotFound,
    "The agent variant does not exist.",
  );
}

function requireRevision(row: AgentVariant, expected: number): void {
  if (row.revision === expected) return;
  throw new OperationError(
    HttpStatus.Conflict,
    AgentErrorCode.VariantRevisionConflict,
    "The agent variant changed.",
    { variant_id: row.id, current: row },
  );
}

function requireBase(agentName: string): void {
  if (!getAgentDeclaration(agentName))
    throw new OperationError(
      HttpStatus.NotFound,
      AgentErrorCode.AgentNotFound,
      "The agent does not exist.",
    );
  if (workbenchAgentNames().includes(agentName)) return;
  throw new OperationError(
    HttpStatus.Conflict,
    AgentErrorCode.VariantBaseRefused,
    "The agent accepts no variant.",
  );
}

function requireName(
  tx: Transaction,
  name: string,
  ownId: string | null,
): void {
  if (name.length > NAME_MAX_LENGTH || !NAME_PATTERN.test(name))
    throw new OperationError(
      HttpStatus.BadRequest,
      AgentErrorCode.VariantNameInvalid,
      "The variant name is invalid.",
    );
  const lower = name.toLowerCase();
  if (
    Object.values(AGENT_DECLARATIONS).some(
      (declaration) => declaration.display_name.toLowerCase() === lower,
    )
  )
    throw nameTaken();
  const other = tx.database
    .prepare(
      "SELECT id FROM agent_variant WHERE display_name = ? COLLATE NOCASE AND id <> ?",
    )
    .get(name, ownId ?? "");
  if (other) throw nameTaken();
}

function mapNameFailure(error: unknown): never {
  if (error instanceof Error && NAME_UNIQUE_FAILURE.test(error.message))
    throw nameTaken();
  throw error;
}

export function createVariant(
  tx: Transaction,
  input: VariantCreate,
): AgentVariant {
  requireBase(input.agent_name);
  requireName(tx, input.display_name, null);
  const row: AgentVariant = {
    id: createIdentity(AGENT_VARIANT_PREFIX),
    agent_name: input.agent_name,
    display_name: input.display_name,
    instruction: input.instruction,
    revision: INITIAL_REVISION,
  };
  try {
    tx.database
      .prepare(
        "INSERT INTO agent_variant (id, agent_name, display_name, instruction, revision) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        row.id,
        row.agent_name,
        row.display_name,
        row.instruction,
        row.revision,
      );
  } catch (error) {
    mapNameFailure(error);
  }
  return row;
}

export function updateVariant(
  tx: Transaction,
  id: string,
  input: VariantUpdate,
): AgentVariant {
  const current = requireVariant(tx, id);
  requireRevision(current, input.expected_revision);
  requireName(tx, input.display_name, id);
  const row: AgentVariant = {
    ...current,
    display_name: input.display_name,
    instruction: input.instruction,
    revision: current.revision + REVISION_INCREMENT,
  };
  try {
    tx.database
      .prepare(
        "UPDATE agent_variant SET display_name = ?, instruction = ?, revision = ? WHERE id = ?",
      )
      .run(row.display_name, row.instruction, row.revision, id);
  } catch (error) {
    mapNameFailure(error);
  }
  return row;
}

export function deleteVariant(
  tx: Transaction,
  id: string,
  input: VariantDelete,
): void {
  const current = requireVariant(tx, id);
  requireRevision(current, input.expected_revision);
  if (input.inUse(current.agent_name, id))
    throw new OperationError(
      HttpStatus.Conflict,
      AgentErrorCode.VariantInUse,
      "The agent variant has a session.",
    );
  tx.database.prepare("DELETE FROM agent_variant WHERE id = ?").run(id);
}
