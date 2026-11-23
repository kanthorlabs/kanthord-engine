import assert from "node:assert/strict";
import type {
  InlineExtension,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { canonicalJSON } from "../../../kernel/json.ts";
import {
  HostTool,
  type HostTools,
  LINK_UPDATE_LIMIT_DEFAULT,
  LINK_UPDATE_LIST_PARAMETERS,
  linkUpdateReadSchema,
} from "../../contract.ts";
import { asToolError, type SessionHostTools } from "./host-tools.ts";

type LinkUpdateListTool = ToolDefinition<typeof LINK_UPDATE_LIST_PARAMETERS>;

const DECLARATION = {
  name: HostTool.LinkUpdateList,
  label: "List link updates",
  description:
    "List a page of the updates of the external links of this node, newest first. Pass the cursor of a page to read the next page.",
  parameters: LINK_UPDATE_LIST_PARAMETERS,
  annotations: { openWorldHint: false },
} satisfies Omit<LinkUpdateListTool, "execute">;

export function linkUpdateListTool(hostTools: HostTools): LinkUpdateListTool {
  assert.ok(hostTools);
  assert.ok(hostTools.linkUpdateList);
  return {
    ...DECLARATION,
    async execute(_id, params, signal) {
      const result = linkUpdateReadSchema.parse(
        await asToolError(() =>
          hostTools.linkUpdateList(
            {
              ...(params.cursor === undefined ? {} : { cursor: params.cursor }),
              limit: params.limit ?? LINK_UPDATE_LIMIT_DEFAULT,
            },
            signal,
          ),
        ),
      );
      return {
        content: [{ type: "text", text: canonicalJSON(result) }],
        details: result,
      };
    },
  };
}

export function linkUpdates(tools: SessionHostTools): InlineExtension {
  assert.ok(tools);
  return (pi) => {
    pi.registerTool({
      ...DECLARATION,
      execute: (...args: Parameters<LinkUpdateListTool["execute"]>) =>
        linkUpdateListTool(tools(args[4].cwd)).execute(...args),
    });
  };
}
