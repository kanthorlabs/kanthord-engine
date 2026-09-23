import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
export function temporary(t: TestContext): string {
  process.umask(0o077);
  const parent = join(tmpdir(), "opencode");
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const path = mkdtempSync(join(parent, "kanthord-"));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}
