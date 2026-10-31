import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

export const HOST_PATH = process.env.PATH;
const PNPM_STUB = [
  "#!/bin/sh",
  'if [ "$1" = --version ]; then echo 0.0.0-stub; exit 0; fi',
  '[ "$1 $2 $3" = "--silent run test:files" ] || { echo "pnpm stub: unsupported call: $*" >&2; exit 2; }',
  "shift 3",
  `script=$(node -p 'require("./package.json").scripts["test:files"]') || exit 2`,
  'exec sh -c "$script \\"\\$@\\"" pnpm "$@"',
  "",
].join("\n");
const pnpmStub = mkdtempSync(join(tmpdir(), "kanthord-pnpm-stub-"));
process.on("exit", () => rmSync(pnpmStub, { recursive: true, force: true }));
writeFileSync(join(pnpmStub, "pnpm"), PNPM_STUB, { mode: 0o755 });
process.env.PATH = `${pnpmStub}${delimiter}${HOST_PATH}`;
