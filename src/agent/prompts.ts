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
  version: number;
};

const AGENT_PROMPT_PREFIX = "agent_prompt";
const ABSENT_VERSION = 0;
const FIRST_VERSION = 1;
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
      `SELECT scope, agent_name, switches, custom_text, version
       FROM agent_prompt WHERE scope = ? AND agent_name = ?`,
    )
    .get(scope, agentName) as DatabaseRow | undefined;
  if (!row)
    return {
      scope,
      agentName,
      switches: allOn(scope),
      customText: "",
      version: ABSENT_VERSION,
    };
  return {
    scope,
    agentName,
    switches: { ...allOn(scope), ...JSON.parse(row.switches) },
    customText: row.custom_text,
    version: row.version,
  };
}

export function savePromptSettings(
  tx: Transaction,
  settings: Omit<PromptSettings, "version">,
  version: number,
): PromptSettings {
  const now = Date.now();
  if (version === ABSENT_VERSION)
    tx.database
      .prepare(
        `INSERT INTO agent_prompt
         (id, scope, agent_name, switches, custom_text, version, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        createIdentity(AGENT_PROMPT_PREFIX),
        settings.scope,
        settings.agentName,
        canonicalJSON(settings.switches),
        settings.customText,
        FIRST_VERSION,
        now,
      );
  else
    tx.database
      .prepare(
        `UPDATE agent_prompt SET switches = ?, custom_text = ?, version = ?, updated_at = ?
         WHERE scope = ? AND agent_name = ?`,
      )
      .run(
        canonicalJSON(settings.switches),
        settings.customText,
        version + FIRST_VERSION,
        now,
        settings.scope,
        settings.agentName,
      );
  return promptSettings(tx, settings.scope, settings.agentName);
}
