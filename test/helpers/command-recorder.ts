import type { SecretFileSink } from "../../src/cli/secret-file.ts";
import {
  buildProgram,
  type ProgramDependencies,
} from "../../src/cli/program.ts";
import type { PlanDirectoryDependencies } from "../../src/cli/plan/directory.ts";
import { renderPath } from "../../src/http/contract/path.ts";
import { registry } from "../../src/http/contract/registry.ts";
import type { Operation } from "../../src/http/contract/operation.ts";

export type RecordedRequest = Readonly<{
  method: string;
  path: string;
  operationId: string;
}>;

export type CommandRecorder = Readonly<{
  run(argv: readonly string[]): Promise<void>;
  operationIds(): readonly string[];
  requests(): readonly RecordedRequest[];
  migrateCalls(): number;
  serveCalls(): number;
  writeFileCalls(): readonly Readonly<{ path: string; content: string }>[];
  stdout(): string;
  stderr(): string;
  failures(): number;
}>;

type RecorderOptions = Readonly<{
  respond?: (request: RecordedRequest) => unknown;
  readFile?: (path: string) => string;
  fs?: PlanDirectoryDependencies;
}>;

export function resolveOperationId(
  method: string,
  path: string,
  entries: readonly Operation[] = registry,
): string {
  const pathname = path.split("?", 1)[0] ?? path;
  const candidate = pathname.split("/");
  if (candidate[0] === "") candidate.shift();
  if (candidate[candidate.length - 1] === "") candidate.pop();

  const matches: string[] = [];
  for (const entry of entries) {
    if (entry.method !== method) continue;
    const template = renderPath(entry.path).split("/");
    if (template[0] === "") template.shift();
    if (template.length !== candidate.length) continue;

    let matchesTemplate = true;
    for (let index = 0; index < template.length; index += 1) {
      const templateSegment = template[index];
      const candidateSegment = candidate[index];
      if (templateSegment === undefined || candidateSegment === undefined) {
        matchesTemplate = false;
        break;
      }
      if (templateSegment.startsWith(":") && candidateSegment !== "") {
        continue;
      }
      if (templateSegment !== candidateSegment) {
        matchesTemplate = false;
        break;
      }
    }
    if (matchesTemplate) matches.push(entry.operationId);
  }

  if (matches.length === 0) {
    throw new Error(`no operation matches ${method} ${path}`);
  }
  if (matches.length > 1) {
    throw new Error(
      `more than one operation matches ${method} ${path}: ${matches.join(", ")}`,
    );
  }
  const operationId = matches[0];
  if (operationId === undefined) {
    throw new Error(`no operation matches ${method} ${path}`);
  }
  return operationId;
}

export function createCommandRecorder(
  options: RecorderOptions = {},
): CommandRecorder {
  const requests: RecordedRequest[] = [];
  const writes: Array<Readonly<{ path: string; content: string }>> = [];
  let migrations = 0;
  let serves = 0;
  let output = "";
  let errors = "";
  let failures = 0;

  const respond = options.respond;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url =
      typeof input === "string"
        ? new URL(input)
        : input instanceof URL
          ? input
          : new URL(input.url);
    const method =
      init?.method ??
      (typeof input === "string" || input instanceof URL
        ? "GET"
        : input.method);
    const request: RecordedRequest = {
      method,
      path: `${url.pathname}${url.search}`,
      operationId: resolveOperationId(method, `${url.pathname}${url.search}`),
    };
    requests.push(request);
    const body = respond === undefined ? {} : respond(request);
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const createSecretFile = (_path: string): SecretFileSink => ({
    write: () => undefined,
    discard: () => undefined,
  });

  const dependencies: ProgramDependencies = {
    env: {},
    fetch,
    cwd: "/tmp/kanthord-command-recorder",
    username: "recorder-user",
    randomBytes: (size) => Buffer.alloc(size, 7),
    writeFile: (path, content) => {
      writes.push({ path, content });
    },
    createSecretFile,
    stdout: (text) => {
      output += text;
    },
    stderr: (text) => {
      errors += text;
    },
    fail: () => {
      failures += 1;
    },
    exit: () => undefined,
    confirm: {
      isTty: false,
      prompt: async () => {
        throw new Error("the command recorder confirm must never be called");
      },
    },
    readFile:
      options.readFile ??
      (() => {
        throw new Error("the command recorder readFile must never be called");
      }),
    fs: options.fs ?? {
      readDirectory: () => {
        throw new Error("the command recorder fs must never be called");
      },
      readFile: () => {
        throw new Error("the command recorder fs must never be called");
      },
      writeFile: () => {
        throw new Error("the command recorder fs must never be called");
      },
      makeDirectory: () => {
        throw new Error("the command recorder fs must never be called");
      },
      removeFile: () => {
        throw new Error("the command recorder fs must never be called");
      },
    },
    migrate: () => {
      migrations += 1;
      return [];
    },
    serve: async () => {
      serves += 1;
    },
  };

  return {
    run: async (argv) => {
      const program = buildProgram(dependencies);
      await program.parseAsync(
        [
          "--base-url",
          "http://127.0.0.1:7421",
          "--token",
          "recorder-token",
          ...argv,
        ],
        { from: "user" },
      );
    },
    operationIds: () => requests.map((request) => request.operationId),
    requests: () => [...requests],
    migrateCalls: () => migrations,
    serveCalls: () => serves,
    writeFileCalls: () => [...writes],
    stdout: () => output,
    stderr: () => errors,
    failures: () => failures,
  };
}
