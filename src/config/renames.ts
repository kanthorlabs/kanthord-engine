export interface ConfigRename {
  readonly from: string;
  readonly to: string;
}

export const CONFIG_RENAMES: readonly ConfigRename[] = [
  {
    from: "mission.consecutive_loss_limit",
    to: "mission.consecutive_failure_limit",
  },
];

export function renameOf(path: string): ConfigRename | undefined {
  return CONFIG_RENAMES.find((rename) => rename.from === path);
}
