import type {
  Evidence,
  ReviewRound,
  Revision,
} from "../../mission/contract.ts";

export interface BindingPatch {
  binding_id: string;
  name: string;
  text: string;
}

export interface ReviewScope {
  addedFiles: string[];
  changedFiles: string[];
  patches: BindingPatch[];
  emptyPatches: string[];
}

export interface PlacedPatch extends BindingPatch {
  path: string;
}

export interface PlacedAsset {
  evidence_id: string;
  asset_id: string;
  path: string;
}

export interface ReviewBundle {
  evidence: Evidence[];
  assets: PlacedAsset[];
  added_files: string[];
  changed_files: string[];
  patch_paths: string[];
  empty_patches: string[];
  round?: {
    number: number;
    review_base: NonNullable<ReviewRound["review_base"]>;
  };
}

export interface PlacedReview {
  evidenceIds: string[];
  patches: PlacedPatch[];
  reviewBundle: ReviewBundle;
}

export function verificationCommands(
  revision: Pick<Revision, "content" | "tasks">,
): string[] {
  return [
    ...revision.content.verifications,
    ...revision.tasks.flatMap((task) => task.content.verifications),
  ];
}
