import { compose } from "node:stream";
import { spec } from "node:test/reporters";

const REPORT_EVENTS = new Set([
  "test:fail",
  "test:stderr",
  "test:summary",
  "test:coverage",
  "test:interrupted",
]);
const DIAGNOSTIC = "test:diagnostic";
const ROOT_NESTING = 0;
const WARNING = "warn";
const ERROR = "error";

async function* reportEvents(source) {
  for await (const event of source) {
    if (REPORT_EVENTS.has(event.type)) {
      yield event;
      continue;
    }
    if (
      event.type === DIAGNOSTIC &&
      (event.data.nesting === ROOT_NESTING ||
        event.data.level === WARNING ||
        event.data.level === ERROR)
    )
      yield event;
  }
}

export default async function* reporter(source) {
  yield* compose(source, reportEvents, new spec());
}
