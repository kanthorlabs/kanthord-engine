#!/usr/bin/env node
import { homedir, hostname, userInfo } from "node:os";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
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
import type { Transaction } from "./services/storage/index.ts";
import { migrations } from "./services/storage/migrations.ts";
import { AesGcmCrypto } from "./services/crypto/aes-gcm.ts";
import { NodeCryptoSecret } from "./services/secret/node-crypto.ts";
import { PiAiModelCatalog } from "./services/model-catalog/pi-ai.ts";
import { readCatalog } from "./queries/provider/read-catalog.ts";
import { inspectProvider } from "./queries/provider/inspect-provider.ts";
import { readCatalogHandler } from "./http/server/credential/read-catalog.ts";
import { inspectProviderHandler } from "./http/server/credential/inspect-provider.ts";
import { SqliteEventLog } from "./services/event/sqlite.ts";
import { SqliteExecution } from "./services/execution/sqlite.ts";
import { SqliteLease } from "./services/lease/sqlite.ts";
import { SqliteBlobStore } from "./services/blob/sqlite.ts";
import { UlidIdGenerator } from "./services/ids/ulid.ts";
import { GraphologyGraph } from "./services/graph/graphology.ts";
import { SqlitePlanStore } from "./services/plan/sqlite.ts";
import { NodeWriteRevision } from "./services/revision/node-write.ts";
import { DependencyReadiness } from "./services/readiness/dependency.ts";
import { YamlDocumentReader } from "./services/document/yaml.ts";
import { registerProvider } from "./commands/provider/register-provider.ts";
import { renameProvider } from "./commands/provider/rename-provider.ts";
import { setDefaultProvider } from "./commands/provider/set-default-provider.ts";
import { removeProvider } from "./commands/provider/remove-provider.ts";
import { listProviders } from "./queries/provider/list-provider.ts";
import { showProvider } from "./queries/provider/show-provider.ts";
import { resolveActor } from "./queries/actor/resolve-actor.ts";
import { createProject } from "./commands/project/create-project.ts";
import { replaceProjectRepositories } from "./commands/project/replace-project-repositories.ts";
import { listProjects } from "./queries/project/list-project.ts";
import { showProject } from "./queries/project/show-project.ts";
import { readProjectStatus } from "./queries/project/read-project-status.ts";
import { exportPlan } from "./queries/plan/export-plan.ts";
import { listRevisions } from "./queries/plan/list-revision.ts";
import { validatePlan } from "./queries/plan/validate-plan.ts";
import { importPlan } from "./commands/plan/import-plan.ts";
import { listNodes } from "./queries/node/list-node.ts";
import { showNode } from "./queries/node/show-node.ts";
import { createNode } from "./commands/node/create-node.ts";
import { updateNode } from "./commands/node/update-node.ts";
import { deleteNode } from "./commands/node/delete-node.ts";
import { claimNode } from "./commands/node/claim-node.ts";
import { heartbeatNode } from "./commands/node/heartbeat-node.ts";
import { releaseNode } from "./commands/node/release-node.ts";
import { unblockNode } from "./commands/node/unblock-node.ts";
import {
  aggregateInitiative,
  type AggregateInitiativeInput,
} from "./commands/outcome/aggregate-initiative.ts";
import {
  closeObjective,
  type CloseObjectiveInput,
  type CloseObjectiveResult,
} from "./commands/outcome/close-objective.ts";
import {
  reportObjective,
  type ReportObjectiveInput,
  type ReportObjectiveResult,
} from "./commands/outcome/report-objective.ts";
import {
  reportOutcome,
  type ReportOutcomeInput,
  type ReportOutcomeResult,
} from "./commands/outcome/report-outcome.ts";
import { listEdges } from "./queries/edge/list-edge.ts";
import { inspectRepository } from "./queries/repository/inspect-repository.ts";
import { listRepositories } from "./queries/repository/list-repository.ts";
import { showRepository } from "./queries/repository/show-repository.ts";
import { registerRepository } from "./commands/repository/register-repository.ts";
import { recoverHome } from "./commands/startup/recover-home.ts";
import {
  ensureBootstrapActor,
  EnsureBootstrapActorError,
} from "./commands/startup/ensure-bootstrap-actor.ts";
import { reapOrphans } from "./commands/startup/reap-orphans.ts";
import { sweepRemnants } from "./commands/startup/sweep-remnants.ts";
import { reconcileJournal } from "./commands/startup/reconcile-journal.ts";
import {
  recoverExpiredLeases,
  sweepExpiredExternalLeases,
} from "./commands/startup/recover-expired-leases.ts";
import { RecoveryError, renderFinding } from "./domain/recovery.ts";
import { KANTHORD_VERSION } from "./domain/version.ts";
import { registerProviderHandler } from "./http/server/credential/register-provider.ts";
import { renameProviderHandler } from "./http/server/credential/rename-provider.ts";
import { setDefaultProviderHandler } from "./http/server/credential/set-default-provider.ts";
import { removeProviderHandler } from "./http/server/credential/remove-provider.ts";
import { listProviderHandler } from "./http/server/credential/list-provider.ts";
import { showProviderHandler } from "./http/server/credential/show-provider.ts";
import { inspectRepositoryHandler } from "./http/server/repository/inspect-repository.ts";
import { listRepositoryHandler } from "./http/server/repository/list-repository.ts";
import { showRepositoryHandler } from "./http/server/repository/show-repository.ts";
import { registerRepositoryHandler } from "./http/server/repository/register-repository.ts";
import { createProjectHandler } from "./http/server/project/create-project.ts";
import { listProjectHandler } from "./http/server/project/list-project.ts";
import { showProjectHandler } from "./http/server/project/show-project.ts";
import { readProjectStatusHandler } from "./http/server/project/read-project-status.ts";
import { replaceProjectRepositoriesHandler } from "./http/server/project/replace-project-repositories.ts";
import { exportPlanHandler } from "./http/server/plan/export-plan.ts";
import { listRevisionHandler } from "./http/server/plan/list-revision.ts";
import { validatePlanHandler } from "./http/server/plan/validate-plan.ts";
import { importPlanHandler } from "./http/server/plan/import-plan.ts";
import { listNodeHandler } from "./http/server/node/list-node.ts";
import { showNodeHandler } from "./http/server/node/show-node.ts";
import { createNodeHandler } from "./http/server/node/create-node.ts";
import { updateNodeHandler } from "./http/server/node/update-node.ts";
import { deleteNodeHandler } from "./http/server/node/delete-node.ts";
import { claimNodeHandler } from "./http/server/node/claim-node.ts";
import { heartbeatNodeHandler } from "./http/server/node/heartbeat-node.ts";
import { releaseNodeHandler } from "./http/server/node/release-node.ts";
import { reportNodeHandler } from "./http/server/node/report-node.ts";
import { unblockNodeHandler } from "./http/server/node/unblock-node.ts";
import { listEdgeHandler } from "./http/server/edge/list-edge.ts";
import { listEventHandler } from "./http/server/event/list-event.ts";
import { listEvents } from "./queries/event/list-event.ts";
import { showBlobHandler } from "./http/server/blob/show-blob.ts";
import { showBlob } from "./queries/blob/show-blob.ts";
import { registerActor } from "./commands/actor/register-actor.ts";
import { revokeActor } from "./commands/actor/revoke-actor.ts";
import { rotateActorToken } from "./commands/actor/rotate-actor-token.ts";
import { listActors } from "./queries/actor/list-actor.ts";
import { showActor } from "./queries/actor/show-actor.ts";
import { registerActorHandler } from "./http/server/actor/register-actor.ts";
import { listActorHandler } from "./http/server/actor/list-actor.ts";
import { showActorHandler } from "./http/server/actor/show-actor.ts";
import { revokeActorHandler } from "./http/server/actor/revoke-actor.ts";
import { rotateActorTokenHandler } from "./http/server/actor/rotate-actor-token.ts";
import { CliError } from "./cli/options.ts";
import type { MigrateHandler } from "./cli/db/migrate.ts";
import type { PlanDirectoryDependencies } from "./cli/plan/directory.ts";
import { buildProgram, type ServeOptions } from "./cli/program.ts";
import { createSecretFile } from "./cli/secret-file.ts";
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
    const instanceId = ulid();
    held.publishIdentity({
      version: 1,
      pid: process.pid,
      host: hostname(),
      startedAt: new Date().toISOString(),
      instanceId,
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
      ensureBootstrapActor({ storage }, { actor: settings.actor });
      const ids = new UlidIdGenerator();
      const graph = new GraphologyGraph();
      const reader = new YamlDocumentReader();
      const events = new SqliteEventLog({ storage, ids });
      const lease = new SqliteLease();
      const execution = new SqliteExecution({ ids });
      const readiness = new DependencyReadiness({ events, instanceId });
      const plan = new SqlitePlanStore({ readiness });
      const blobs = new SqliteBlobStore({ storage, clock });
      const revision = new NodeWriteRevision({ blobs, plan });
      const boundAggregateInitiative = (
        transaction: Transaction,
        input: AggregateInitiativeInput,
      ): void =>
        aggregateInitiative({ plan, events, instanceId }, transaction, input);
      const boundCloseObjective = (
        transaction: Transaction,
        input: CloseObjectiveInput,
      ): CloseObjectiveResult =>
        closeObjective(
          {
            plan,
            execution,
            events,
            clock,
            aggregateInitiative: boundAggregateInitiative,
            instanceId,
          },
          transaction,
          input,
        );
      const boundReportObjective = (
        transaction: Transaction,
        input: ReportObjectiveInput,
      ): ReportObjectiveResult =>
        reportObjective(
          { plan, lease, execution, events, clock, instanceId },
          transaction,
          input,
        );
      const boundReportOutcome = (
        input: ReportOutcomeInput,
      ): ReportOutcomeResult =>
        reportOutcome(
          {
            storage,
            plan,
            lease,
            execution,
            events,
            clock,
            reportObjective: boundReportObjective,
            closeObjective: boundCloseObjective,
            instanceId,
          },
          input,
        );
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
            { storage, plan, git, events, clock, lease, execution },
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
      const secret = new NodeCryptoSecret();
      const catalog = new PiAiModelCatalog();
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
        "provider.catalog": readCatalogHandler({
          readCatalog: (input) => readCatalog({ catalog }, input),
        }),
        "provider.inspect": inspectProviderHandler({
          inspectProvider: (input) => inspectProvider({ catalog }, input),
        }),
        "provider.register": registerProviderHandler({
          registerProvider: (input) =>
            registerProvider(
              { storage, crypto, ids, clock, events, catalog },
              input,
            ),
        }),
        "provider.rename": renameProviderHandler({
          renameProvider: (input) =>
            renameProvider({ storage, crypto, clock, events }, input),
        }),
        "provider.setDefault": setDefaultProviderHandler({
          setDefaultProvider: (input) =>
            setDefaultProvider({ storage, crypto, clock, events }, input),
        }),
        "provider.remove": removeProviderHandler({
          removeProvider: (input) => removeProvider({ storage, events }, input),
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
        }),
        "project.list": listProjectHandler({
          listProjects: (input) => listProjects({ storage }, input),
        }),
        "project.show": showProjectHandler({
          showProject: (input) => showProject({ storage }, input),
        }),
        "project.status": readProjectStatusHandler({
          readProjectStatus: (input) => readProjectStatus({ storage }, input),
        }),
        "project.repositories": replaceProjectRepositoriesHandler({
          replaceProjectRepositories: (input) =>
            replaceProjectRepositories({ storage, plan, clock, events }, input),
        }),
        "node.list": listNodeHandler({
          listNodes: (input) => listNodes({ storage, plan }, input),
        }),
        "node.show": showNodeHandler({
          showNode: (input) =>
            showNode({ storage, plan, blobs, execution }, input),
        }),
        "node.report": reportNodeHandler({
          reportOutcome: (input) => boundReportOutcome(input),
        }),
        "node.unblock": unblockNodeHandler({
          unblockNode: (input) => {
            const result = unblockNode({ storage, plan, events, clock }, input);
            const view = showNode(
              { storage, plan, blobs, execution },
              { id: result.node.id },
            );
            if (view === null) {
              throw new Error(
                `the unblocked node ${result.node.id} has no view`,
              );
            }
            return { ...result, node: view };
          },
        }),
        "node.claim": claimNodeHandler({
          claimNode: (input) => {
            const result = claimNode(
              {
                storage,
                plan,
                lease,
                execution,
                events,
                clock,
                ids,
                sweepExpiredExternalLeases: (transaction, sweepInput) =>
                  sweepExpiredExternalLeases(
                    { plan, lease, execution, events },
                    transaction,
                    sweepInput,
                  ),
                attemptLimit: settings.attemptLimit,
                leaseTtlMs: settings.leaseTtlMs,
                instanceId,
              },
              input,
            );
            const view = showNode(
              { storage, plan, blobs, execution },
              { id: result.node.id },
            );
            if (view === null) {
              throw new Error(`the claimed node ${result.node.id} has no view`);
            }
            return { ...result, node: view };
          },
        }),
        "node.heartbeat": heartbeatNodeHandler({
          heartbeatNode: (input) =>
            heartbeatNode(
              {
                storage,
                plan,
                lease,
                events,
                clock,
                leaseTtlMs: settings.leaseTtlMs,
              },
              input,
            ),
        }),
        "node.release": releaseNodeHandler({
          releaseNode: (input) => {
            const result = releaseNode(
              { storage, plan, lease, execution, events, clock },
              input,
            );
            const view = showNode(
              { storage, plan, blobs, execution },
              { id: result.node.id },
            );
            if (view === null) {
              throw new Error(
                `the released node ${result.node.id} has no view`,
              );
            }
            return { ...result, node: view };
          },
        }),
        "node.create": createNodeHandler({
          createNode: (input) =>
            createNode(
              { storage, plan, blobs, graph, ids, clock, events, revision },
              input,
            ),
        }),
        "node.update": updateNodeHandler({
          updateNode: (input) =>
            updateNode(
              { storage, plan, blobs, graph, ids, clock, events, revision },
              input,
            ),
        }),
        "node.delete": deleteNodeHandler({
          deleteNode: (input) =>
            deleteNode(
              { storage, plan, blobs, graph, ids, clock, events, revision },
              input,
            ),
        }),
        "edge.list": listEdgeHandler({
          listEdges: (input) => listEdges({ storage, plan }, input),
        }),
        "event.list": listEventHandler({
          listEvents: (input) => listEvents({ events }, input),
        }),
        "blob.show": showBlobHandler({
          showBlob: (input) => showBlob({ blobs }, input),
        }),
        "plan.export": exportPlanHandler({
          exportPlan: (input) => exportPlan({ storage, plan, revision }, input),
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
        }),
        "actor.register": registerActorHandler({
          registerActor: (input) =>
            registerActor({ storage, secret, ids, events, clock }, input),
          configuredToken: settings.http.token,
        }),
        "actor.list": listActorHandler({
          listActors: (input) => listActors({ storage }, input),
        }),
        "actor.show": showActorHandler({
          showActor: (input) => showActor({ storage }, input),
        }),
        "actor.revoke": revokeActorHandler({
          revokeActor: (input) =>
            revokeActor({ storage, events, clock, lease }, input),
        }),
        "actor.rotate": rotateActorTokenHandler({
          rotateActorToken: (input) =>
            rotateActorToken({ storage, secret, events, clock }, input),
        }),
      };
      const unimplemented = unimplementedFor(handlers);
      const resolveActorFor = (presented: string) =>
        resolveActor(
          { storage, secret, configuredToken: settings.http.token },
          { presented },
        );
      const app = createApp({
        settings: {
          token: settings.http.token,
          allowedHosts: settings.http.allowedHosts,
          allowedOrigins: settings.http.allowedOrigins,
        },
        handlers,
        unimplemented,
        resolveActor: resolveActorFor,
        idempotency: {
          ttlSeconds: settings.http.idempotency.ttl,
          joinTimeoutSeconds: settings.http.idempotency.joinTimeout,
          maxEntries: settings.http.idempotency.maxEntries,
          maxBytes: settings.http.idempotency.maxBytes,
        },
        now: () => clock.now(),
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
    if (error instanceof EnsureBootstrapActorError) {
      process.stderr.write(`kanthord: ${error.refusal}: ${error.message}\n`);
      process.exitCode = 1;
      return;
    }
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
    username: userInfo().username,
    randomBytes,
    writeFile: (path, content) => {
      writeFileSync(path, content, { encoding: "utf8", mode: 0o600 });
      chmodSync(path, 0o600);
    },
    createSecretFile,
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
