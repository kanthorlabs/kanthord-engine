import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { simpleGit } from "simple-git";
import { temporary } from "../../kernel/test-support.ts";
import type { RepositoryFiles } from "../../project/contract.ts";
import { RepositoryFileState } from "../../repository/contract.ts";
import { ContainerRuntime } from "../../worker/contract.ts";
import {
  SUCCESS_CODE,
  type RuntimeAnswer,
  type RuntimeHost,
} from "./container-runtime.ts";

const SERVER_UID = 1000;
const ABSENT_CODE = 1;
const Verb = { Info: "info", Image: "image" } as const;
const Subject = { Inspect: "inspect", Exists: "exists" } as const;
const FAKE_COMMIT = "a".repeat(40);
const IMAGE_SETTINGS = JSON.stringify([{ Config: { Env: [], Labels: null } }]);
const INFO_ANSWER: RuntimeAnswer = {
  code: SUCCESS_CODE,
  stdout: JSON.stringify({
    host: {
      os: "linux",
      security: { rootless: true },
      idMappings: {
        uidmap: [
          { container_id: 0, host_id: SERVER_UID, size: 1 },
          { container_id: 1, host_id: 100000, size: 65536 },
        ],
      },
    },
    version: { Version: "5.4.2" },
  }),
  stderr: "",
};

function answerOf(args: readonly string[]): RuntimeAnswer {
  const [verb, subject] = args;
  if (verb === Verb.Info) return INFO_ANSWER;
  if (verb === Verb.Image && subject === Subject.Inspect)
    return {
      code: SUCCESS_CODE,
      stdout: args.includes("--format")
        ? `sha256:${args.at(-1)}\n`
        : IMAGE_SETTINGS,
      stderr: "",
    };
  if (verb === Verb.Image && subject === Subject.Exists)
    return { code: ABSENT_CODE, stdout: "", stderr: "" };
  return { code: SUCCESS_CODE, stdout: "", stderr: "" };
}

export function fakeContainerHost(t: TestContext) {
  const directory = temporary(t);
  const bin = join(directory, "bin");
  const captured = join(directory, "containerfiles");
  const log = join(directory, "podman.log");
  mkdirSync(bin);
  mkdirSync(captured);
  writeFileSync(log, "");
  const recorder = join(directory, "podman.mjs");
  writeFileSync(
    recorder,
    `import { appendFileSync, copyFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
if (args[0] === "build") {
  const file = args[args.indexOf("--file") + 1];
  copyFileSync(file, ${JSON.stringify(captured)} + "/" + args[args.indexOf("--tag") + 1].replaceAll("/", "_"));
}
`,
  );
  writeFileSync(
    join(bin, ContainerRuntime.Podman),
    `#!/bin/sh\nexec "${process.execPath}" "${recorder}" "$@"\n`,
    { mode: 0o755 },
  );
  const cli = join(directory, "devcontainer.mjs");
  writeFileSync(cli, "process.exit(0);\n");
  const calls: string[][] = [];
  const host: RuntimeHost = {
    platform: "linux",
    uid: SERVER_UID,
    user: "kanthord",
    environment: { PATH: `${bin}:${process.env.PATH}`, HOME: process.env.HOME },
    exists: () => false,
    resolves: (runtime) => runtime === ContainerRuntime.Podman,
    run: async (_runtime, args) => {
      calls.push([...args]);
      return answerOf(args);
    },
  };
  const commands = (): string[][] =>
    readFileSync(log, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[]);
  const containerfile = (tag: string): string =>
    readFileSync(join(captured, tag.replaceAll("/", "_")), "utf8");
  return { host, calls, cli, commands, containerfile };
}

export function fakeRepositoryFiles(): RepositoryFiles {
  return {
    resolveBranchCommit: async () => FAKE_COMMIT,
    readFilesAtCommit: async (_address, _commit, paths) =>
      paths.map((path) => ({
        path,
        state: RepositoryFileState.Absent,
        text: null,
      })),
    listFilesAtCommit: async () => [],
    readObjectIds: async (_address, _commit, paths) => paths.map(() => null),
    cloneSnapshot: async (_address, revision, directory) => {
      mkdirSync(directory, { recursive: true });
      const git = simpleGit(directory);
      await git.init(["--initial-branch=main"]);
      await git.addConfig("user.name", "Fake Repository");
      await git.addConfig("user.email", "fake_repository@example.invalid");
      await git.commit("initial", ["--allow-empty"]);
      return revision;
    },
  };
}
