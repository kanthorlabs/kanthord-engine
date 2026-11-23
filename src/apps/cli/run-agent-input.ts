import { realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { Diagnostic } from "../../kernel/errors.ts";
import { readTextFile } from "./shared.ts";

const AUTH_PLACE = "cli.run.agent.auth_place";
const PROMPT_PLACE = "cli.run.agent.prompt_place";
const PROMPT_MISSING = "cli.run.agent.prompt_missing";
export const PROMPT_TEXT_PATH = "cli.run.agent.prompt_text_path";

const PATH_MAX_BYTES = 4096;
const TRAILING_LINEBREAKS = /(\r\n|\n)+$/;

function hasWhitespace(value: string): boolean {
  return /[ \t\r\n]/.test(value);
}

function hasLineBreakOrNul(value: string): boolean {
  return /[\n\r\0]/.test(value);
}

export function looksLikePath(value: string): boolean {
  if (hasLineBreakOrNul(value)) return false;

  const byteLength = Buffer.byteLength(value, "utf-8");
  if (!byteLength || byteLength > PATH_MAX_BYTES) return false;

  if (
    value.startsWith("/") ||
    value.startsWith("./") ||
    value.startsWith("../")
  )
    return true;

  if (hasWhitespace(value)) return false;

  if (value.includes("/")) return true;

  if (/\.[a-zA-Z0-9]{1,8}$/.test(value)) return true;

  return false;
}

function isUnder(candidate: string, dir: string): boolean {
  return candidate.startsWith(dir + "/") || candidate === dir;
}

function isDevOrProc(p: string): boolean {
  return isUnder(p, "/dev") || isUnder(p, "/proc");
}

export interface AuthDevIno {
  dev: number;
  ino: number;
}

export interface InputValueResult {
  text: string;
  notice: boolean;
}

export interface InputContext {
  currentDir: string;
  authDevIno: AuthDevIno | null;
  piDirectory: string;
  configDirectories: readonly string[];
}

function tryRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

export function resolveInputValue(
  value: string,
  context: InputContext,
): InputValueResult {
  if (!looksLikePath(value)) return { text: value, notice: false };

  const { currentDir, authDevIno, piDirectory, configDirectories } = context;
  const absPath = resolve(currentDir, value);
  const fields = [["path", absPath]] as [string, string][];

  if (isDevOrProc(absPath))
    throw new Diagnostic(
      PROMPT_PLACE,
      "run agent: the prompt path lies under /dev or /proc.",
      { fields },
    );

  const entryStat = statSync(absPath, { throwIfNoEntry: false });
  if (entryStat === undefined) return { text: value, notice: true };

  if (
    authDevIno !== null &&
    entryStat.dev === authDevIno.dev &&
    entryStat.ino === authDevIno.ino
  )
    throw new Diagnostic(
      AUTH_PLACE,
      "run agent: the prompt path is the --auth file.",
      { fields },
    );

  const realPath = tryRealpath(absPath);

  if (isDevOrProc(realPath))
    throw new Diagnostic(
      PROMPT_PLACE,
      "run agent: the prompt real path lies under /dev or /proc.",
      { fields },
    );

  if (
    configDirectories.some((directory) =>
      isUnder(realPath, tryRealpath(directory)),
    ) ||
    isUnder(realPath, tryRealpath(piDirectory))
  )
    throw new Diagnostic(
      AUTH_PLACE,
      "run agent: the prompt path lies in the KanthorD configuration or pi directory.",
      { fields },
    );

  const text = readTextFile(absPath);
  return { text, notice: false };
}

export function buildPromptText(rawParts: string[]): string {
  const parts = rawParts
    .map((p) => p.replace(TRAILING_LINEBREAKS, ""))
    .filter((p) => p.length);

  if (!parts.length)
    throw new Diagnostic(
      PROMPT_MISSING,
      "run agent: the prompt has no text.",
      {},
    );

  return parts.join("\n\n");
}
