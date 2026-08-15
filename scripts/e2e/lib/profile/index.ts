export type ProfileName = "fixture" | "real";

export type ScenarioProfile = Readonly<{
  name: ProfileName;
  origin: string;
  credentialArguments: readonly string[];
  defaultBranch: string;
  planDirectory: string;
  expectedObjectiveCount: number;
  expectedTaskCount: number;
  expectedPendingTaskCount: number;
  expectedReadyTaskCount: number;
  fixtureRoot: string | null;
  expectedObjectIds: Readonly<Record<string, string>> | null;
}>;

export const profileFieldNames: readonly (keyof ScenarioProfile)[] = [
  "name",
  "origin",
  "credentialArguments",
  "defaultBranch",
  "planDirectory",
  "expectedObjectiveCount",
  "expectedTaskCount",
  "expectedPendingTaskCount",
  "expectedReadyTaskCount",
  "fixtureRoot",
  "expectedObjectIds",
];
