import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { simpleGit } from "simple-git";
import { InstructionFileState } from "../agent/contract.ts";
import {
  InvalidReason,
  PROMPT_SOURCE_MAX_BYTES,
} from "../agent/prompt-source.ts";
import { IdentityKind } from "../kernel/caller.ts";
import {
  CancellationContext,
  cancelled,
  type Context,
} from "../kernel/context.ts";
import { OperationError } from "../kernel/errors.ts";
import { isString } from "../kernel/values.ts";
import { IN_MEMORY_DATABASE, Store } from "../kernel/store.ts";
import { stopAfter, temporary } from "../kernel/test-support.ts";
import {
  readFilesAtCommit,
  resolveBranchCommit,
} from "../repository/connector.ts";
import {
  type RepositoryFile,
  RepositoryFileState,
} from "../repository/contract.ts";
import { LOCAL_GIT_SSH_ACCESS } from "../repository/sshd-test-support.ts";
import {
  BindingKind,
  bindingSetWriteInputSchema,
  INSTRUCTION_FILE_CACHE_ENTRIES,
  type InstructionFile,
  PROJECT_SERVICE_NAME,
  ProjectErrorCode,
  type RepositoryFiles,
} from "./contract.ts";
import { ProjectEnvironments } from "./environment.ts";
import {
  InstructionFileCache,
  instructionFileFrom,
} from "./instruction-file.ts";
import { projectMigrations } from "./migrations.ts";
import {
  insertProject,
  readCurrentBindingSet,
  writeBindingSet,
} from "./store.ts";

const COMMIT = "c".repeat(40);
const OTHER_COMMIT = "d".repeat(40);
const TWO_READS = 2;
const REJECTED = "rejected";
const PATH = "AGENTS.md";
const TEXT = "Write every name in snake_case.\n";
const RESOURCE = "repository:github:acme/api";
const SHORT_DEADLINE_MS = 50;
const SLOW_READ_BOUND_MS = 1000;
const IDENTITY = { kind: IdentityKind.Service, service: PROJECT_SERVICE_NAME };
const GIT_IDENTITY = [
  "-c",
  "user.name=Test",
  "-c",
  "user.email=t@example.invalid",
];

function file(
  state: RepositoryFileState,
  text: string | null = null,
): RepositoryFile {
  return { path: PATH, state, text };
}

test("instructionFileFrom maps each reader state to present, absent or invalid", () => {
  assert.deepEqual(
    instructionFileFrom(file(RepositoryFileState.Present, TEXT), COMMIT),
    {
      path: PATH,
      commit: COMMIT,
      state: InstructionFileState.Present,
      reason: null,
      text: TEXT,
    },
  );
  for (const state of [
    RepositoryFileState.Absent,
    RepositoryFileState.NotRegularFile,
    RepositoryFileState.OutsideRoot,
  ])
    assert.deepEqual(instructionFileFrom(file(state), COMMIT), {
      path: PATH,
      commit: COMMIT,
      state: InstructionFileState.Absent,
      reason: null,
      text: null,
    });
  for (const state of [
    RepositoryFileState.TooLarge,
    RepositoryFileState.NotUtf8,
    RepositoryFileState.Unreadable,
  ])
    assert.deepEqual(instructionFileFrom(file(state), COMMIT), {
      path: PATH,
      commit: COMMIT,
      state: InstructionFileState.Invalid,
      reason: state,
      text: null,
    });
  assert.deepEqual(
    instructionFileFrom(
      file(RepositoryFileState.Present, "line one\r\nline two\n"),
      COMMIT,
    ),
    {
      path: PATH,
      commit: COMMIT,
      state: InstructionFileState.Invalid,
      reason: InvalidReason.ControlCharacter,
      text: null,
    },
  );
});

test("the instruction file cache keeps 256 entries and evicts the least recent one", () => {
  const cache = new InstructionFileCache();
  const entry = (commit: string): InstructionFile => ({
    path: PATH,
    commit,
    state: InstructionFileState.Absent,
    reason: null,
    text: null,
  });
  for (let index = 0; index < INSTRUCTION_FILE_CACHE_ENTRIES; index++)
    cache.set(RESOURCE, entry(String(index)));
  assert.ok(cache.get(RESOURCE, "0", PATH));
  cache.set(RESOURCE, entry("next"));
  assert.ok(cache.get(RESOURCE, "0", PATH));
  assert.equal(cache.get(RESOURCE, "1", PATH), undefined);
  assert.ok(cache.get(RESOURCE, "next", PATH));
  assert.equal(cache.get("repository:github:acme/web", "0", PATH), undefined);
  assert.equal(cache.get(RESOURCE, "0", "CLAUDE.md"), undefined);
});

async function localRepository(
  t: TestContext,
  files: Record<string, string | { link: string }>,
) {
  const root = temporary(t);
  const git = simpleGit(root);
  await git.raw(["init", "-b", "main"]);
  for (const [name, entry] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(dirname(path), { recursive: true });
    if (isString(entry)) writeFileSync(path, entry);
    else symlinkSync(entry.link, path);
  }
  await git.raw(["add", "."]);
  await git.raw([...GIT_IDENTITY, "commit", "-m", "seed"]);
  const commit = (await git.raw(["rev-parse", "HEAD"])).trim();
  return { address: `file://${root}`, commit };
}

const realFiles: RepositoryFiles = {
  resolveBranchCommit,
  readFilesAtCommit: (address, commit, paths, maxBytes, context, ms, ssh) =>
    readFilesAtCommit(address, commit, paths, maxBytes, context, ms, ssh),
  listFilesAtCommit: async () => assert.fail("Unexpected list."),
  readObjectIds: async () => assert.fail("Unexpected object read."),
  cloneSnapshot: async () => assert.fail("Unexpected clone."),
};

