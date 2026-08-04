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
import {
  CliError,
  registerClientOptions,
  requireBaseUrl,
  resolveClientOptions,
} from "./cli/options.ts";
import { registerDbMigrate } from "./cli/db/migrate.ts";
import { registerDbStatus } from "./cli/db/status.ts";
import type { ClientDependencies } from "./cli/client.ts";
import { registry } from "./http/contract/registry.ts";
import { createApp } from "./http/server/app.ts";
import { listen } from "./http/server/start.ts";
import { assertMigrated, StartupError } from "./http/server/migration-gate.ts";
import { healthHandler } from "./http/server/system/health.ts";
import { dbHandler } from "./http/server/system/db.ts";
import { readHealth } from "./queries/system/read-health.ts";
import type { DependencyStatus } from "./queries/system/read-health.ts";
import { readMigrationStatus } from "./queries/system/read-migration-status.ts";

const program = new Command()
  .name("kanthord")
  .version(KANTHORD_VERSION)
  .option("--config <path>", "path to the configuration file")
  .option("--home <path>", "override the configured daemon home");

registerClientOptions(program);

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
      const storage = new SqliteStorage({
        path: join(settings.home, "kanthord.db"),
        clock: new SystemClock(),
        migrations,
      });
      let reachedListen = false;
      try {
        assertMigrated({
          home: settings.home,
          pending: storage.status().pending,
        });
        const reporters = [
          {
            name: "storage",
            probe: (): DependencyStatus => {
              storage.ping();
              return "ok";
            },
          },
        ];
        const handlers = {
          "system.health": healthHandler({
            readHealth: () => readHealth({ reporters }),
          }),
          "system.db": dbHandler({
            readMigrationStatus: () => readMigrationStatus({ storage }),
          }),
        };
        const unimplemented = registry
          .filter((entry) => entry.status === "routed")
          .map((entry) => entry.operationId)
          .filter((operationId) => !(operationId in handlers));
        const app = createApp({
          settings: {
            token: settings.http.token,
            allowedHosts: settings.http.allowedHosts,
          },
          handlers,
          unimplemented,
          onInternalError: (error) =>
            process.stderr.write(
              `kanthord: internal-error: ${String(error)}\n`,
            ),
        });
        await listen(app, {
          bind: settings.http.bind,
          port: settings.http.port,
        });
        reachedListen = true;
        process.stdout.write("kanthord: ready\n");
      } finally {
        if (!reachedListen) {
          storage.close();
        }
      }
    } catch (error) {
      if (
        error instanceof ConfigError ||
        error instanceof HomeLockError ||
        error instanceof StartupError ||
        error instanceof CliError
      ) {
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
  const clientFactory = (): ClientDependencies => {
    const options = resolveClientOptions({ program, env: process.env });
    return {
      baseUrl: requireBaseUrl(options),
      token: options.token,
      fetch: globalThis.fetch,
    };
  };
  registerDbStatus({
    program,
    client: clientFactory,
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    exit: (code) => {
      process.exitCode = code;
    },
  });
  await program.parseAsync(process.argv);
} catch (error) {
  if (
    error instanceof ConfigError ||
    error instanceof HomeLockError ||
    error instanceof StorageError ||
    error instanceof CliError
  ) {
    process.stderr.write(`kanthord: ${error.code}: ${error.message}\n`);
    process.exitCode = 1;
  } else {
    throw error;
  }
}
