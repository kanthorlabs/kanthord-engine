import { relative } from "node:path";

export const WORKSPACES_DIRECTORY = "workspaces";
export const SCRATCH_DIRECTORY = ".kanthord-scratch/";
export const CHECKOUTS_DIRECTORY = "checkouts";
export const RELEASE_DIRECTORY = "release";
export const BASE_DIRECTORY = "base";
export const REVIEW_DIRECTORY = "review";
export { EVIDENCE_DIRECTORY } from "../../agent/review-roots.ts";
export const SCRATCH_STORE_DIRECTORY = "scratch";

export const WorkspaceKind = {
  Node: "node",
  Execution: "execution",
  Review: "review",
} as const;
export type WorkspaceKind = (typeof WorkspaceKind)[keyof typeof WorkspaceKind];
export interface ExamineCheckout {
  name: string;
  directory: string;
  base_branch: string;
}
export interface WorkspaceCheckout {
  binding_id: string;
  name: string;
  directory: string;
  head: string;
}
export function workRepositoriesOf(
  root: string,
  checkouts: readonly ExamineCheckout[],
): ExamineCheckout[] {
  return checkouts.map((checkout) => ({
    ...checkout,
    directory: relative(root, checkout.directory) || ".",
  }));
}
