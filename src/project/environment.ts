import assert from "node:assert/strict";
import { posix } from "node:path";
import type { ServiceIdentity } from "../kernel/caller.ts";
import {
  CancellationContext,
  type Context,
  DeadlineExceeded,
} from "../kernel/context.ts";
import {
  DEVCONTAINER_DIRECTORY,
  DEVCONTAINER_FILE,
  type Environment,
  environmentRefusal,
  environmentSchema,
  parseEnvironmentText,
} from "../kernel/devcontainer.ts";
import { Diagnostic, OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import { isObject } from "../kernel/values.ts";
import type { CallerContext } from "../kernel/operation.ts";
import type { Store } from "../kernel/store.ts";
import { SshIdentitySubjectKind } from "../custody/contract.ts";
import type { SshIdentitySubject } from "../custody/contract.ts";
import type { CallerIdentity } from "../kernel/caller.ts";
import { RepositoryFileState } from "../repository/contract.ts";
import type { RepositoryFile, SshAccess } from "../repository/contract.ts";
import { gitFailureReason } from "../repository/git-failure.ts";
import type { projectOperations } from "./contract.ts";
import {
  bindingSetWriteInputSchema,
  ENVIRONMENT_FILE_MAX_BYTES,
  EnvironmentSource,
  ProjectErrorCode,
  REPOSITORY_FILES_READ_TIMEOUT_MS,
  repositoryConfigSchema,
  type RepositoryFiles,
  type SlotEnvironment,
  SuitePassState,
} from "./contract.ts";
import {
  detectEnvironment,
  DETECTION_PATHS,
  WORKFLOW_DIRECTORY,
  WORKFLOW_FILES_MAX,
  workflowPaths,
} from "./detection.ts";
import { EnvironmentTarget } from "./environment-state.ts";
import {
  kindOf,
  readBindingRevision,
  readCurrentBindingSet,
  requireProject,
  requireRepositoryBinding,
} from "./store.ts";
import { universalEnvironment } from "./universal-environment.ts";

export const ENVIRONMENT_CLONE_TIMEOUT_MS = 300000;
export const EnvironmentErrorCode = {
  Invalid: "project.environment.invalid",
  KeyRefused: "project.environment.key_refused",
} as const;
export const SUITE_PASS_FILE = ".kanthord/suite-pass.json";
const SSH_UNREACHABLE_STATUS = 422;
const ENVIRONMENT_KEY = "environment";

type RepositoryConfig = typeof repositoryConfigSchema._output;
type BindingSetWrite = typeof bindingSetWriteInputSchema._output;
export interface GroupResolution {
  source: EnvironmentSource;
  commit: string;
  document: Environment | null;
  files: RepositoryFile[];
  reason?: string;
}
interface ProbedResolution {
  resolution: GroupResolution;
  probed: RepositoryFile[];
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
  targetOf(projectId: string, bindingId: string): EnvironmentTarget;
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

function inPathOrder(files: RepositoryFile[]): RepositoryFile[] {
  return files.sort((first, second) =>
    first.path < second.path ? -1 : first.path > second.path ? 1 : 0,
  );
}

function refuseUnreadable(context: Context, error: unknown): never {
  if (!(context.signal.reason instanceof DeadlineExceeded))
    context.signal.throwIfAborted();
  throw new OperationError(
    SSH_UNREACHABLE_STATUS,
    ProjectErrorCode.RepositorySshUnreachable,
    "Repository SSH read failed.",
    { failure_reason: gitFailureReason(error) },
  );
}

function suitePassOf(files: RepositoryFile[]): SuitePassState {
  const file = files.find(({ path }) => path === SUITE_PASS_FILE);
  assert.ok(file);
  return file.state === RepositoryFileState.Absent
    ? SuitePassState.Absent
    : SuitePassState.Present;
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

function invalidEnvironment(message: string): OperationError {
  return new OperationError(
    HttpStatus.BadRequest,
    EnvironmentErrorCode.Invalid,
    message,
  );
}

function submittedEnvironment(value: unknown): Environment | null {
  if (value === null) return null;
  if (!isObject(value) || Array.isArray(value))
    throw invalidEnvironment("The environment is not a JSON object.");
  const parsed = environmentSchema.safeParse(value);
  if (!parsed.success)
    throw invalidEnvironment(
      `The environment is invalid: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".")} ${issue.message}`)
        .join("; ")}.`,
    );
  return parsed.data;
}

function withEnvironment(
  config: object,
  environment: Environment | null,
): object {
  const kept = Object.entries(config).filter(
    ([key]) => key !== ENVIRONMENT_KEY,
  );
  return Object.fromEntries(
    environment === null ? kept : [...kept, [ENVIRONMENT_KEY, environment]],
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
    if (stored !== undefined) {
      const suitePass = await this.storedSuitePass(id, config, caller);
      return caller.commit(() => ({
        source: EnvironmentSource.Stored,
        commit: null,
        environment: stored,
        reason: null,
        suite_pass: suitePass,
      }));
    }
    const { resolution, probed } = await this.resolveUnstored(
      id,
      config,
      this.dependencies.targetOf(params.project_id, id),
      caller.context,
      [SUITE_PASS_FILE],
    );
    return caller.commit(() => ({
      source: resolution.source,
      commit: resolution.commit,
      environment: resolution.document,
      reason: resolution.reason ?? null,
      suite_pass: suitePassOf(probed),
    }));
  }

  private async storedSuitePass(
    bindingId: string,
    config: RepositoryConfig,
    caller: Pick<CallerContext, "context">,
  ): Promise<SuitePassState | null> {
    try {
      const read = await this.readBase(
        bindingId,
        config,
        [SUITE_PASS_FILE],
        caller,
      );
      return suitePassOf(read.files);
    } catch (error) {
      if (caller.context.signal.aborted) throw error;
      return null;
    }
  }

  async write(
    params: { project_id: string; binding_id: string },
    submitted: unknown,
    caller: CallerContext,
  ) {
    const environment = submittedEnvironment(submitted);
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
                  ? withEnvironment(binding.config as object, environment)
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
    const { resolution } = await this.resolveUnstored(
      bindingId,
      config,
      target,
      context,
      [],
    );
    return resolution;
  }

  async baseCommitOf(bindingId: string, context: Context): Promise<string> {
    const config = this.dependencies.store.transaction((tx) => {
      const binding = readBindingRevision(tx, bindingId);
      assert.ok(binding);
      return repositoryConfigSchema.parse(binding.config);
    });
    const read = await this.readBase(bindingId, config, [], { context });
    return read.commit;
  }

  private async resolveUnstored(
    bindingId: string,
    config: RepositoryConfig,
    target: EnvironmentTarget,
    context: Context,
    probes: readonly string[],
  ): Promise<ProbedResolution> {
    const deadline = new CancellationContext(
      context,
      Date.now() + REPOSITORY_FILES_READ_TIMEOUT_MS,
    );
    try {
      return await this.resolveWithin(
        bindingId,
        config,
        target,
        deadline,
        probes,
      );
    } finally {
      deadline.cancel();
    }
  }

  private async resolveWithin(
    bindingId: string,
    config: RepositoryConfig,
    target: EnvironmentTarget,
    context: Context,
    probes: readonly string[],
  ): Promise<ProbedResolution> {
    const atImage = target === EnvironmentTarget.Image;
    const read = await this.readBase(
      bindingId,
      config,
      [...(atImage ? [DEVCONTAINER_FILE] : []), ...probes],
      { context },
    );
    const probed = read.files.filter(({ path }) => probes.includes(path));
    const base = {
      commit: read.commit,
      files: read.files.filter(({ path }) => !probes.includes(path)),
    };
    return {
      resolution: await this.resolveFrom(
        bindingId,
        config,
        atImage,
        base,
        context,
      ),
      probed,
    };
  }

  private async resolveFrom(
    bindingId: string,
    config: RepositoryConfig,
    atImage: boolean,
    base: BaseRead,
    context: Context,
  ): Promise<GroupResolution> {
    if (atImage) {
      const file = base.files[0];
      assert.ok(file);
      const repository = await this.repositoryResolution(
        bindingId,
        config,
        base.commit,
        file,
        context,
      );
      if (repository !== null) return repository;
    }
    const detection = await this.readDetection(
      bindingId,
      config,
      base.commit,
      context,
    );
    const files = inPathOrder([...base.files, ...detection]);
    const detected = detectEnvironment(detection);
    if (detected !== null)
      return {
        source: EnvironmentSource.Detected,
        commit: base.commit,
        document: detected.document,
        files,
      };
    return {
      source: atImage ? EnvironmentSource.Universal : EnvironmentSource.None,
      commit: base.commit,
      document: atImage ? universalEnvironment() : null,
      files,
    };
  }

  private async repositoryResolution(
    bindingId: string,
    config: RepositoryConfig,
    commit: string,
    file: RepositoryFile,
    context: Context,
  ): Promise<GroupResolution | null> {
    let document: Environment | null;
    try {
      document = repositoryDocument(file);
    } catch (error) {
      if (!(error instanceof Diagnostic)) throw error;
      return {
        source: EnvironmentSource.Repository,
        commit,
        document: null,
        files: [file],
        reason: error.message,
      };
    }
    if (document === null) return null;
    const dockerfile = dockerfilePath(document);
    const extra =
      dockerfile === null
        ? []
        : await this.readFiles(
            bindingId,
            config,
            commit,
            [dockerfile],
            context,
          );
    return {
      source: EnvironmentSource.Repository,
      commit,
      document,
      files: inPathOrder([file, ...extra]),
    };
  }

  private async readDetection(
    bindingId: string,
    config: RepositoryConfig,
    commit: string,
    context: Context,
  ): Promise<RepositoryFile[]> {
    const listed = await this.listFiles(
      bindingId,
      config,
      commit,
      WORKFLOW_DIRECTORY,
      WORKFLOW_FILES_MAX,
      context,
    );
    return this.readFiles(
      bindingId,
      config,
      commit,
      [...DETECTION_PATHS, ...workflowPaths(listed)],
      context,
    );
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
      Date.now() + REPOSITORY_FILES_READ_TIMEOUT_MS,
    );
    const end = Date.now() + REPOSITORY_FILES_READ_TIMEOUT_MS;
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
        REPOSITORY_FILES_READ_TIMEOUT_MS,
        ssh,
      );
      assert.equal(files.length, paths.length);
      return files;
    } catch (error) {
      return refuseUnreadable(context, error);
    }
  }

  private async listFiles(
    bindingId: string,
    config: RepositoryConfig,
    commit: string,
    directory: string,
    limit: number,
    context: Context,
  ): Promise<string[]> {
    const { address, ssh } = this.access(bindingId, config);
    try {
      return await this.dependencies.repositoryFiles.listFilesAtCommit(
        address,
        commit,
        directory,
        limit,
        context,
        REPOSITORY_FILES_READ_TIMEOUT_MS,
        ssh,
      );
    } catch (error) {
      return refuseUnreadable(context, error);
    }
  }
}
