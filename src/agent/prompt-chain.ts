import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { BASE_PROMPT } from "./prompt-assets.ts";
import { getProfile, type ProfileName } from "./catalog.ts";

export interface PromptText {
  heading: string | null;
  text: string;
}

const PART_SEPARATOR = "\n\n";

function renderPart(p: PromptText): string {
  return p.heading === null ? p.text : `${p.heading}${PART_SEPARATOR}${p.text}`;
}

export function composeSystemPrompt(
  profile: readonly PromptText[],
  instructions: readonly PromptText[],
): string {
  assert.ok(profile.length);
  return [...profile, ...instructions].map(renderPart).join(PART_SEPARATOR);
}

export function profilePrompt(name: ProfileName): readonly PromptText[] {
  const profile = getProfile(name);
  assert.ok(profile);
  return [
    { heading: null, text: BASE_PROMPT },
    ...(profile.prompt.coding !== null
      ? [{ heading: null, text: profile.prompt.coding }]
      : []),
    { heading: null, text: profile.prompt.role },
  ];
}

export function systemPromptDigest(composed: string): string {
  return createHash("sha256").update(composed, "utf8").digest("hex");
}
