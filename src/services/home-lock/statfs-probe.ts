import type { FilesystemProbe, FilesystemKind } from "./index.ts";

export const NETWORK_FILESYSTEM_MAGICS: readonly number[] = [
  0x6969, 0xff534d42, 0xfe534d42, 0x65735546, 0x01021997, 0x00c36400,
  0x0bd00bd0, 0x5346414f, 0x01161970, 0x7461636f,
];

const NETWORK_SET: ReadonlySet<number> = new Set(NETWORK_FILESYSTEM_MAGICS);

export type StatfsProbeDependencies = Readonly<{
  platform: string;
  statfs: (path: string) => Readonly<{ type: number }>;
}>;

export class StatfsProbe implements FilesystemProbe {
  private readonly platform: string;
  private readonly statfs: (path: string) => Readonly<{ type: number }>;

  constructor(dependencies: StatfsProbeDependencies) {
    this.platform = dependencies.platform;
    this.statfs = dependencies.statfs;
  }

  classify(path: string): FilesystemKind {
    if (this.platform !== "linux") return "unknown";
    const result = this.statfs(path);
    return NETWORK_SET.has(result.type) ? "network" : "local";
  }
}
