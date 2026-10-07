import { createIdentity } from "../kernel/identity.ts";
import { canonicalJSON } from "../kernel/json.ts";
import type { Transaction } from "../kernel/store.ts";
import {
  PROMPT_SWITCHES,
  PromptScope,
  type PromptSettings,
} from "./contract.ts";

type DatabaseRow = {
  scope: PromptScope;
  agent_name: string;
  switches: string;
  custom_text: string;
  revision: number;
};

const AGENT_PROMPT_PREFIX = "agent_prompt";
const ABSENT_REVISION = 0;
const FIRST_REVISION = 1;
const SYSTEM_AGENT_NAME = "";

function allOn(scope: PromptScope): Record<string, boolean> {
  return Object.fromEntries(PROMPT_SWITCHES[scope].map((name) => [name, true]));
}

export function promptSettings(
  tx: Transaction,
  scope: PromptScope,
  agentName: string = SYSTEM_AGENT_NAME,
): PromptSettings {
  const row = tx.database
    .prepare(
      `SELECT scope, agent_name, switches, custom_text, revision
       FROM agent_prompt WHERE scope = ? AND agent_name = ?`,
    )
    .get(scope, agentName) as DatabaseRow | undefined;
  if (!row)
    return {
      scope,
      agentName,
      switches: allOn(scope),
      customText: "",
      revision: ABSENT_REVISION,
    };
  return {
    scope,
    agentName,
    switches: { ...allOn(scope), ...JSON.parse(row.switches) },
    customText: row.custom_text,
    revision: row.revision,
  };
}

export function savePromptSettings(
  tx: Transaction,
  settings: Omit<PromptSettings, "revision">,
  revision: number,
): PromptSettings {
  const now = Date.now();
  if (revision === ABSENT_REVISION)
    tx.database
      .prepare(
        `INSERT INTO agent_prompt
         (id, scope, agent_name, switches, custom_text, revision, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        createIdentity(AGENT_PROMPT_PREFIX),
        settings.scope,
        settings.agentName,
        canonicalJSON(settings.switches),
        settings.customText,
        FIRST_REVISION,
        now,
      );
  else
    tx.database
      .prepare(
        `UPDATE agent_prompt SET switches = ?, custom_text = ?, revision = ?, updated_at = ?
         WHERE scope = ? AND agent_name = ?`,
      )
      .run(
        canonicalJSON(settings.switches),
        settings.customText,
        revision + FIRST_REVISION,
        now,
        settings.scope,
        settings.agentName,
      );
  return promptSettings(tx, settings.scope, settings.agentName);
}
