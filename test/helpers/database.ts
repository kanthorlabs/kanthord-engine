import fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

export type TemporaryDatabase = Readonly<{ path: string; dispose(): void }>;

export function createTemporaryDatabase(): TemporaryDatabase {
  const dir = fs.mkdtempSync(join(tmpdir(), "kanthord-db-"));
  const dbPath = join(dir, "kanthord.db");

  return {
    path: dbPath,
    dispose() {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
