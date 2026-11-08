import type { Command } from "commander";
import { Diagnostic } from "../../kernel/errors.ts";
import { identitySchema } from "../../kernel/identity.ts";
import {
  INBOX_ITEM_LIMIT_MAX,
  inboxItemDoneSchema,
  InboxItemState,
  LINK_UPDATE_IDENTITY_PREFIX,
} from "../../mission/contract.ts";
import {
  addMutationOptions,
  addPagination,
  client,
  mutate,
  pagination,
  printResult,
} from "./mission-support.ts";
import { missionExamples } from "./mission-examples.ts";
import { validateProjectId } from "./project.ts";
import { singleUse } from "./shared.ts";

const LIST_INVALID_PROJECT_ID =
  "cli.mission.inbox_item.list.invalid_project_id";
const LIST_INVALID_STATE = "cli.mission.inbox_item.list.invalid_state";
const LIST_LIMIT_OUT_OF_RANGE = "cli.pagination.limit_out_of_range";
const DONE_INVALID_LINK_UPDATE_ID =
  "cli.mission.inbox_item.done.invalid_link_update_id";
const LIST = "inbox_item.list";
const DONE = "inbox_item.done";
const STATES = Object.values(InboxItemState);

export function addInboxItemCommands(mission: Command): void {
  const inboxItem = mission
    .command("inbox-item")
    .description("Mission inbox threads of the developer");
  inboxItem.action(() => inboxItem.help());
  addPagination(
    inboxItem
      .command("list")
      .description("List the inbox threads as JSON")
      .option("--project <project-id>", "Project ID", singleUse("--project"))
      .option(
        "--state <state>",
        `Thread state (${STATES.join(", ")}; default: open)`,
        singleUse("--state"),
      ),
  ).action(async (_options, command: Command) => {
    const options = command.optsWithGlobals();
    if (options.project !== undefined)
      validateProjectId(options.project, LIST_INVALID_PROJECT_ID);
    const state = options.state;
    if (state !== undefined && !STATES.some((known) => known === state))
      throw new Diagnostic(LIST_INVALID_STATE, "invalid inbox item state");
    const page = pagination(options);
    if (page.limit > INBOX_ITEM_LIMIT_MAX)
      throw new Diagnostic(
        LIST_LIMIT_OUT_OF_RANGE,
        `limit must be at most ${INBOX_ITEM_LIMIT_MAX}`,
      );
    printResult(
      await client(command, LIST)[LIST]({
        params: {},
        query: {
          ...page,
          ...(options.project === undefined
            ? {}
            : { project_id: options.project }),
          ...(state === undefined ? {} : { state }),
        },
        body: null,
      }),
      LIST,
    );
  });
  addMutationOptions(
    inboxItem
      .command("done")
      .description("Mark an inbox row done, or snooze it until a time")
      .argument("<link-update-id>", "Link update ID"),
    { schema: inboxItemDoneSchema, example: missionExamples.inboxItemDone },
  ).action(async (linkUpdateId: string, _options, command: Command) => {
    if (
      !identitySchema(LINK_UPDATE_IDENTITY_PREFIX).safeParse(linkUpdateId)
        .success
    )
      throw new Diagnostic(
        DONE_INVALID_LINK_UPDATE_ID,
        "invalid link update ID",
      );
    await mutate(command, DONE, inboxItemDoneSchema, (api, body, key) =>
      api[DONE](
        { params: { link_update_id: linkUpdateId }, query: {}, body },
        { idempotencyKey: key },
      ),
    );
  });
}
