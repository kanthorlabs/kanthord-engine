import assert from "node:assert/strict";
import { createIdentity } from "../kernel/identity.ts";
import type { Transaction } from "../kernel/store.ts";
import type { AgentConfig } from "./config.ts";
import { AdvancingFailure, type AgentCooldown } from "./contract.ts";

const AGENT_COOLDOWN_PREFIX = "agent_cooldown";
const NO_STRIKES = 0;
const FIRST_STRIKE = 1;
const DOUBLING_BASE = 2;
const MAX_DOUBLINGS = 52;
const COLUMNS =
  "id AS cooldown_id, credential, model_identifier, code, strikes, started_at, until_at, execution_id";

export type CooldownKey = { credential: string; model_identifier: string };

function baseDuration(
  config: AgentConfig["cooldown"],
  code: AdvancingFailure,
): number {
  if (code === AdvancingFailure.RateLimited) return config.rate_limited_ms;
  if (code === AdvancingFailure.QuotaExhausted)
    return config.quota_exhausted_ms;
  return config.unavailable_ms;
}

export function cooldownDuration(
  config: AgentConfig["cooldown"],
  code: AdvancingFailure,
  strikes: number,
): number {
  assert.ok(Number.isSafeInteger(strikes) && strikes >= FIRST_STRIKE);
  const doublings = Math.min(strikes - FIRST_STRIKE, MAX_DOUBLINGS);
  return Math.min(
    config.max_ms,
    baseDuration(config, code) * DOUBLING_BASE ** doublings,
  );
}

export function listCooldowns(tx: Transaction): AgentCooldown[] {
  return tx.database
    .prepare(
      `SELECT ${COLUMNS} FROM agent_cooldown ORDER BY credential, model_identifier`,
    )
    .all()
    .map((row) => ({ ...row }) as AgentCooldown);
}

export function cooldownOf(
  tx: Transaction,
  key: CooldownKey,
): AgentCooldown | null {
  const row = tx.database
    .prepare(
      `SELECT ${COLUMNS} FROM agent_cooldown WHERE credential = ? AND model_identifier = ?`,
    )
    .get(key.credential, key.model_identifier);
  return row ? ({ ...row } as AgentCooldown) : null;
}

export function startCooldown(
  tx: Transaction,
  config: AgentConfig["cooldown"],
  key: CooldownKey,
  code: AdvancingFailure,
  executionId: string,
  now: number,
): AgentCooldown {
  const current = cooldownOf(tx, key);
  const strikes = (current?.strikes ?? NO_STRIKES) + FIRST_STRIKE;
  const row: AgentCooldown = {
    cooldown_id: current?.cooldown_id ?? createIdentity(AGENT_COOLDOWN_PREFIX),
    credential: key.credential,
    model_identifier: key.model_identifier,
    code,
    strikes,
    started_at: now,
    until_at: now + cooldownDuration(config, code, strikes),
    execution_id: executionId,
  };
  tx.database
    .prepare(
      `INSERT INTO agent_cooldown (id, credential, model_identifier, code, strikes, started_at, until_at, execution_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (credential, model_identifier) DO UPDATE SET
         code = excluded.code, strikes = excluded.strikes, started_at = excluded.started_at,
         until_at = excluded.until_at, execution_id = excluded.execution_id`,
    )
    .run(
      row.cooldown_id,
      row.credential,
      row.model_identifier,
      row.code,
      row.strikes,
      row.started_at,
      row.until_at,
      row.execution_id,
    );
  return row;
}

export function deleteCooldownOf(tx: Transaction, key: CooldownKey): boolean {
  return (
    tx.database
      .prepare(
        "DELETE FROM agent_cooldown WHERE credential = ? AND model_identifier = ?",
      )
      .run(key.credential, key.model_identifier).changes > NO_STRIKES
  );
}

export function deleteCooldown(tx: Transaction, cooldownId: string): boolean {
  return (
    tx.database
      .prepare("DELETE FROM agent_cooldown WHERE id = ?")
      .run(cooldownId).changes > NO_STRIKES
  );
}
