import type {
  AgentToolResult,
  ExtensionFactory,
  InlineExtension,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";

const REGISTER_TOOL = "registerTool";
const FUNCTION_TYPE = "function";

type NamedExtension = Exclude<InlineExtension, ExtensionFactory>;

export interface ToolAnswers {
  tool(
    name: string,
    callId: string,
    run: () => Promise<AgentToolResult<unknown>>,
  ): Promise<AgentToolResult<unknown>>;
}

function openWorldTool(
  tool: ToolDefinition,
  answers: ToolAnswers,
): ToolDefinition {
  if (tool.annotations?.openWorldHint !== true) return tool;
  return {
    ...tool,
    execute: (...args: Parameters<ToolDefinition["execute"]>) =>
      answers.tool(tool.name, args[0], () => tool.execute(...args)),
  };
}

function factoryOf(
  factory: ExtensionFactory,
  answers: ToolAnswers,
): ExtensionFactory {
  return (pi) =>
    factory(
      new Proxy(pi, {
        get: (target, key, receiver) =>
          key === REGISTER_TOOL
            ? (tool: ToolDefinition) =>
                target.registerTool(openWorldTool(tool, answers))
            : Reflect.get(target, key, receiver),
      }),
    );
}

export function openWorldCapability(
  capability: InlineExtension,
  answers: ToolAnswers,
): InlineExtension {
  if (typeof capability === FUNCTION_TYPE)
    return factoryOf(capability as ExtensionFactory, answers);
  const named = capability as NamedExtension;
  return { ...named, factory: factoryOf(named.factory, answers) };
}
