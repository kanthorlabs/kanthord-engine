import { execFileSync } from "node:child_process";
import {
  accessSync,
  constants,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

const TOOL_DIRECTORY = fileURLToPath(
  new URL("../node_modules/.cache/test-path/", import.meta.url),
);
const TOOLS = [
  "git",
  "bash",
  "ssh",
  "sh",
  "ssh-add",
  "ssh-agent",
  "ssh-keyscan",
  "ssh-keygen",
  "podman",
  "sleep",
  "ps",
  "mkdir",
  "which",
];
const PENDING = /^(.+)\.(\d+)$/;
const DARWIN_PLATFORM = "darwin";
const GIT = "git";
const TRAMPOLINE_GIT = "/usr/bin/git";
const XCRUN = "/usr/bin/xcrun";

function executable(path) {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

function stale(entry) {
  const pending = PENDING.exec(entry);
  if (!pending) return !TOOLS.includes(entry);
  const pid = Number(pending[2]);
  return !TOOLS.includes(pending[1]) || pid === process.pid || !alive(pid);
}

function blocking(link) {
  try {
    return !lstatSync(link).isSymbolicLink();
  } catch {
    return false;
  }
}

function resolve(tool, directories) {
  return directories
    .map((directory) => join(directory, tool))
    .find((path) => executable(path));
}

function direct(tool, target) {
  if (
    process.platform !== DARWIN_PLATFORM ||
    tool !== GIT ||
    target !== TRAMPOLINE_GIT
  )
    return target;
  try {
    const found = execFileSync(XCRUN, ["-f", tool], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return executable(found) ? found : target;
  } catch {
    return target;
  }
}

const path = process.env.PATH ?? "";
const directories = path
  .split(delimiter)
  .filter(
    (directory) =>
      isAbsolute(directory) && join(directory, "/") !== TOOL_DIRECTORY,
  );
mkdirSync(TOOL_DIRECTORY, { recursive: true });
for (const entry of readdirSync(TOOL_DIRECTORY)) {
  if (stale(entry))
    rmSync(join(TOOL_DIRECTORY, entry), { recursive: true, force: true });
}
for (const tool of TOOLS) {
  const link = join(TOOL_DIRECTORY, tool);
  const target = direct(tool, resolve(tool, directories));
  if (blocking(link)) rmSync(link, { recursive: true, force: true });
  if (target) {
    const pending = `${link}.${process.pid}`;
    symlinkSync(target, pending);
    renameSync(pending, link);
  } else {
    rmSync(link, { force: true });
  }
}
process.stdout.write([TOOL_DIRECTORY, path].join(delimiter));
