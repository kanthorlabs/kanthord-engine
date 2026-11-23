import { shippedAsset } from "../kernel/assets.ts";

export const BASE_PROMPT = shippedAsset("prompt/base.md");
export const CODING_PROMPT = shippedAsset("prompt/coding.md");
export const SWE_ROLE_PROMPT = shippedAsset("prompt/role/swe@1.md");
export const RE_ROLE_PROMPT = shippedAsset("prompt/role/re@1.md");
export const SWE_AGENT_PROMPT = shippedAsset("prompt/swe@1.md");
export const RE_AGENT_PROMPT = shippedAsset("prompt/re@1.md");
export const ENV_AGENT_PROMPT = shippedAsset("prompt/env@1.md");
export const WORKBENCH_PROMPT = shippedAsset("prompt/workbench.md");

export function shippedTemplate(name: string): string {
  return shippedAsset(`prompt/template/${name}.md`);
}
