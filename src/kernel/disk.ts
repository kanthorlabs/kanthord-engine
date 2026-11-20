import { statfs } from "node:fs/promises";

export interface DiskSpace {
  free_bytes: number;
  total_bytes: number;
}

export async function freeDiskOf(directory: string): Promise<DiskSpace> {
  const space = await statfs(directory);
  return {
    free_bytes: space.bavail * space.bsize,
    total_bytes: space.blocks * space.bsize,
  };
}
