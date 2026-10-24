import type { Schema } from "convict";
import { isString } from "../kernel/values.ts";

export interface AgentConfig {
  prompt: {
    agent_directory: string;
  };
  cooldown: {
    rate_limited_ms: number;
    unavailable_ms: number;
    quota_exhausted_ms: number;
    max_ms: number;
  };
}

export const COOLDOWN_DEFAULTS: AgentConfig["cooldown"] = {
  rate_limited_ms: 60000,
  unavailable_ms: 60000,
  quota_exhausted_ms: 3600000,
  max_ms: 86400000,
};

function pathFormat(value: unknown): void {
  if (!isString(value)) throw new Error("expected a string");
}

export const agentConfigSchema: Schema<AgentConfig> = {
  prompt: {
    agent_directory: {
      doc: "Prompt override directory path, relative to the data directory; base.md, <agent>.md, workbench.md and prompts/<template>.md there replace the shipped text; empty means shipped text only.",
      format: pathFormat,
      default: "agents",
    },
  },
  cooldown: {
    rate_limited_ms: {
      doc: "Base cooldown in milliseconds of a credential after a rate_limited provider failure.",
      format: "nat",
      default: COOLDOWN_DEFAULTS.rate_limited_ms,
    },
    unavailable_ms: {
      doc: "Base cooldown in milliseconds of a credential after an unavailable provider failure.",
      format: "nat",
      default: COOLDOWN_DEFAULTS.unavailable_ms,
    },
    quota_exhausted_ms: {
      doc: "Base cooldown in milliseconds of a credential after a quota_exhausted provider failure.",
      format: "nat",
      default: COOLDOWN_DEFAULTS.quota_exhausted_ms,
    },
    max_ms: {
      doc: "Maximum cooldown in milliseconds of a credential; each strike doubles the base up to this value.",
      format: "nat",
      default: COOLDOWN_DEFAULTS.max_ms,
    },
  },
};
