import assert from "node:assert/strict";
import {
  BuiltinTool,
  EVIDENCE_UPLOAD_PARAMETERS,
  getAgentDeclaration,
} from "../agent/catalog.ts";
import { ToolSource } from "../agent/contract.ts";
import { loadPi, piAgentDirectory } from "../agent/pi.ts";

export async function toolDeclarations(agentName: string): Promise<
  {
    name: string;
    source: ToolSource;
    input_schema: Record<string, unknown>;
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
  const builtin = agent.tools.map((name) => {
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
    ...agent.host_tools.map((name) => ({
      name,
      source: ToolSource.Host,
      input_schema: JSON.parse(
        JSON.stringify(EVIDENCE_UPLOAD_PARAMETERS),
      ) as Record<string, unknown>,
    })),
  ];
}
