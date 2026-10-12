import convict, { type Schema } from "convict";
import { isBoolean, isString } from "../kernel/values.ts";

export interface AgentConfig {
  prompt: {
    system_file: string;
    agent_directory: string;
    host_file: boolean;
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

const STRICT_BOOLEAN_FORMAT = "agent-strict-boolean";

convict.addFormat({
  name: STRICT_BOOLEAN_FORMAT,
  validate(value: unknown) {
    if (!isBoolean(value)) throw new Error("expected a boolean");
  },
});

export const agentConfigSchema: Schema<AgentConfig> = {
  prompt: {
    system_file: {
      doc: "Host agent file Markdown path; empty runs host discovery.",
      format: pathFormat,
      default: "",
    },
    agent_directory: {
      doc: "Agent file directory path, relative to the data directory; empty means no agent file source.",
      format: pathFormat,
      default: "agents",
    },
    host_file: {
      doc: "Host agent file source of the system prompt; false locks its switch off.",
      format: STRICT_BOOLEAN_FORMAT,
      default: true,
    },
  },
  cooldown: {
    rate_limited_ms: {
      doc: "Base cooldown in milliseconds of a chain entry after a rate_limited provider failure.",
      format: "nat",
      default: COOLDOWN_DEFAULTS.rate_limited_ms,
    },
    unavailable_ms: {
      doc: "Base cooldown in milliseconds of a chain entry after an unavailable provider failure.",
      format: "nat",
      default: COOLDOWN_DEFAULTS.unavailable_ms,
    },
    quota_exhausted_ms: {
      doc: "Base cooldown in milliseconds of a chain entry after a quota_exhausted provider failure.",
      format: "nat",
      default: COOLDOWN_DEFAULTS.quota_exhausted_ms,
    },
    max_ms: {
      doc: "Maximum cooldown in milliseconds of a chain entry; each strike doubles the base up to this value.",
      format: "nat",
      default: COOLDOWN_DEFAULTS.max_ms,
    },
  },
};
