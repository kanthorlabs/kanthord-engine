#!/usr/bin/env node
import { homedir, hostname } from "node:os";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statfsSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { ulid } from "ulid";

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
import { createGitRunner, systemSchedule } from "./services/git/run.ts";
import { createGitJournal } from "./services/git/journal.ts";
import { createBinaryGit } from "./services/git/binary.ts";
import { SystemClock } from "./services/clock/system.ts";
import { SqliteStorage } from "./services/storage/sqlite.ts";
import { StorageError } from "./services/storage/index.ts";
import { migrations } from "./services/storage/migrations.ts";
import { AesGcmCrypto } from "./services/crypto/aes-gcm.ts";
import { SqliteEventLog } from "./services/event/sqlite.ts";
import { SqliteBlobStore } from "./services/blob/sqlite.ts";
import { UlidIdGenerator } from "./services/ids/ulid.ts";
import { GraphologyGraph } from "./services/graph/graphology.ts";
import { SqlitePlanStore } from "./services/plan/sqlite.ts";
import { YamlDocumentReader } from "./services/document/yaml.ts";
import { registerProvider } from "./commands/provider/register-provider.ts";
import { listProviders } from "./queries/provider/list-provider.ts";
import { showProvider } from "./queries/provider/show-provider.ts";
import { createProject } from "./commands/project/create-project.ts";
import { replaceProjectRepositories } from "./commands/project/replace-project-repositories.ts";
import { listProjects } from "./queries/project/list-project.ts";
import { showProject } from "./queries/project/show-project.ts";
import { exportPlan } from "./queries/plan/export-plan.ts";
import { listRevisions } from "./queries/plan/list-revision.ts";
import { validatePlan } from "./queries/plan/validate-plan.ts";
import { importPlan } from "./commands/plan/import-plan.ts";
import { listNodes } from "./queries/node/list-node.ts";
import { showNode } from "./queries/node/show-node.ts";
import { listEdges } from "./queries/edge/list-edge.ts";
import { inspectRepository } from "./queries/repository/inspect-repository.ts";
import { listRepositories } from "./queries/repository/list-repository.ts";
import { showRepository } from "./queries/repository/show-repository.ts";
import { registerRepository } from "./commands/repository/register-repository.ts";
import { recoverHome } from "./commands/startup/recover-home.ts";
import { reapOrphans } from "./commands/startup/reap-orphans.ts";
import { sweepRemnants } from "./commands/startup/sweep-remnants.ts";
import { reconcileJournal } from "./commands/startup/reconcile-journal.ts";
import { recoverExpiredLeases } from "./commands/startup/recover-expired-leases.ts";
import { RecoveryError, renderFinding } from "./domain/recovery.ts";
import { KANTHORD_VERSION } from "./domain/version.ts";
import { registerProviderHandler } from "./http/server/credential/register-provider.ts";
import { listProviderHandler } from "./http/server/credential/list-provider.ts";
import { showProviderHandler } from "./http/server/credential/show-provider.ts";
import { inspectRepositoryHandler } from "./http/server/repository/inspect-repository.ts";
import { listRepositoryHandler } from "./http/server/repository/list-repository.ts";
import { showRepositoryHandler } from "./http/server/repository/show-repository.ts";
import { registerRepositoryHandler } from "./http/server/repository/register-repository.ts";
import { createProjectHandler } from "./http/server/project/create-project.ts";
import { listProjectHandler } from "./http/server/project/list-project.ts";
import { showProjectHandler } from "./http/server/project/show-project.ts";
import { replaceProjectRepositoriesHandler } from "./http/server/project/replace-project-repositories.ts";
import { exportPlanHandler } from "./http/server/plan/export-plan.ts";
import { listRevisionHandler } from "./http/server/plan/list-revision.ts";
import { validatePlanHandler } from "./http/server/plan/validate-plan.ts";
import { importPlanHandler } from "./http/server/plan/import-plan.ts";
import { listNodeHandler } from "./http/server/node/list-node.ts";
import { showNodeHandler } from "./http/server/node/show-node.ts";
import { listEdgeHandler } from "./http/server/edge/list-edge.ts";
import { CliError } from "./cli/options.ts";
import type { MigrateHandler } from "./cli/db/migrate.ts";
import type { PlanDirectoryDependencies } from "./cli/plan/directory.ts";
import { buildProgram, type ServeOptions } from "./cli/program.ts";
import { createApp, unimplementedFor } from "./http/server/app.ts";
import { listen } from "./http/server/start.ts";
import { createShutdown } from "./http/server/shutdown.ts";
import { assertMigrated, StartupError } from "./http/server/migration-gate.ts";
import { healthHandler } from "./http/server/system/health.ts";
import { dbHandler } from "./http/server/system/db.ts";
import { statusHandler } from "./http/server/system/status.ts";
import { readHealth } from "./queries/system/read-health.ts";
import type { DependencyStatus } from "./queries/system/read-health.ts";
import { readMigrationStatus } from "./queries/system/read-migration-status.ts";
import { readStatus } from "./queries/system/read-status.ts";

const startedAt = new Date().toISOString();

