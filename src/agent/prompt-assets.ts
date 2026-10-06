import { readFileSync } from "node:fs";

export const BASE_PROMPT = readFileSync(
  new URL("../../static/prompt/base.md", import.meta.url),
  "utf8",
);
export const SWE_AGENT_PROMPT = readFileSync(
  new URL("../../static/prompt/swe@1.md", import.meta.url),
  "utf8",
);
export const RE_AGENT_PROMPT = readFileSync(
  new URL("../../static/prompt/re@1.md", import.meta.url),
  "utf8",
);
export const WORKBENCH_PROMPT = readFileSync(
  new URL("../../static/prompt/workbench.md", import.meta.url),
  "utf8",
);
