import { GitHubPlatform } from "../repository/github.ts";
import type { Dependencies } from "./service.ts";

function unexpectedCollaboration(): never {
  throw new Error("Unexpected collaboration.");
}

export function unusedActionDependencies(): Pick<
  Dependencies,
  "custody" | "github" | "gitWriter"
> {
  return {
    custody: {
      authorizeOperation: unexpectedCollaboration,
      release: unexpectedCollaboration,
      consume: unexpectedCollaboration,
      grantFacts: unexpectedCollaboration,
    },
    github: new GitHubPlatform(),
    gitWriter: {
      mergePushFresh: unexpectedCollaboration,
      pushSnapshotFresh: unexpectedCollaboration,
      landedOn: unexpectedCollaboration,
    },
  };
}