async function serve(options: ServeOptions): Promise<void> {
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
    const gitRunner = createGitRunner(gitPaths, systemSchedule);
    const gitJournal = createGitJournal();
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
      const ids = new UlidIdGenerator();
      const graph = new GraphologyGraph();
      const plan = new SqlitePlanStore();
      const reader = new YamlDocumentReader();
      const events = new SqliteEventLog({ storage, ids });
      const blobs = new SqliteBlobStore({ storage, clock });
      const recovery = await recoverHome({
        reap: () =>
          reapOrphans(
            {
              storage,
              journal: gitJournal,
              git,
              events,
              clock,
              runDirectory: gitPaths.runDirectory,
              graceMs: 5000,
            },
            { actor: "daemon" },
          ),
        sweep: (reap) =>
          sweepRemnants(
            { storage, git, events, keyDirectory: gitPaths.keyDirectory },
            { actor: "daemon", reap },
          ),
        reconcile: () =>
          reconcileJournal(
            { storage, journal: gitJournal, git, events, clock },
            { actor: "daemon" },
          ),
        leases: () =>
          recoverExpiredLeases(
            { storage, git, events, clock },
            { actor: "daemon" },
          ),
      });
      for (const finding of recovery.findings) {
        process.stderr.write(`kanthord: recovery: ${renderFinding(finding)}\n`);
      }
      const reporters = [
        {
          name: "storage",
          probe: (): DependencyStatus => {
            storage.ping();
            return "ok";
          },
        },
      ];
      const crypto = new AesGcmCrypto({
        key: settings.masterKey,
        keyVersion: 1,
      });
      const handlers = {
        "system.health": healthHandler({
          readHealth: () => readHealth({ reporters }),
        }),
        "system.db": dbHandler({
          readMigrationStatus: () => readMigrationStatus({ storage }),
        }),
        "system.status": statusHandler({
          readStatus: () =>
            readStatus({
              storage,
              clock,
              health: () => readHealth({ reporters }),
              version: KANTHORD_VERSION,
              bind: settings.http.bind,
              startedAt,
            }),
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
        "project.create": createProjectHandler({
          createProject: (input) =>
            createProject({ storage, ids, clock, events }, input),
          actor: settings.actor,
        }),
        "project.list": listProjectHandler({
          listProjects: (input) => listProjects({ storage }, input),
        }),
        "project.show": showProjectHandler({
          showProject: (input) => showProject({ storage }, input),
        }),
        "project.repositories": replaceProjectRepositoriesHandler({
          replaceProjectRepositories: (input) =>
            replaceProjectRepositories({ storage, clock, events }, input),
          actor: settings.actor,
        }),
        "node.list": listNodeHandler({
          listNodes: (input) => listNodes({ storage, plan }, input),
        }),
        "node.show": showNodeHandler({
          showNode: (input) => showNode({ storage, plan }, input),
        }),
        "edge.list": listEdgeHandler({
          listEdges: (input) => listEdges({ storage, plan }, input),
        }),
        "plan.export": exportPlanHandler({
          exportPlan: (input) => exportPlan({ storage, plan, blobs }, input),
        }),
        "plan.revisions": listRevisionHandler({
          listRevisions: (input) => listRevisions({ storage, plan }, input),
        }),
        "plan.validate": validatePlanHandler({
          validatePlan: (input) =>
            validatePlan({ storage, plan, blobs, reader, graph, ids }, input),
        }),
        "plan.import": importPlanHandler({
          importPlan: (input) =>
            importPlan(
              { storage, plan, blobs, reader, graph, ids, clock, events },
              input,
            ),
          actor: settings.actor,
        }),
      };
      const unimplemented = unimplementedFor(handlers);
      const app = createApp({
        settings: {
          token: settings.http.token,
          allowedHosts: settings.http.allowedHosts,
        },
        handlers,
        unimplemented,
        onInternalError: (error) =>
          process.stderr.write(`kanthord: internal-error: ${String(error)}\n`),
      });
      const listening = await listen(app, {
        bind: settings.http.bind,
        port: settings.http.port,
      });
      reachedListen = true;
      const shutdown = createShutdown({
        steps: [
          { name: "listener", run: () => listening.close() },
          {
            name: "storage",
            run: () => {
              storage.close();
            },
          },
          {
            name: "home-lock",
            run: () => {
              held.release();
            },
          },
        ],
        write: (text) => process.stderr.write(text),
        onSettled: (code) => {
          process.exitCode = code;
        },
      });
      for (const signal of ["SIGTERM", "SIGINT"] as const) {
        process.once(signal, () => {
          void shutdown();
        });
      }
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
      error instanceof RecoveryError ||
      error instanceof CliError ||
      error instanceof ToolProbeError
    ) {
      process.stderr.write(`kanthord: ${error.code}: ${error.message}\n`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }
}

const migrate: MigrateHandler = (input) => {
  const home =
    input.home ??
    new ConvictConfig().load({
      explicitConfigPath: input.config,
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

const planFs: PlanDirectoryDependencies = {
  readDirectory: (path) =>
    readdirSync(path, { withFileTypes: true }).map((entry) =>
      entry.isDirectory() ? `${entry.name}/` : entry.name,
    ),
  readFile: (path) => readFileSync(path, "utf8"),
  writeFile: (path, content) => writeFileSync(path, content, "utf8"),
  makeDirectory: (path) => mkdirSync(path, { recursive: true }),
  removeFile: (path) => rmSync(path, { force: true }),
};

try {
  const program = buildProgram({
    env: process.env,
    fetch: globalThis.fetch,
    cwd: process.cwd(),
    fs: planFs,
    stdout: writeOut,
    stderr: writeErr,
    fail,
    exit: (code) => {
      process.exitCode = code;
    },
    confirm,
    readFile: (path) => readFileSync(path, "utf8"),
    migrate,
    serve,
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
