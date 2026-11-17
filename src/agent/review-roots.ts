import { join } from "node:path";

export const EVIDENCE_DIRECTORY = "evidence";

export interface ReviewRoots {
  key: string;
  directory: string;
}

export function reviewRootsOf(workspace: ReviewRoots): string[] {
  return workspace.key === workspace.directory
    ? [workspace.directory]
    : [workspace.directory, join(workspace.key, EVIDENCE_DIRECTORY)];
}