function environmentsWith(
  t: TestContext,
  address: string,
  repositoryFiles: RepositoryFiles,
  paths: ReadonlyArray<string | null>,
) {
  const store = new Store(IN_MEMORY_DATABASE);
  stopAfter(t, () => store.close());
  store.migrate([{ service: "project", migrations: projectMigrations }]);
  const bindingIds = store.transaction((tx) => {
    const project = insertProject(tx, "alpha");
    const bindings = Object.fromEntries(
      paths.map((path, index) => [
        `repo-${index}`,
        {
          kind: BindingKind.Repository,
          config: {
            available: true,
            platform: "github",
            address: `git@github.com:acme/api-${index}.git`,
            strategy: { base_branch: "main" },
            ssh_credential: "ssh-github.com",
            ...(path === null ? {} : { prompts: { instruction_file: path } }),
          },
        },
      ]),
    );
    writeBindingSet(
      tx,
      project.id,
      project.binding_set_version,
      new Map(
        Object.entries(
          bindingSetWriteInputSchema.shape.bindings.parse(bindings),
        ),
      ),
    );
    const current = readCurrentBindingSet(tx, project.id);
    return paths.map((_path, index) => {
      const binding = current.get(`repo-${index}`);
      assert.ok(binding);
      return binding.id;
    });
  });
  const environments = new ProjectEnvironments({
    store,
    repositoryFiles,
    identity: IDENTITY,
    targetOf: () => assert.fail("Unexpected target read."),
    sshAccess: () => ({ address, ssh: LOCAL_GIT_SSH_ACCESS }),
    writeBindings: () => assert.fail("Unexpected binding write."),
  });
  return { environments, bindingIds };
}

test("instructionFileOf follows a link inside the tree and reads a link outside the root as absent", async (t) => {
  const { address, commit } = await localRepository(t, {
    "docs/agents.md": TEXT,
    [PATH]: { link: "docs/agents.md" },
    "CLAUDE.md": { link: "../outside.md" },
  });
  const { environments, bindingIds } = environmentsWith(t, address, realFiles, [
    PATH,
    "CLAUDE.md",
  ]);
  const [linked, outside] = bindingIds;
  assert.ok(linked && outside);
  assert.equal(
    await environments.baseCommitOf(linked, new CancellationContext()),
    commit,
  );
  assert.deepEqual(
    await environments.instructionFileOf(
      linked,
      commit,
      new CancellationContext(),
    ),
    {
      path: PATH,
      commit,
      state: InstructionFileState.Present,
      reason: null,
      text: TEXT,
    },
  );
  assert.deepEqual(
    await environments.instructionFileOf(
      outside,
      commit,
      new CancellationContext(),
    ),
    {
      path: "CLAUDE.md",
      commit,
      state: InstructionFileState.Absent,
      reason: null,
      text: null,
    },
  );
});

test("instructionFileOf reads at the prompt bound, answers null for a binding without a file and serves a cache hit with no git call", async (t) => {
  const reads: Array<{ commit: string; paths: string[]; maxBytes: number }> =
    [];
  const counting: RepositoryFiles = {
    ...realFiles,
    resolveBranchCommit: () => assert.fail("The read resolves no head."),
    readFilesAtCommit: async (_address, commit, paths, maxBytes) => {
      reads.push({ commit, paths: [...paths], maxBytes });
      return paths.map((path) => ({
        path,
        state: RepositoryFileState.Present,
        text: TEXT,
      }));
    },
  };
  const { environments, bindingIds } = environmentsWith(
    t,
    "git@github.com:acme/api.git",
    counting,
    [PATH, null],
  );
  const [named, unnamed] = bindingIds;
  assert.ok(named && unnamed);
  assert.equal(
    await environments.instructionFileOf(
      unnamed,
      COMMIT,
      new CancellationContext(),
    ),
    null,
  );
  const first = await environments.instructionFileOf(
    named,
    COMMIT,
    new CancellationContext(),
  );
  const second = await environments.instructionFileOf(
    named,
    COMMIT,
    new CancellationContext(),
  );
  assert.deepEqual(second, first);
  assert.equal(first?.text, TEXT);
  assert.deepEqual(reads, [
    { commit: COMMIT, paths: [PATH], maxBytes: PROMPT_SOURCE_MAX_BYTES },
  ]);
  await environments.instructionFileOf(
    named,
    OTHER_COMMIT,
    new CancellationContext(),
  );
  assert.equal(reads.length, TWO_READS);
});

test("parallel instruction file reads of a slow remote answer ssh_unreachable within one deadline", async (t) => {
  const started: string[] = [];
  const hanging: RepositoryFiles = {
    ...realFiles,
    readFilesAtCommit: async (address, _commit, _paths, _max, context) => {
      started.push(address);
      await cancelled(context.signal);
      throw context.signal.reason;
    },
  };
  const { environments, bindingIds } = environmentsWith(
    t,
    "git@github.com:acme/api.git",
    hanging,
    [PATH, PATH],
  );
  const deadline: Context = new CancellationContext(
    undefined,
    Date.now() + SHORT_DEADLINE_MS,
  );
  const begun = Date.now();
  const results = await Promise.allSettled(
    bindingIds.map((bindingId) =>
      environments.instructionFileOf(bindingId, COMMIT, deadline),
    ),
  );
  assert.ok(Date.now() - begun < SLOW_READ_BOUND_MS);
  assert.equal(started.length, bindingIds.length);
  for (const result of results) {
    assert.equal(result.status, REJECTED);
    assert.ok(result.reason instanceof OperationError);
    assert.equal(result.reason.code, ProjectErrorCode.RepositorySshUnreachable);
  }
});
