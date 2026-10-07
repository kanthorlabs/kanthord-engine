import convict, { type Schema } from "convict";
import { isBoolean, isString } from "../kernel/values.ts";

export interface AgentConfig {
  prompt: {
    system_file: string;
    agent_directory: string;
    host_file: boolean;
  };
}

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
      doc: "Agent file directory path; empty means no agent file source.",
      format: pathFormat,
      default: "",
    },
    host_file: {
      doc: "Host agent file source of the system prompt; false locks its switch off.",
      format: STRICT_BOOLEAN_FORMAT,
      default: true,
    },
  },
};
