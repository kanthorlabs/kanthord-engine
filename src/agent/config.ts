import type { Schema } from "convict";
import { isString } from "../kernel/values.ts";

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
      format: Boolean,
      default: true,
    },
  },
};
