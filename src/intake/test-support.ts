import { GitHubPlatform } from "../repository/github.ts";
import type { Dependencies } from "./service.ts";

const CLOSED_LOCAL_PORT = "http://127.0.0.1:9";

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
    github: new GitHubPlatform({ baseUrl: CLOSED_LOCAL_PORT }),
    gitWriter: {
      mergePushFresh: unexpectedCollaboration,
      pushSnapshotFresh: unexpectedCollaboration,
      landedOn: unexpectedCollaboration,
    },
  };
}
