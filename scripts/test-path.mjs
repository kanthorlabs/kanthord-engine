import {
  accessSync,
  constants,
  mkdirSync,
  renameSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

const TOOL_DIRECTORY = fileURLToPath(
  new URL("../node_modules/.cache/test-path/", import.meta.url),
);
const TOOLS = ["git", "bash", "ssh"];

function executable(path) {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolve(tool, directories) {
  return directories
    .map((directory) => join(directory, tool))
    .find((path) => executable(path));
}

const path = process.env.PATH ?? "";
const directories = path
  .split(delimiter)
  .filter(
    (directory) =>
      isAbsolute(directory) && join(directory, "/") !== TOOL_DIRECTORY,
  );
mkdirSync(TOOL_DIRECTORY, { recursive: true });
for (const tool of TOOLS) {
  const link = join(TOOL_DIRECTORY, tool);
  const target = resolve(tool, directories);
  if (target) {
    const pending = `${link}.${process.pid}`;
    symlinkSync(target, pending);
    renameSync(pending, link);
  } else {
    rmSync(link, { force: true });
  }
}
process.stdout.write([TOOL_DIRECTORY, path].join(delimiter));
