import assert from "node:assert/strict";
import { BuiltinTool, getProfile } from "../agent/catalog.ts";
import { ToolSource } from "../agent/contract.ts";
import { HOST_TOOL_PARAMETERS } from "./contract.ts";
import { loadPi, piAgentDirectory } from "../agent/pi.ts";

export async function toolDeclarations(agentName: string): Promise<
  {
    name: string;
    source: ToolSource;
    input_schema: Record<string, unknown>;
  }[]
> {
  const profile = getProfile(agentName);
  assert.ok(profile, "Tool declarations require a known agent");
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
    profile.tools.builtin.every((name) => Object.hasOwn(factories, name)),
  );
  const builtin = profile.tools.builtin.map((name) => {
    const definition = factories[name](piAgentDirectory());
    return {
      name: definition.name,
      source: ToolSource.Builtin,
      input_schema: JSON.parse(JSON.stringify(definition.parameters)) as Record<
        string,
        unknown
      >,
    };
  });
  return [
    ...builtin,
    ...profile.tools.host.map((name) => ({
      name,
      source: ToolSource.Host,
      input_schema: JSON.parse(
        JSON.stringify(HOST_TOOL_PARAMETERS[name]),
      ) as Record<string, unknown>,
    })),
  ];
}
