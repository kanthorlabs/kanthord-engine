import { lstatSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { userInfo } from "node:os";
import { Diagnostic } from "../../kernel/errors.ts";

const SESSION_EXISTS = "cli.run.agent.session_exists";
const SESSION_DIRECTORY_INVALID = "cli.run.agent.session_directory_invalid";
const SESSION_DIRECTORY_OWNER = "cli.run.agent.session_directory_owner";
const SESSION_DIRECTORY_MODE = "cli.run.agent.session_directory_mode";
const SESSION_PLACE = "cli.run.agent.session_place";

const GROUP_OTHER_WRITE = 0o022;

function isUnder(path: string, dir: string): boolean {
  return path.startsWith(dir + "/") || path === dir;
}

function realPathOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function realParentOf(sessionPath: string, fields: [string, string][]): string {
  try {
    return realpathSync(dirname(sessionPath));
  } catch {
    throw new Diagnostic(
      SESSION_DIRECTORY_INVALID,
      "run agent: the parent directory of the session path is absent or not a directory.",
      { fields },
    );
  }
}

export function checkSessionPath(
  sessionPath: string,
  workspaceRealPath: string,
  piDirectoryPath: string,
): void {
  const absolute = resolve(sessionPath);
  const fields = [["path", absolute]] as [string, string][];

  const entry = lstatSync(absolute, { throwIfNoEntry: false });
  if (entry !== undefined)
    throw new Diagnostic(
      SESSION_EXISTS,
      "run agent: a file or directory already exists at the session path.",
      { fields },
    );

  const realParent = realParentOf(absolute, fields);
  const parentStat = statSync(realParent, { throwIfNoEntry: false });
  if (!parentStat?.isDirectory())
    throw new Diagnostic(
      SESSION_DIRECTORY_INVALID,
      "run agent: the parent directory of the session path is absent or not a directory.",
      { fields },
    );

  const uid = userInfo().uid;
  if (parentStat.uid !== uid)
    throw new Diagnostic(
      SESSION_DIRECTORY_OWNER,
      "run agent: another user owns the parent directory of the session path.",
      { fields },
    );

  if (parentStat.mode & GROUP_OTHER_WRITE)
    throw new Diagnostic(
      SESSION_DIRECTORY_MODE,
      "run agent: the parent directory of the session path has a group or other write bit.",
      { fields },
    );

  const realSession = join(realParent, basename(absolute));
  if (isUnder(realSession, realPathOrSelf(workspaceRealPath)))
    throw new Diagnostic(
      SESSION_PLACE,
      "run agent: the session file path is inside the workspace.",
      { fields },
    );

  if (isUnder(realSession, realPathOrSelf(piDirectoryPath)))
    throw new Diagnostic(
      SESSION_PLACE,
      "run agent: the session file path is inside the pi directory.",
      { fields },
    );
}
