import type { Schema } from "convict";
import { isString } from "../kernel/values.ts";

export interface AgentConfig {
  prompt: {
    systemFile: string;
    agentDirectory: string;
  };
}

function pathFormat(value: unknown): void {
  if (!isString(value)) throw new Error("expected a string");
}

export const agentConfigSchema: Schema<AgentConfig> = {
  prompt: {
    systemFile: {
      doc: "Host agent file Markdown path; empty runs host discovery.",
      format: pathFormat,
      default: "",
    },
    agentDirectory: {
      doc: "Agent file directory path; empty means no agent file source.",
      format: pathFormat,
      default: "",
    },
  },
};
