import { simpleGit } from "simple-git";
import type { Context } from "../kernel/context.ts";

export async function gitLsRemote(
  sshUrl: string,
  context: Context,
  deadlineMs: number,
): Promise<void> {
  const controller = new AbortController();
  const unsubscribe = context.onCancel(() => controller.abort());
  const timer = setTimeout(() => controller.abort(), deadlineMs);
  try {
    const git = simpleGit({
      abort: controller.signal,
      timeout: { block: deadlineMs },
    });
    await git.raw(["ls-remote", sshUrl]);
  } finally {
    clearTimeout(timer);
    unsubscribe();
  }
}
