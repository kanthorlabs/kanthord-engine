import { GitHubPlatform } from "../repository/github.ts";
import { S3Platform } from "../storage/index.ts";
import type { Dependencies } from "./service.ts";

const CLOSED_LOCAL_PORT = "http://127.0.0.1:9";

function unexpectedCollaboration(): never {
  throw new Error("Unexpected collaboration.");
}

export function unusedActionDependencies(): Pick<
  Dependencies,
  "custody" | "github" | "gitWriter" | "s3"
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
    s3: new S3Platform(),
  };
}
