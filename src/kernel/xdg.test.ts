import assert from "node:assert/strict";
import { test } from "node:test";
import { directories, homeRelative } from "./xdg.ts";

const CUSTOM_CONFIG_DIRECTORY = "/custom/kanthord";
const FALLBACK_DATA_DIRECTORY = "/home/test/.local/share/kanthord";
const TEST_HOME = "/home/test";
const HOME_MARK = "~";
const HOST_AGENT_FILE = "/home/test/.claude/CLAUDE.md";
const RELATIVE_AGENT_FILE = "~/.claude/CLAUDE.md";
const SIBLING_HOME_FILE = "/home/tester/AGENTS.md";
const OUTSIDE_FILE = "/srv/kanthord/AGENTS.md";

test("XDG uses absolute directories and falls back for relative values", () => {
  const paths = directories(
    { XDG_DATA_HOME: "relative", XDG_CONFIG_HOME: "/custom" },
    "/home/test",
  );
  assert.equal(paths.config, CUSTOM_CONFIG_DIRECTORY);
  assert.equal(paths.data, FALLBACK_DATA_DIRECTORY);
});

test("homeRelative writes the home directory as ~ and keeps other paths", () => {
  assert.equal(homeRelative(TEST_HOME, TEST_HOME), HOME_MARK);
  assert.equal(homeRelative(HOST_AGENT_FILE, TEST_HOME), RELATIVE_AGENT_FILE);
  assert.equal(homeRelative(SIBLING_HOME_FILE, TEST_HOME), SIBLING_HOME_FILE);
  assert.equal(homeRelative(OUTSIDE_FILE, TEST_HOME), OUTSIDE_FILE);
});
