import assert from "node:assert/strict";
import { posix } from "node:path";
import type { ServiceIdentity } from "../kernel/caller.ts";
import { CancellationContext, type Context } from "../kernel/context.ts";
import {
  DEVCONTAINER_DIRECTORY,
  DEVCONTAINER_FILE,
  environmentRefusal,
  parseEnvironmentText,
  type Environment,
} from "../kernel/devcontainer.ts";
import { Diagnostic, OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import type { CallerContext } from "../kernel/operation.ts";
import type { Store } from "../kernel/store.ts";
import { SshIdentitySubjectKind } from "../custody/contract.ts";
import type { SshIdentitySubject } from "../custody/contract.ts";
import type { CallerIdentity } from "../kernel/caller.ts";
import { RepositoryFileState } from "../repository/contract.ts";
import type { SshAccess } from "../repository/contract.ts";
import { gitFailureReason } from "../repository/git-failure.ts";
import {
  BINDING_CHECK_TIMEOUT_MS,
  ENVIRONMENT_FILE_MAX_BYTES,
  EnvironmentSource,
  ProjectErrorCode,
  bindingSetWriteInputSchema,
  projectOperations,
  repositoryConfigSchema,
  type RepositoryFiles,
  type SlotEnvironment,
} from "./contract.ts";
import { EnvironmentTarget } from "./environment-state.ts";
import {
  kindOf,
  readBindingRevision,
  readCurrentBindingSet,
  requireProject,
  requireRepositoryBinding,
} from "./store.ts";

export const ENVIRONMENT_CLONE_TIMEOUT_MS = 300000;
export const EnvironmentErrorCode = {
  Invalid: "project.environment.invalid",
  KeyRefused: "project.environment.key_refused",
} as const;
const SSH_UNREACHABLE_STATUS = 422;

type RepositoryConfig = typeof repositoryConfigSchema._output;
type BindingSetWrite = typeof bindingSetWriteInputSchema._output;
type RepositoryFile = { path: string; state: string; text: string | null };
export interface GroupResolution {
  source: EnvironmentSource;
  commit: string;
  document: Environment | null;
  files: RepositoryFile[];
}
interface ResolvedSlot {
  readonly revisions: string;
  readonly environment: SlotEnvironment | null;
}
type SshRelease = { identity: CallerIdentity; subject: SshIdentitySubject };
type BindingSetAnswer =
  (typeof projectOperations)["binding.environment.set"]["output"]["_output"];

export interface EnvironmentDependencies {
  store: Store;
  repositoryFiles: RepositoryFiles;
  identity: ServiceIdentity;
  sshAccess(
    platform: string,
    release: SshRelease,
  ): { address: string; ssh: SshAccess };
  writeBindings(
    projectId: string,
    body: BindingSetWrite,
    caller: CallerContext,
  ): Promise<BindingSetAnswer>;
}

interface BaseRead {
  commit: string;
  files: RepositoryFile[];
}

function refuseUnreadable(context: Context, error: unknown): never {
  context.signal.throwIfAborted();
  throw new OperationError(
    SSH_UNREACHABLE_STATUS,
    ProjectErrorCode.RepositorySshUnreachable,
    "Repository SSH read failed.",
    { failure_reason: gitFailureReason(error) },
  );
}

function dockerfilePath(document: Environment): string | null {
  const dockerfile = document.build?.dockerfile;
  return dockerfile === undefined
    ? null
    : posix.normalize(posix.join(DEVCONTAINER_DIRECTORY, dockerfile));
}

export function refuseEnvironment(environment: Environment | undefined): void {
  if (environment === undefined) return;
  const refusal = environmentRefusal(environment);
  if (refusal !== null)
    throw new OperationError(
      HttpStatus.BadRequest,
      EnvironmentErrorCode.KeyRefused,
      `The environment key ${refusal.key} is refused: ${refusal.reason}.`,
      { key: refusal.key, reason: refusal.reason },
    );
}

function refusedDocument(document: Environment, origin: string): Environment {
  const refusal = environmentRefusal(document);
  if (refusal === null) return document;
  throw new Diagnostic(
    EnvironmentErrorCode.KeyRefused,
    `${origin}: ${refusal.key}: ${refusal.reason}`,
    {
      fields: [
        ["key", refusal.key],
        ["reason", refusal.reason],
      ],
    },
  );
}

function repositoryDocument(file: RepositoryFile): Environment | null {
  if (file.state === RepositoryFileState.Absent) return null;
  const parsed =
    file.state === RepositoryFileState.Present && file.text !== null
      ? parseEnvironmentText(file.text)
      : { document: null, error: `the file state is ${file.state}` };
  if (parsed.document === null)
    throw new Diagnostic(
      EnvironmentErrorCode.Invalid,
      `${DEVCONTAINER_FILE}: ${parsed.error}`,
    );
  return refusedDocument(parsed.document, DEVCONTAINER_FILE);
}

export class ProjectEnvironments {
  private readonly dependencies: EnvironmentDependencies;
  private readonly resolved = new Map<string, ResolvedSlot>();

  constructor(dependencies: EnvironmentDependencies) {
    this.dependencies = dependencies;
  }

  async read(
    params: { project_id: string; binding_id: string },
    caller: CallerContext,
  ) {
    const { id, config } = this.dependencies.store.transaction((tx) =>
      requireRepositoryBinding(tx, params),
    );
    const stored = config.environment;
    if (stored !== undefined)
      return caller.commit(() => ({
        source: EnvironmentSource.Stored,
        commit: null,
        environment: stored,
        reason: null,
      }));
    const read = await this.readBase(id, config, [DEVCONTAINER_FILE], caller);
    const file = read.files[0];
    assert.ok(file);
    let document: Environment | null;
    try {
      document = repositoryDocument(file);
    } catch (error) {
      if (!(error instanceof Diagnostic)) throw error;
      return caller.commit(() => ({
        source: EnvironmentSource.Repository,
        commit: read.commit,
        environment: null,
        reason: error.message,
      }));
    }
    return caller.commit(() => ({
      source:
        document === null
          ? EnvironmentSource.None
          : EnvironmentSource.Repository,
      commit: read.commit,
      environment: document,
      reason: null,
    }));
  }

  async write(
    params: { project_id: string; binding_id: string },
    environment: Environment,
    caller: CallerContext,
  ) {
    const body = this.dependencies.store.transaction((tx) => {
      const { name } = requireRepositoryBinding(tx, params);
      const version = requireProject(tx, params.project_id).binding_set_version;
      const current = readCurrentBindingSet(tx, params.project_id);
      return bindingSetWriteInputSchema.parse({
        version,
        bindings: Object.fromEntries(
          Array.from(current, ([bindingName, binding]) => [
            bindingName,
            {
              kind: kindOf(binding.resource_identity),
              config:
                bindingName === name
                  ? { ...(binding.config as object), environment }
                  : binding.config,
            },
          ]),
        ),
      });
    });
    return this.dependencies.writeBindings(params.project_id, body, caller);
  }

  async resolveGroup(
    bindingId: string,
    target: EnvironmentTarget,
    context: Context,
  ): Promise<GroupResolution> {
    const config = this.dependencies.store.transaction((tx) => {
      const binding = readBindingRevision(tx, bindingId);
      assert.ok(binding);
      return repositoryConfigSchema.parse(binding.config);
    });
    const caller = { context };
    const stored = config.environment;
    if (stored !== undefined) {
      refusedDocument(stored, EnvironmentSource.Stored);
      const dockerfile = dockerfilePath(stored);
      const read = await this.readBase(
        bindingId,
        config,
        target === EnvironmentTarget.Image && dockerfile !== null
          ? [dockerfile]
          : [],
        caller,
      );
      return {
        source: EnvironmentSource.Stored,
        commit: read.commit,
        document: stored,
        files: read.files,
      };
    }
    if (target !== EnvironmentTarget.Image) {
      const read = await this.readBase(bindingId, config, [], caller);
      return {
        source: EnvironmentSource.None,
        commit: read.commit,
        document: null,
        files: [],
      };
    }
    const read = await this.readBase(
      bindingId,
      config,
      [DEVCONTAINER_FILE],
      caller,
    );
    const file = read.files[0];
    assert.ok(file);
    const document = repositoryDocument(file);
    if (document === null)
      return {
        source: EnvironmentSource.None,
        commit: read.commit,
        document: null,
        files: [],
      };
    const dockerfile = dockerfilePath(document);
    const extra =
      dockerfile === null
        ? []
        : await this.readFiles(
            bindingId,
            config,
            read.commit,
            [dockerfile],
            context,
          );
    return {
      source: EnvironmentSource.Repository,
      commit: read.commit,
      document,
      files: [file, ...extra],
    };
  }

  async exportRepository(
    bindingId: string,
    commit: string,
    directory: string,
    context: Context,
  ): Promise<void> {
    const config = this.dependencies.store.transaction((tx) => {
      const binding = readBindingRevision(tx, bindingId);
      assert.ok(binding);
      return repositoryConfigSchema.parse(binding.config);
    });
    const { address, ssh } = this.access(bindingId, config);
    await this.dependencies.repositoryFiles.cloneSnapshot(
      address,
      commit,
      directory,
      context,
      ENVIRONMENT_CLONE_TIMEOUT_MS,
      ssh,
    );
  }

  private access(bindingId: string, config: RepositoryConfig) {
    return this.dependencies.sshAccess(config.platform, {
      identity: this.dependencies.identity,
      subject: { kind: SshIdentitySubjectKind.Binding, binding_id: bindingId },
    });
  }

  private async readBase(
    bindingId: string,
    config: RepositoryConfig,
    paths: readonly string[],
    caller: Pick<CallerContext, "context">,
  ): Promise<BaseRead> {
    caller.context.signal.throwIfAborted();
    const deadline = new CancellationContext(
      caller.context,
      Date.now() + BINDING_CHECK_TIMEOUT_MS,
    );
    const end = Date.now() + BINDING_CHECK_TIMEOUT_MS;
    try {
      const { address, ssh } = this.access(bindingId, config);
      let commit: string | null;
      try {
        commit = await this.dependencies.repositoryFiles.resolveBranchCommit(
          address,
          config.strategy.base_branch,
          deadline,
          end - Date.now(),
          ssh,
        );
      } catch (error) {
        refuseUnreadable(caller.context, error);
      }
      if (commit === null)
        throw new OperationError(
          SSH_UNREACHABLE_STATUS,
          ProjectErrorCode.RepositoryBaseBranchAbsent,
          "The base branch is absent on the remote.",
        );
      const files = paths.length
        ? await this.readFiles(bindingId, config, commit, paths, deadline)
        : [];
      return { commit, files };
    } finally {
      deadline.cancel();
    }
  }

  private async readFiles(
    bindingId: string,
    config: RepositoryConfig,
    commit: string,
    paths: readonly string[],
    context: Context,
  ): Promise<RepositoryFile[]> {
    const { address, ssh } = this.access(bindingId, config);
    try {
      const files = await this.dependencies.repositoryFiles.readFilesAtCommit(
        address,
        commit,
        paths,
        ENVIRONMENT_FILE_MAX_BYTES,
        context,
        BINDING_CHECK_TIMEOUT_MS,
        ssh,
      );
      assert.equal(files.length, paths.length);
      return files;
    } catch (error) {
      return refuseUnreadable(context, error);
    }
  }
}
