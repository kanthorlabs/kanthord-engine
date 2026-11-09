import assert from "node:assert/strict";
import { test } from "node:test";
import { validateToolArguments } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { canonicalJSON } from "../../kernel/json.ts";
import { Diagnostic } from "../../kernel/errors.ts";
import {
  HostTool,
  LINK_UPDATE_LIMIT_DEFAULT,
  LINK_UPDATE_LIMIT_MAX,
  type LinkUpdatePageQuery,
  type LinkUpdateRead,
} from "../contract.ts";
import { unusedHostTools } from "../test-support.ts";
import { linkUpdateListTool } from "./host-tools.ts";

const NO_READS = 0;
const ONE_READ = 1;
const PAGE: LinkUpdateRead = {
  items: [
    {
      id: "link_update_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      external_link: {
        kind: "github_issue",
        resource_identity: "conversation:github:octo/widgets",
        number: 7,
      },
      update_key: "issue_comment:1",
      occurred_at: 1760000000000,
      new: true,
      content: {
        author: "octocat",
        body: "Handle the empty list.",
        url: "https://github.com/octo/widgets/issues/7#issuecomment-1",
        occurred_at: 1760000000000,
      },
    },
  ],
  next_cursor: "next_token",
  total: 25,
};

function harness(failure: Error | null = null) {
  const reads: LinkUpdatePageQuery[] = [];
  const tool = linkUpdateListTool({
    ...unusedHostTools,
    linkUpdateList: async (page) => {
      reads.push(page);
      if (failure) throw failure;
      return PAGE;
    },
  });
  const run = (params: { cursor?: string; limit?: number }) =>
    tool.execute("call", params, undefined, undefined, undefined as never);
  const validate = (arguments_: Record<string, string | number | boolean>) =>
    validateToolArguments(tool as ToolDefinition, {
      type: "toolCall",
      id: "call",
      name: tool.name,
      arguments: arguments_,
    });
  return { reads, tool, run, validate };
}

test("a call with no argument reads the first page with the default limit and answers the canonical page", async () => {
  const h = harness();
  assert.equal(h.tool.name, HostTool.LinkUpdateList);
  const answer = await h.run(h.validate({}));
  assert.deepEqual(h.reads, [{ limit: LINK_UPDATE_LIMIT_DEFAULT }]);
  assert.deepEqual(answer.content, [
    { type: "text", text: canonicalJSON(PAGE) },
  ]);
  assert.deepEqual(answer.details, PAGE);
});

test("a limit of 0 or above 100 refuses before any read", () => {
  const h = harness();
  for (const limit of [NO_READS, LINK_UPDATE_LIMIT_MAX + ONE_READ])
    assert.throws(() => h.validate({ limit }));
  assert.throws(() => h.validate({ extra: true }));
  assert.equal(h.reads.length, NO_READS);
});

test("a refusal of the read becomes the tool error with its code and message", async () => {
  const refused = new Diagnostic(
    "mission.authorization.refused",
    "The facility refuses the operation.",
  );
  const h = harness(refused);
  await assert.rejects(
    h.run({}),
    new RegExp(`${refused.code}: ${refused.message}`),
  );
});
