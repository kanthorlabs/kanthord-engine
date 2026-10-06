import assert from "node:assert/strict";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { homeRelative } from "../../kernel/xdg.ts";

export function homeRelativeCwd(home: string): InlineExtension {
  assert.ok(home);
  return (pi) => {
    pi.on("before_agent_start", (event) => {
      event.systemPromptOptions.cwd = homeRelative(
        event.systemPromptOptions.cwd,
        home,
      );
    });
  };
}
