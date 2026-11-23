import { join } from "node:path";
import { lstatSync } from "node:fs";
import { userInfo } from "node:os";
import { Diagnostic } from "../../kernel/errors.ts";

const PI_AUTH_FILE = "auth.json";
const AUTH_IN_PI_DIRECTORY = "cli.run.agent.auth_in_pi_directory";
const PI_DIRECTORY_INVALID = "cli.run.agent.pi_directory_invalid";
const TOOL_INSTALL_FAILED = "cli.run.agent.tool_install_failed";

export function checkPiDirectory(piDir: string): void {
  const fields = [["path", piDir]] as [string, string][];
  const stat = lstatSync(piDir, { throwIfNoEntry: false });
  if (stat === undefined) return;

  if (stat.isSymbolicLink())
    throw new Diagnostic(
      PI_DIRECTORY_INVALID,
      "run agent: the pi directory is a symbolic link.",
      { fields },
    );

  if (!stat.isDirectory())
    throw new Diagnostic(
      PI_DIRECTORY_INVALID,
      "run agent: the pi directory is not a directory.",
      { fields },
    );

  const uid = userInfo().uid;
  if (stat.uid !== uid)
    throw new Diagnostic(
      PI_DIRECTORY_INVALID,
      "run agent: another user owns the pi directory.",
      { fields },
    );
}

export function checkAuthNotInPiDirectory(piDir: string): void {
  const authPath = join(piDir, PI_AUTH_FILE);
  const fields = [["path", authPath]] as [string, string][];
  const stat = lstatSync(authPath, { throwIfNoEntry: false });
  if (stat !== undefined)
    throw new Diagnostic(
      AUTH_IN_PI_DIRECTORY,
      "run agent: the pi directory holds an auth.json file.",
      { fields },
    );
}

export function runPiToolInstall(install: () => void): void {
  try {
    install();
  } catch (error) {
    if (error instanceof Diagnostic) {
      throw new Diagnostic(
        TOOL_INSTALL_FAILED,
        "run agent: the pi tool install failed.",
        {
          fields: error.fields,
        },
      );
    }
    throw new Diagnostic(
      TOOL_INSTALL_FAILED,
      "run agent: the pi tool install failed.",
      {
        fields: [["reason", (error as Error).message]],
      },
    );
  }
}
