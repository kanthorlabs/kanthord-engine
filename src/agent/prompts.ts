import { createIdentity } from "../kernel/identity.ts";
import { canonicalJSON } from "../kernel/json.ts";
import type { Transaction } from "../kernel/store.ts";
import {
  PROMPT_SWITCHES,
  PromptScope,
  SystemLayerOverride,
  type StoredPromptSettings,
} from "./contract.ts";

type DatabaseRow = {
  scope: PromptScope;
  agent_name: string;
  switches: string;
  custom_text: string;
  system_layer: SystemLayerOverride | null;
  revision: number;
};

const AGENT_PROMPT_PREFIX = "agent_prompt";
const ABSENT_REVISION = 0;
const FIRST_REVISION = 1;
const SYSTEM_AGENT_NAME = "";

function defaultOverride(scope: PromptScope): SystemLayerOverride | null {
  return scope === PromptScope.Agent ? SystemLayerOverride.Inherit : null;
}

function allOn(scope: PromptScope): Record<string, boolean> {
  return Object.fromEntries(PROMPT_SWITCHES[scope].map((name) => [name, true]));
}

export function promptSettings(
  tx: Transaction,
  scope: PromptScope,
  agentName: string = SYSTEM_AGENT_NAME,
): StoredPromptSettings {
  const row = tx.database
    .prepare(
      `SELECT scope, agent_name, switches, custom_text, system_layer, revision
       FROM agent_prompt WHERE scope = ? AND agent_name = ?`,
    )
    .get(scope, agentName) as DatabaseRow | undefined;
  if (!row)
    return {
      scope,
      agent_name: agentName,
      switches: allOn(scope),
      custom_text: "",
      system_layer: defaultOverride(scope),
      revision: ABSENT_REVISION,
    };
  return {
    scope,
    agent_name: agentName,
    switches: { ...allOn(scope), ...JSON.parse(row.switches) },
    custom_text: row.custom_text,
    system_layer: row.system_layer ?? defaultOverride(scope),
    revision: row.revision,
  };
}

export function savePromptSettings(
  tx: Transaction,
  settings: Omit<StoredPromptSettings, "revision">,
  revision: number,
): StoredPromptSettings {
  const now = Date.now();
  if (revision === ABSENT_REVISION)
    tx.database
      .prepare(
        `INSERT INTO agent_prompt
         (id, scope, agent_name, switches, custom_text, system_layer, revision, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        createIdentity(AGENT_PROMPT_PREFIX),
        settings.scope,
        settings.agent_name,
        canonicalJSON(settings.switches),
        settings.custom_text,
        settings.system_layer,
        FIRST_REVISION,
        now,
      );
  else
    tx.database
      .prepare(
        `UPDATE agent_prompt SET switches = ?, custom_text = ?, system_layer = ?, revision = ?, updated_at = ?
         WHERE scope = ? AND agent_name = ?`,
      )
      .run(
        canonicalJSON(settings.switches),
        settings.custom_text,
        settings.system_layer,
        revision + FIRST_REVISION,
        now,
        settings.scope,
        settings.agent_name,
      );
  return promptSettings(tx, settings.scope, settings.agent_name);
}
