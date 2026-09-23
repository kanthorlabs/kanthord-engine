import assert from "node:assert/strict";
import { test } from "node:test";
import { directories } from "./xdg.ts";

const CUSTOM_CONFIG_DIRECTORY = "/custom/kanthord";
const FALLBACK_DATA_DIRECTORY = "/home/test/.local/share/kanthord";

test("XDG uses absolute directories and falls back for relative values", () => {
  const paths = directories(
    { XDG_DATA_HOME: "relative", XDG_CONFIG_HOME: "/custom" },
    "/home/test",
  );
  assert.equal(paths.config, CUSTOM_CONFIG_DIRECTORY);
  assert.equal(paths.data, FALLBACK_DATA_DIRECTORY);
});
