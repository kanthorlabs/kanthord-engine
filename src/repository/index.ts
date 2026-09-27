import type { Context } from "../kernel/context.ts";
import { checkRepositoryTools } from "./check.ts";
import { gitLsRemote } from "./connector.ts";

export class RepositoryComponent {
  constructor() {
    checkRepositoryTools();
  }

  gitLsRemote(
    sshUrl: string,
    context: Context,
    deadlineMs: number,
  ): Promise<void> {
    return gitLsRemote(sshUrl, context, deadlineMs);
  }
}
