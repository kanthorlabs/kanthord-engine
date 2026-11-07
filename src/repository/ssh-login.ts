import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import type { Context } from "../kernel/context.ts";
import { isolatedGitEnvironment } from "../kernel/git-environment.ts";

const execFileAsync = promisify(execFile);
const SSH_URL_PREFIX = "ssh://";
const SCP_ADDRESS = /^([^@/\s]+@[^:/\s]+):/;
const LOGIN_GREETING = /^Hi ([A-Za-z0-9-]+)! /m;
const EXIT_AUTHENTICATED = 1;
const TIMEOUT_MIN_MS = 1;
const EMPTY_TEXT = "";
const TARGET_FIELD = 1;
const LOGIN_FIELD = 1;
const exitFailureSchema = z.looseObject({
  code: z.number().int(),
  stderr: z.string().default(EMPTY_TEXT),
});

function sshTargetOf(address: string): string | null {
  assert.ok(address);
  if (address.startsWith(SSH_URL_PREFIX)) {
    const url = new URL(address);
    return url.username === EMPTY_TEXT
      ? url.hostname
      : `${url.username}@${url.hostname}`;
  }
  return SCP_ADDRESS.exec(address)?.[TARGET_FIELD] ?? null;
}

export async function sshLoginOf(
  request: { address: string; command: string },
  context: Context,
  deadlineMs: number,
): Promise<string | null> {
  assert.ok(request.command);
  const target = sshTargetOf(request.address);
  if (target === null) return null;
  let stderr = EMPTY_TEXT;
  try {
    await execFileAsync(
      "sh",
      ["-c", `${request.command} -T -n -- "$1"`, "sh", target],
      {
        env: isolatedGitEnvironment(process.env),
        signal: context.signal,
        timeout: Math.max(deadlineMs, TIMEOUT_MIN_MS),
      },
    );
  } catch (error) {
    const exit = exitFailureSchema.safeParse(error);
    if (!exit.success) throw error;
    if (exit.data.code !== EXIT_AUTHENTICATED) return null;
    stderr = exit.data.stderr;
  }
  return LOGIN_GREETING.exec(stderr)?.[LOGIN_FIELD] ?? null;
}
