import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { toolTimeoutMilliseconds } from "./tools.ts";

type GitTools = Readonly<{
  execPath: string;
  paths: Readonly<{ git: string }>;
}>;

export type SeededRepository = Readonly<{
  name: string;
  path: string;
  head: string;
  refs: Readonly<Record<string, string>>;
}>;

export type SeedRoot = Readonly<{
  path: string;
  repositories: Readonly<Record<string, SeededRepository>>;
  git(repository: string, args: readonly string[]): string;
  dispose(): void;
}>;

export const fixtureObjectIds: Readonly<Record<string, string>> = {
  blob1: "6c2f06c3353a5ee6d33ce8aaf5126add4fbcdb77",
  tree1: "7849fc5f2a2f694310ce3ebfcf77551c8ff814cb",
  commit1: "7d3892b1d8a35ff5ed2c0ead044b4e3c9d8386ca",
  blob2: "b388162b9d33548ecc42b01fcff0c25c74f304b4",
  tree2: "b20c34a30ebfdac99ed382aa5cefdf906bb94aa1",
  commit2: "251c92d5a215053aea80432f179653f99072835d",
  tagV1: "3e5b142033c55afaa59871afbe0a5f1e3947743f",
};

export const pinnedGitEnvironment: Readonly<Record<string, string>> = {
  PATH: "",
  LC_ALL: "C",
  TZ: "UTC",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "Kanthord Fixture",
  GIT_AUTHOR_EMAIL: "fixture@kanthord.invalid",
  GIT_AUTHOR_DATE: "1700000000 +0000",
  GIT_COMMITTER_NAME: "Kanthord Fixture",
  GIT_COMMITTER_EMAIL: "fixture@kanthord.invalid",
  GIT_COMMITTER_DATE: "1700000000 +0000",
};

export const pinnedGitConfigArguments: readonly string[] = [
  "-c",
  "core.autocrlf=false",
  "-c",
  "core.fileMode=true",
  "-c",
  "core.symlinks=false",
  "-c",
  "core.ignoreCase=false",
  "-c",
  "core.precomposeUnicode=false",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "gc.auto=0",
  "-c",
  "maintenance.auto=false",
  "-c",
  "commit.gpgsign=false",
  "-c",
  "tag.gpgSign=false",
];

function invocationEnvironment(
  tools: GitTools,
): Readonly<Record<string, string>> {
  return { ...pinnedGitEnvironment, PATH: tools.execPath };
}

function gitRun(
  tools: GitTools,
  repositoryPath: string,
  args: readonly string[],
  input?: string,
): string {
  return execFileSync(
    tools.paths.git,
    [...pinnedGitConfigArguments, "-C", repositoryPath, ...args],
    {
      env: invocationEnvironment(tools),
      encoding: "utf8",
      input,
      timeout: toolTimeoutMilliseconds,
      killSignal: "SIGKILL",
      maxBuffer: 8 * 1024 * 1024,
    },
  ).trim();
}

function initBareRepository(tools: GitTools, repositoryPath: string): void {
  execFileSync(
    tools.paths.git,
    [
      ...pinnedGitConfigArguments,
      "init",
      "--bare",
      "--quiet",
      "--template=",
      "--initial-branch=main",
      "--object-format=sha1",
      repositoryPath,
    ],
    {
      env: invocationEnvironment(tools),
      encoding: "utf8",
      timeout: toolTimeoutMilliseconds,
      killSignal: "SIGKILL",
      maxBuffer: 8 * 1024 * 1024,
    },
  );
}

export function seedRepositories(tools: GitTools): SeedRoot {
  const root = fs.mkdtempSync(join(tmpdir(), "kanthord-remote-"));
  try {
    return seedInto(tools, root);
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

function seedInto(tools: GitTools, root: string): SeedRoot {
  const repositoryName = "fixture.git";
  const repositoryPath = join(root, repositoryName);
  initBareRepository(tools, repositoryPath);

  const blob1 = gitRun(
    tools,
    repositoryPath,
    ["hash-object", "-w", "--stdin"],
    "kanthord fixture\n",
  );
  const tree1 = gitRun(
    tools,
    repositoryPath,
    ["mktree"],
    `100644 blob ${blob1}\tREADME.md\n`,
  );
  const commit1 = gitRun(tools, repositoryPath, [
    "commit-tree",
    tree1,
    "-m",
    "fixture: initial",
  ]);
  const blob2 = gitRun(
    tools,
    repositoryPath,
    ["hash-object", "-w", "--stdin"],
    "kanthord fixture second\n",
  );
  const tree2 = gitRun(
    tools,
    repositoryPath,
    ["mktree"],
    `100644 blob ${blob2}\tREADME.md\n`,
  );
  const commit2 = gitRun(tools, repositoryPath, [
    "commit-tree",
    tree2,
    "-p",
    commit1,
    "-m",
    "fixture: second",
  ]);
  gitRun(tools, repositoryPath, ["update-ref", "refs/heads/main", commit2]);
  gitRun(tools, repositoryPath, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  const tagV1 = gitRun(
    tools,
    repositoryPath,
    ["mktag"],
    [
      `object ${commit2}`,
      "type commit",
      "tag v1",
      "tagger Kanthord Fixture <fixture@kanthord.invalid> 1700000000 +0000",
      "",
      "fixture tag",
      "",
    ].join("\n"),
  );
  gitRun(tools, repositoryPath, ["update-ref", "refs/tags/v1", tagV1]);
  gitRun(tools, repositoryPath, ["config", "http.receivepack", "true"]);
  gitRun(tools, repositoryPath, ["config", "http.uploadpack", "true"]);

  const head = gitRun(tools, repositoryPath, ["rev-parse", "HEAD"]);
  const refs: Record<string, string> = {};
  const refNames = gitRun(tools, repositoryPath, [
    "for-each-ref",
    "--format=%(refname)",
  ]).split("\n");
  for (const refName of refNames) {
    refs[refName] = gitRun(tools, repositoryPath, ["rev-parse", refName]);
  }

  const repository: SeededRepository = {
    name: repositoryName,
    path: repositoryPath,
    head,
    refs: Object.freeze(refs),
  };

  const repositories: Readonly<Record<string, SeededRepository>> =
    Object.freeze({
      [repositoryName]: repository,
    });

  return Object.freeze({
    path: root,
    repositories,
    git(repository: string, args: readonly string[]): string {
      const target = repositories[repository];
      if (target === undefined) {
        throw new Error(`unknown seeded repository: ${repository}`);
      }
      return gitRun(tools, target.path, args);
    },
    dispose(): void {
      fs.rmSync(root, { recursive: true, force: true });
    },
  });
}
