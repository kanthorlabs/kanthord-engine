import { shippedAsset } from "../kernel/assets.ts";

export const BASE_PROMPT = shippedAsset("prompt/base.md");
export const SWE_AGENT_PROMPT = shippedAsset("prompt/swe@1.md");
export const RE_AGENT_PROMPT = shippedAsset("prompt/re@1.md");
export const WORKBENCH_PROMPT = shippedAsset("prompt/workbench.md");
export const COUNCIL_AGENT_PROMPT = shippedAsset("prompt/council@1.md");
export const PO_AGENT_PROMPT = shippedAsset("prompt/po@1.md");
export const DESIGNER_AGENT_PROMPT = shippedAsset("prompt/designer@1.md");
export const USER_AGENT_PROMPT = shippedAsset("prompt/user@1.md");
export const ARCHITECT_AGENT_PROMPT = shippedAsset("prompt/architect@1.md");
export const SECURITY_AGENT_PROMPT = shippedAsset("prompt/security@1.md");

export function shippedTemplate(name: string): string {
  return shippedAsset(`prompt/template/${name}.md`);
}
