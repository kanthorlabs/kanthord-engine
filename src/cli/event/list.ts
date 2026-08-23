import type { Command } from "commander";

import type { DaemonClient } from "../client.ts";
import { eventListResponse } from "../../http/contract/event.ts";
import { eventCommand } from "./index.ts";
import { exitCodeForError } from "../exit-code.ts";

export type RegisterEventListCliInput = Readonly<{
  program: Command;
  client: DaemonClient;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  fail: () => void;
  exit: (code: number) => void;
}>;

type EventListOptions = Readonly<{
  subjectKind?: string;
  subject?: string;
  type?: string;
  actorKind?: string;
  actor?: string;
  after?: string;
  before?: string;
  limit?: string;
  order?: string;
}>;

function renderJson(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    return `[${value.map((item) => renderJson(item) ?? "null").join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Readonly<Record<string, unknown>>;
    const fields = Object.keys(record)
      .sort((left, right) =>
        Buffer.compare(Buffer.from(left), Buffer.from(right)),
      )
      .flatMap((key) => {
        const rendered = renderJson(record[key]);
        return rendered === undefined
          ? []
          : [`${JSON.stringify(key)}:${rendered}`];
      });
    return `{${fields.join(",")}}`;
  }
  return JSON.stringify(value);
}

export function renderPayload(value: unknown): string {
  return renderJson(value) ?? "null";
}

export function registerEventList(input: RegisterEventListCliInput): void {
  const group = eventCommand(input.program);
  if (group.commands.some((command) => command.name() === "list")) {
    return;
  }
  group
    .command("list")
    .description("list events")
    .option("--subject-kind <kind>", "subject kind")
    .option("--subject <id>", "subject id")
    .option("--type <event-type>", "event type")
    .option("--actor-kind <kind>", "actor kind")
    .option("--actor <id>", "actor id")
    .option("--after <event-id>", "event cursor")
    .option("--before <event-id>", "event upper bound")
    .option("--limit <n>", "event limit")
    .option("--order <asc|desc>", "event order")
    .action(async (options: EventListOptions) => {
      const query = Object.fromEntries(
        Object.entries({
          subjectKind: options.subjectKind,
          subject: options.subject,
          type: options.type,
          actorKind: options.actorKind,
          actor: options.actor,
          after: options.after,
          before: options.before,
          limit: options.limit,
          order: options.order,
        }).filter((entry): entry is [string, string] => entry[1] !== undefined),
      );
      const callOptions =
        Object.keys(query).length === 0 ? undefined : { query };
      const result = await input.client.call(
        "event.list",
        undefined,
        undefined,
        callOptions,
      );
      if (!result.ok) {
        input.stderr(`kanthord: ${result.code}: ${result.message}\n`);
        input.exit(exitCodeForError(result.code, result.status));
        return;
      }

      const body = eventListResponse.parse(result.body);
      if (body.events.length === 0) {
        input.stdout("kanthord: no event\n");
        return;
      }
      for (const event of body.events) {
        input.stdout(
          `kanthord: event ${event.createdAt} ${event.id} ${event.actorKind}/${event.actorId} ${event.type} ${event.subjectKind}/${event.subjectId} ${renderPayload(event.payload)}\n`,
        );
      }
    });
}
