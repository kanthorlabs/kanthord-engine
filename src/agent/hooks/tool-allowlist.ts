import type { InlineExtension } from "@earendil-works/pi-coding-agent";

export function toolAllowlist(declared: readonly string[]): InlineExtension {
  const names: ReadonlySet<string> = new Set(declared);
  return (pi) => {
    pi.on("tool_call", (event) =>
      names.has(event.toolName)
        ? undefined
        : {
            block: true,
            reason: `The tool ${event.toolName} is not declared for this agent.`,
          },
    );
  };
}
