import { shippedAsset } from "../kernel/assets.ts";

export const BASE_PROMPT = shippedAsset("prompt/base.md");
export const SWE_AGENT_PROMPT = shippedAsset("prompt/swe@1.md");
export const RE_AGENT_PROMPT = shippedAsset("prompt/re@1.md");
export const PE_AGENT_PROMPT = shippedAsset("prompt/pe@1.md");
export const OPS_AGENT_PROMPT = shippedAsset("prompt/ops@1.md");
export const PLAN_AGENT_PROMPT = shippedAsset("prompt/plan@1.md");
export const WORKBENCH_PROMPT = shippedAsset("prompt/workbench.md");
export const FORK_SUMMARY_PROMPT = shippedAsset("prompt/fork-summary.md");
export const GUARD_PROMPT = shippedAsset("prompt/guard.md");
export const GUARD_SUMMARY_PROMPT = shippedAsset("prompt/guard-summary.md");

export function shippedTemplate(name: string): string {
  return shippedAsset(`prompt/template/${name}.md`);
}
