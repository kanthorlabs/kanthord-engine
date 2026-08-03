#!/usr/bin/env node
import { homedir, hostname } from "node:os";
import { statfsSync } from "node:fs";
import { join } from "node:path";
import { Command } from "commander";
import { ulid } from "ulid";

import { KANTHORD_VERSION } from "./domain/version.ts";
import { ConvictConfig } from "./services/config/convict.ts";
import { ConfigError } from "./services/config/index.ts";
import { StatfsProbe } from "./services/home-lock/statfs-probe.ts";
import { SqliteHomeLock } from "./services/home-lock/sqlite.ts";
import { HomeLockError } from "./services/home-lock/index.ts";
import { SystemClock } from "./services/clock/system.ts";
import { SqliteStorage } from "./services/storage/sqlite.ts";
import { StorageError } from "./services/storage/index.ts";
import { migrations } from "./services/storage/migrations.ts";
import { registerDbMigrate } from "./cli/db/migrate.ts";

const program = new Command()
  .name("kanthord")
  .version(KANTHORD_VERSION)
  .option("--config <path>", "path to the configuration file")
  .option("--home <path>", "override the configured daemon home");

program
  .command("serve")
  .description("run the daemon")
  .action(async () => {
    const options = program.opts();
    try {
      const { settings } = new ConvictConfig().load({
        explicitConfigPath: options.config,
        homeOverride: options.home,
        env: process.env,
        cwd: process.cwd(),
        homeDir: homedir(),
        etcDir: "/etc",
      });
      const probe = new StatfsProbe({
        platform: process.platform,
        statfs: statfsSync,
      });
      const held = new SqliteHomeLock({ probe }).acquire({
        home: settings.home,
      });
      held.publishIdentity({
        version: 1,
        pid: process.pid,
        host: hostname(),
        startedAt: new Date().toISOString(),
        instanceId: ulid(),
      });
      held.sweepRefLocks();
      process.stdout.write("kanthord: ready\n");
      setInterval(() => {}, 1 << 30);
    } catch (error) {
      if (error instanceof ConfigError || error instanceof HomeLockError) {
        process.stderr.write(`kanthord: ${error.code}: ${error.message}\n`);
        process.exitCode = 1;
        return;
      }
      throw error;
    }
  });

try {
  registerDbMigrate({
    program,
    env: process.env,
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    fail: () => {
      process.exitCode = 1;
    },
    migrate: (input) => {
      const home =
        input.home ??
        new ConvictConfig().load({
          explicitConfigPath: program.opts().config,
          env: process.env,
          cwd: process.cwd(),
          homeDir: homedir(),
          etcDir: "/etc",
        }).settings.home;
      const held = new SqliteHomeLock({
        probe: new StatfsProbe({
          platform: process.platform,
          statfs: statfsSync,
        }),
      }).acquire({ home });
      try {
        const storage = new SqliteStorage({
          path: join(home, "kanthord.db"),
          clock: new SystemClock(),
          migrations,
        });
        let failed = false;
        try {
          const before = new Set(
            storage.status().applied.map((entry) => entry.version),
          );
          const after = storage.migrate();
          return after.applied
            .filter((entry) => !before.has(entry.version))
            .map(({ version, name }) => ({ version, name }));
        } catch (error) {
          failed = true;
          throw error;
        } finally {
          try {
            storage.close();
          } catch (closeError) {
            if (!failed) throw closeError;
          }
        }
      } finally {
        held.release();
      }
    },
  });
  await program.parseAsync(process.argv);
} catch (error) {
  if (
    error instanceof ConfigError ||
    error instanceof HomeLockError ||
    error instanceof StorageError
  ) {
    process.stderr.write(`kanthord: ${error.code}: ${error.message}\n`);
    process.exitCode = 1;
  } else {
    throw error;
  }
}
