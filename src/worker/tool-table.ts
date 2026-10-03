import assert from "node:assert/strict";
import { BuiltinTool, getAgentDeclaration } from "./catalog.ts";
import { loadPi, piAgentDirectory } from "./pi.ts";

import { ToolSource } from "./contract.ts";
export { ToolSource } from "./contract.ts";

export async function toolDeclarations(agentName: string): Promise<
  {
    name: string;
    source: ToolSource;
    inputSchema: Record<string, unknown>;
  }[]
> {
  const agent = getAgentDeclaration(agentName);
  assert.ok(agent, "Tool declarations require a known agent");
  const pi = await loadPi();
  const factories = {
    [BuiltinTool.Read]: pi.createReadToolDefinition,
    [BuiltinTool.Edit]: pi.createEditToolDefinition,
    [BuiltinTool.Write]: pi.createWriteToolDefinition,
    [BuiltinTool.Grep]: pi.createGrepToolDefinition,
    [BuiltinTool.Find]: pi.createFindToolDefinition,
    [BuiltinTool.Ls]: pi.createLsToolDefinition,
    [BuiltinTool.Bash]: pi.createBashToolDefinition,
  };
  assert.ok(agent.tools.every((name) => Object.hasOwn(factories, name)));
  return agent.tools.map((name) => {
    const definition = factories[name](piAgentDirectory());
    return {
      name: definition.name,
      source: ToolSource.Builtin,
      inputSchema: JSON.parse(JSON.stringify(definition.parameters)) as Record<
        string,
        unknown
      >,
    };
  });
}
