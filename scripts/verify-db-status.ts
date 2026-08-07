import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createTemporaryHome } from "../test/helpers/home.ts";
import { reservePort } from "../test/helpers/port.ts";
import { runCli } from "../test/helpers/cli.ts";
import { launchDaemon } from "../test/helpers/daemon.ts";

export type DbStatusStepDependencies = Readonly<{
  stdout: (text: string) => void;
  reservePort: () => Promise<number>;
  callDbStatus: (
    input: Readonly<{ baseUrl: string; token: string }>,
  ) => Promise<Readonly<{ code: number; stdout: string; stderr: string }>>;
}>;

export type DbStatusStepResult = Readonly<{
  home: string;
  port: number;
  migrated: number;
  daemonPid: number;
  daemonExit: number | null;
}>;

export const systemDbStatusDependencies: DbStatusStepDependencies = {
  stdout(text) {
    process.stdout.write(text);
  },
  reservePort,
  async callDbStatus({ baseUrl, token }) {
    const result = await runCli({
      args: ["db", "status", "--base-url", baseUrl, "--token", token],
    });
    return {
      code: result.code ?? 1,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  },
};

export async function runDbStatusStep(
  dependencies: DbStatusStepDependencies,
): Promise<DbStatusStepResult> {
  const home = createTemporaryHome();
  try {
    const port = await dependencies.reservePort();
    const configPath = home.writeConfig({
      http: { port, allowedHosts: [`127.0.0.1:${port}`] },
    });

    const migrateResult = await runCli({
      args: ["db", "migrate", "--home", home.path],
    });
    if (migrateResult.code !== 0) {
      throw new Error(
        `verify: db migrate exited ${migrateResult.code} (home ${home.path})`,
      );
    }
    dependencies.stdout(migrateResult.stdout);
    const migrated = migrateResult.stdout
      .split("\n")
      .filter((line) => line.length > 0).length;

    const daemon = launchDaemon({ configPath });
    let daemonExit: number | null = null;
    try {
      await daemon.ready();
      const statusResult = await dependencies.callDbStatus({
        baseUrl: `http://127.0.0.1:${port}`,
        token: "test-token",
      });
      if (statusResult.code !== 0) {
        throw new Error(
          `verify: db status exited ${statusResult.code} (home ${home.path})\n${statusResult.stderr}`,
        );
      }
      dependencies.stdout(statusResult.stdout);
    } finally {
      daemon.kill();
      const exit = await daemon.exited();
      daemonExit = exit.code;
    }

    return {
      home: home.path,
      port,
      migrated,
      daemonPid: daemon.pid,
      daemonExit,
    };
  } finally {
    home.dispose();
  }
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    await runDbStatusStep(systemDbStatusDependencies);
    process.stdout.write("kanthord: verify db status ok\n");
  } catch (error) {
    process.stderr.write(`kanthord: verify: ${String(error)}\n`);
    process.exitCode = 1;
  }
}
