import assert from "node:assert/strict";
import { test } from "node:test";
import { earlierSectionsOf } from "./earlier-report.ts";

const NO_SECTIONS = 0;
const FIRST_SECTION =
  "## task_1 first\n\nfact one\n\n## Notes\n\nkept in the section";
const SECOND_SECTION =
  "## task_2 second\n\nfact two\n\n## task_9 unknown\n\nstays in the section of task_2";
const UNKNOWN_SECTION = "## task_2 second\n\nfact";

test("a section starts at the heading of a known unit and ends before the next such heading", () => {
  const report = `${FIRST_SECTION}\n\n${SECOND_SECTION}`;
  const sections = earlierSectionsOf(report, ["task_1", "task_2"]);
  assert.deepEqual(sections.get("task_1"), FIRST_SECTION);
  assert.deepEqual(sections.get("task_2"), SECOND_SECTION);
});

test("a null report and a report with no known heading give no section", () => {
  assert.equal(earlierSectionsOf(null, ["task_1"]).size, NO_SECTIONS);
  assert.equal(
    earlierSectionsOf(UNKNOWN_SECTION, ["task_1"]).size,
    NO_SECTIONS,
  );
});
