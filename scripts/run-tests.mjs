import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

function run(command, argv, env) {
  const result = spawnSync(command, argv, {
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
  if (result.error !== undefined) {
    throw result.error;
  }
  return result.status ?? 1;
}

function must(command, argv) {
  const status = run(command, argv);
  if (status !== 0) {
    throw new Error(`${command} ${argv.join(" ")} exited ${status}`);
  }
}

const workDirectory = await mkdtemp(join(tmpdir(), "kanthord-test-binary-"));

try {
  must("pnpm", ["pack", "--pack-destination", workDirectory]);

  const { version } = JSON.parse(await readFile("package.json", "utf8"));
  const prefix = join(workDirectory, "prefix");
  // npm installs the packed artifact the way a consumer would. It manages no
  // dependency of this repository, so it does not follow the package manager.
  must("npm", [
    "install",
    "--global",
    "--prefix",
    prefix,
    join(workDirectory, `kanthord-${version}.tgz`),
  ]);

  const status = run(
    process.execPath,
    ["--test", "--test-timeout=60000", ...process.argv.slice(2)],
    { KANTHORD_E2E_BINARY: join(prefix, "bin", "kanthord") },
  );
  process.exitCode = status;
} finally {
  await rm(workDirectory, { recursive: true, force: true });
}
