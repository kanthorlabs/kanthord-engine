#!/usr/bin/env node
import { homedir, hostname } from "node:os";
import { readFileSync, statfsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { Command } from "commander";
import { ulid } from "ulid";

import { KANTHORD_VERSION } from "./domain/version.ts";
import { ConvictConfig } from "./services/config/convict.ts";
import { ConfigError } from "./services/config/index.ts";
import { StatfsProbe } from "./services/home-lock/statfs-probe.ts";
import { SqliteHomeLock } from "./services/home-lock/sqlite.ts";
import { HomeLockError } from "./services/home-lock/index.ts";
import {
  buildGitPaths,
  probeTools,
  ToolProbeError,
} from "./services/git/probe.ts";
import { createGitRunner } from "./services/git/run.ts";
import { createBinaryGit } from "./services/git/binary.ts";
import { SystemClock } from "./services/clock/system.ts";
import { SqliteStorage } from "./services/storage/sqlite.ts";
import { StorageError } from "./services/storage/index.ts";
import { migrations } from "./services/storage/migrations.ts";
import { AesGcmCrypto } from "./services/crypto/aes-gcm.ts";
import { SqliteEventLog } from "./services/event/sqlite.ts";
import { UlidIdGenerator } from "./services/ids/ulid.ts";
import { registerProvider } from "./commands/provider/register-provider.ts";
import { listProviders } from "./queries/provider/list-provider.ts";
import { showProvider } from "./queries/provider/show-provider.ts";
import { inspectRepository } from "./queries/repository/inspect-repository.ts";
import { listRepositories } from "./queries/repository/list-repository.ts";
import { showRepository } from "./queries/repository/show-repository.ts";
import { registerRepository } from "./commands/repository/register-repository.ts";
import { registerProviderHandler } from "./http/server/credential/register-provider.ts";
import { listProviderHandler } from "./http/server/credential/list-provider.ts";
import { showProviderHandler } from "./http/server/credential/show-provider.ts";
import { inspectRepositoryHandler } from "./http/server/repository/inspect-repository.ts";
import { listRepositoryHandler } from "./http/server/repository/list-repository.ts";
import { showRepositoryHandler } from "./http/server/repository/show-repository.ts";
import { registerRepositoryHandler } from "./http/server/repository/register-repository.ts";
import {
  CliError,
  registerClientOptions,
  requireBaseUrl,
  resolveClientOptions,
} from "./cli/options.ts";
import { registerDbMigrate } from "./cli/db/migrate.ts";
import { registerDbStatus } from "./cli/db/status.ts";
import { registerCredentialRegister } from "./cli/credential/register.ts";
import { registerRepositoryRegister } from "./cli/repository/register.ts";
import { registerRepositoryShow } from "./cli/repository/show.ts";
import {
  call,
  type ClientDependencies,
  type DaemonClient,
} from "./cli/client.ts";
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
      const probed = await probeTools({
        tools: settings.tools,
        runDirectory: join(settings.home, "git", "run"),
      });
      const gitPaths = buildGitPaths({ probed, home: settings.home });
      const gitRunner = createGitRunner(gitPaths);
      const git = createBinaryGit({
        runner: gitRunner,
        paths: gitPaths,
      });
      const clock = new SystemClock();
      const storage = new SqliteStorage({
        path: join(settings.home, "kanthord.db"),
        clock,
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
        const ids = new UlidIdGenerator();
        const crypto = new AesGcmCrypto({
          key: settings.masterKey,
          keyVersion: 1,
        });
        const events = new SqliteEventLog({ storage, ids });
        const handlers = {
          "system.health": healthHandler({
            readHealth: () => readHealth({ reporters }),
          }),
          "system.db": dbHandler({
            readMigrationStatus: () => readMigrationStatus({ storage }),
          }),
          "provider.register": registerProviderHandler({
            registerProvider: (input) =>
              registerProvider({ storage, crypto, ids, clock, events }, input),
            actor: settings.actor,
          }),
          "provider.list": listProviderHandler({
            listProviders: (input) => listProviders({ storage, crypto }, input),
          }),
          "provider.show": showProviderHandler({
            showProvider: (input) => showProvider({ storage, crypto }, input),
          }),
          "repository.inspect": inspectRepositoryHandler({
            inspectRepository: (input) =>
              inspectRepository({ storage, crypto, git }, input),
          }),
          "repository.register": registerRepositoryHandler({
            registerRepository: (input) =>
              registerRepository(
                {
                  storage,
                  crypto,
                  ids,
                  clock,
                  events,
                  git,
                  readRepositoryView: (id) =>
                    showRepository({ storage, git }, { id }),
                  homeRoot: settings.home,
                },
                input,
              ),
            actor: settings.actor,
          }),
          "repository.list": listRepositoryHandler({
            listRepositories: (input) =>
              listRepositories({ storage, git }, input),
          }),
          "repository.show": showRepositoryHandler({
            showRepository: (input) => showRepository({ storage, git }, input),
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
        error instanceof CliError ||
        error instanceof ToolProbeError
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
  const client: DaemonClient = {
    call: (operationId, body, parameters) =>
      call(clientFactory(), { operationId, body, parameters }),
  };
  const confirm = {
    isTty: process.stdout.isTTY === true && process.stdin.isTTY === true,
    prompt: async (question: string): Promise<string> => {
      const readline = createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      try {
        return await readline.question(question);
      } finally {
        readline.close();
      }
    },
  };
  const writeOut = (text: string): void => {
    process.stdout.write(text);
  };
  const writeErr = (text: string): void => {
    process.stderr.write(text);
  };
  const fail = (): void => {
    process.exitCode = 1;
  };
  registerCredentialRegister({
    program,
    client,
    env: process.env,
    confirm,
    readFile: (path) => readFileSync(path, "utf8"),
    stdout: writeOut,
    stderr: writeErr,
    fail,
  });
  registerRepositoryRegister({
    program,
    client,
    env: process.env,
    confirm,
    stdout: writeOut,
    stderr: writeErr,
    fail,
  });
  registerRepositoryShow({
    program,
    client,
    env: process.env,
    stdout: writeOut,
    stderr: writeErr,
    fail,
  });
  await program.parseAsync(process.argv);
} catch (error) {
  if (
    error instanceof ConfigError ||
    error instanceof HomeLockError ||
    error instanceof StorageError ||
    error instanceof CliError ||
    error instanceof ToolProbeError
  ) {
    process.stderr.write(`kanthord: ${error.code}: ${error.message}\n`);
    process.exitCode = 1;
  } else {
    throw error;
  }
}
