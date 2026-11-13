import assert from "node:assert/strict";
import {
  BuiltinTool,
  getAgentDeclaration,
  HOST_TOOL_PARAMETERS,
} from "../agent/catalog.ts";
import { type ToolDeclaration, ToolSource } from "../agent/contract.ts";
import { loadPi, piAgentDirectory } from "../agent/pi.ts";

export async function toolDeclarations(
  agentName: string,
): Promise<ToolDeclaration[]> {
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
  assert.ok(
    agent.tools.builtin.every((name) => Object.hasOwn(factories, name)),
  );
  const builtin = agent.tools.builtin.map((name) => {
    const definition = factories[name](piAgentDirectory());
    return {
      name: definition.name,
      source: ToolSource.Builtin,
      description: "",
      guard_class: null,
      input_schema: JSON.parse(JSON.stringify(definition.parameters)) as Record<
        string,
        unknown
      >,
    };
  });
  return [
    ...builtin,
    ...agent.tools.host.map((name) => ({
      name,
      source: ToolSource.Host,
      description: "",
      guard_class: null,
      input_schema: JSON.parse(
        JSON.stringify(HOST_TOOL_PARAMETERS[name]),
      ) as Record<string, unknown>,
    })),
  ];
}
