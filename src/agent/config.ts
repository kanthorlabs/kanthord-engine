import type { Schema } from "convict";
import { isString } from "../kernel/values.ts";

export interface AgentConfig {
  prompt: {
    system_file: string;
    agent_directory: string;
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
  },
};
