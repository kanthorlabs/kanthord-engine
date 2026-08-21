import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { connect, createServer } from "node:net";
import { request } from "node:http";
import { arch, hostname, platform, tmpdir } from "node:os";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";

import { runCommand } from "../command.ts";
import type { CommandRecord, CommandSink } from "../command.ts";
import { RunnerError } from "../errors.ts";
import { secrets } from "../redact.ts";
import {
  readinessDeadlineMilliseconds,
  withDeadline,
} from "../podman/readiness.ts";
import type { BundleIdentity } from "../bundle.ts";
import type { ScenarioContext } from "../scenario/context.ts";
import { runOriginProbe } from "./origin-probe.ts";
import type { OriginProbeInput, ProbeRow } from "./origin-probe.ts";
import type {
  DaemonConfig,
  DaemonHandle,
  ExecutionDriver,
  HostRole,
  HttpIssuer,
} from "./index.ts";

let memoizedBinary: Promise<string> | undefined;

async function packAndInstall(context: ScenarioContext): Promise<string> {
  const prebuilt = process.env.KANTHORD_E2E_BINARY;
  if (prebuilt !== undefined && prebuilt !== "" && existsSync(prebuilt)) {
    return prebuilt;
  }

  const repositoryRoot = process.cwd();
  const tmp = await mkdtemp(join(tmpdir(), "kanthord-e2e-pack-"));
  context.take({
    kind: "directory",
    id: tmp,
    async release(): Promise<void> {
      await rm(tmp, { recursive: true, force: true });
    },
  });

  await runCommand(context.sink, {
    argv: ["npm", "pack", "--pack-destination", tmp],
    cwd: repositoryRoot,
    env: { PATH: process.env.PATH ?? "" },
  });

  const packageJson = JSON.parse(
    await readFile(join(repositoryRoot, "package.json"), "utf8"),
  ) as Readonly<{ version: string }>;
  const tarball = join(tmp, `kanthord-${packageJson.version}.tgz`);
  const prefix = join(tmp, "prefix");
  await mkdir(prefix, { recursive: true });

  await runCommand(context.sink, {
    argv: ["npm", "install", "--global", "--prefix", prefix, tarball],
    cwd: repositoryRoot,
    env: { PATH: process.env.PATH ?? "" },
  });

  return join(prefix, "bin", "kanthord");
}

function ensureBinary(context: ScenarioContext): Promise<string> {
  if (memoizedBinary === undefined) {
    memoizedBinary = packAndInstall(context);
  }
  return memoizedBinary;
}

export async function allocateLocalPort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port =
        typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function issueWithNoHostHeader(
  hostname: string,
  port: number,
  method: string,
  path: string,
  headers: Readonly<Record<string, string>>,
  body?: string,
): Promise<Readonly<{ status: number; body: string }>> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, hostname, () => {
      const headerLines = Object.entries(headers)
        .map(([key, value]) => `${key}: ${value}\r\n`)
        .join("");
      socket.write(`${method} ${path} HTTP/1.0\r\n${headerLines}\r\n`);
      if (body !== undefined) {
        socket.write(body);
      }
    });
    let raw = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      raw = Buffer.concat([raw, chunk]);
    });
    socket.on("error", reject);
    socket.on("close", () => {
      const text = raw.toString("utf8");
      const separator = text.indexOf("\r\n\r\n");
      const head = separator === -1 ? text : text.slice(0, separator);
      const bodyText = separator === -1 ? "" : text.slice(separator + 4);
      const statusLine = head.split("\r\n")[0] ?? "";
      const status = Number(statusLine.split(" ")[1] ?? "0");
      resolve({ status, body: bodyText });
    });
  });
}

export function createLocalIssuer(getBaseUrl: () => string): HttpIssuer {
  return async (input) => {
    const url = new URL(input.path, getBaseUrl());
    const path = `${url.pathname}${url.search}`;

    if (input.omitHost) {
      return issueWithNoHostHeader(
        url.hostname,
        Number(url.port),
        input.method,
        path,
        input.headers,
        input.body,
      );
    }

    return new Promise((resolve, reject) => {
      const outgoing = request(
        {
          method: input.method,
          hostname: url.hostname,
          port: url.port,
          path,
          headers: input.headers,
          setHost: true,
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () => {
            resolve({
              status: response.statusCode ?? 0,
              body: Buffer.concat(chunks).toString("utf8"),
            });
          });
        },
      );
      outgoing.on("error", reject);
      if (input.body !== undefined) {
        outgoing.write(input.body);
      }
      outgoing.end();
    });
  };
}

function parseChildResponse(
  record: CommandRecord,
): Readonly<{ status: number; body: string }> {
  if (record.exitCode !== 0) {
    throw new RunnerError(
      "unavailable",
      `the local request helper exited with code ${String(record.exitCode)}`,
    );
  }

  const separatorIndex = record.stdout.indexOf("\n");
  const statusText =
    separatorIndex === -1
      ? record.stdout
      : record.stdout.slice(0, separatorIndex);
  const body =
    separatorIndex === -1 ? "" : record.stdout.slice(separatorIndex + 1);

  return { status: Number.parseInt(statusText, 10), body };
}

function createLocalChildIssuer(
  getBaseUrl: () => string,
  sink: CommandSink,
): HttpIssuer {
  const helper = join(import.meta.dirname, "../../podman/bin/e2e-request.mjs");

  return async (input) => {
    const record = await runCommand(sink, {
      argv: [process.execPath, helper],
      stdin: JSON.stringify({ ...input, baseUrl: getBaseUrl() }),
      env: { PATH: process.env.PATH ?? "" },
    });
    return parseChildResponse(record);
  };
}

function parseActorId(record: CommandRecord): string {
  if (record.exitCode !== 0) {
    throw new RunnerError(
      "unavailable",
      `actor registration exited with code ${String(record.exitCode)}`,
    );
  }

  const actorId = record.stdout.split(/\r?\n/u)[0]?.trim() ?? "";
  if (actorId.length === 0) {
    throw new RunnerError(
      "assertion-failed",
      "actor registration returned no actor id",
    );
  }
  return actorId;
}

export async function createLocalDriver(
  context: ScenarioContext,
): Promise<ExecutionDriver> {
  const base = await realpath(
    await mkdtemp(join(tmpdir(), "kanthord-e2e-local-")),
  );
  context.take({
    kind: "directory",
    id: base,
    async release(): Promise<void> {
      await rm(base, { recursive: true, force: true });
    },
  });
  const home = join(base, "home");
  await mkdir(home, { recursive: true });
  const tokenDirectory = join(base, "tokens");
  await mkdir(tokenDirectory, { recursive: true });

  let token = "";
  let baseUrl = "";
  const tokenCounters: Record<HostRole, number> = {
    daemon: 0,
    client: 0,
    client2: 0,
  };
  let daemonLogs: Readonly<{ stdout: string; stderr: string }> = {
    stdout: "",
    stderr: "",
  };

  async function deliverConfig(config: DaemonConfig): Promise<string> {
    const path = join(home, "kanthord.config.json");
    await writeFile(path, JSON.stringify(config, null, 2), "utf8");
    return path;
  }

  async function spawnServe(
    binary: string,
  ): Promise<{ child: ReturnType<typeof spawn> }> {
    context.sink.print(`e2e: $ ${binary} serve`);
    const child = spawn(binary, ["serve"], {
      shell: false,
      cwd: home,
      env: {
        PATH: `${dirname(binary)}:${dirname(process.execPath)}`,
        HOME: home,
      },
    });
    return { child };
  }

  function nextTokenFile(role: HostRole): string {
    tokenCounters[role] += 1;
    return join(tokenDirectory, `${role}-${String(tokenCounters[role])}`);
  }

  const issue = createLocalChildIssuer(() => baseUrl, context.sink);

  async function cliAs(
    _role: HostRole,
    argv: readonly string[],
    options?: Readonly<{ tokenFile?: string }>,
  ): Promise<CommandRecord> {
    const binary = await ensureBinary(context);
    const authArgs: string[] = [];
    const environment: Record<string, string> = {
      PATH: `${dirname(binary)}:${dirname(process.execPath)}`,
      HOME: home,
      KANTHORD_BASE_URL: baseUrl,
    };
    if (options?.tokenFile !== undefined) {
      authArgs.push("--api-token-file", options.tokenFile);
    } else {
      environment.KANTHORD_TOKEN = token;
    }
    return runCommand(context.sink, {
      argv: [binary, ...authArgs, ...argv],
      cwd: home,
      env: environment,
    });
  }

  async function issueAs(
    _role: HostRole,
    input: Parameters<HttpIssuer>[0],
  ): Promise<Readonly<{ status: number; body: string }>> {
    return issue(input);
  }

  async function registerActor(
    role: HostRole,
    name: string,
  ): Promise<Readonly<{ actorId: string; tokenFile: string }>> {
    const tokenFile = nextTokenFile(role);
    const record = await cliAs(role, [
      "actor",
      "register",
      "--name",
      name,
      "--token-file",
      tokenFile,
    ]);
    return { actorId: parseActorId(record), tokenFile };
  }

  const driver: ExecutionDriver = {
    name: "local",
    async identity(): Promise<BundleIdentity> {
      return {
        hostname: hostname(),
        platform: platform(),
        architecture: arch(),
      };
    },
    async deliverBinary(): Promise<string> {
      return ensureBinary(context);
    },
    async deliverDirectory(
      _role: HostRole,
      source: string,
      name: string,
    ): Promise<string> {
      const destination = join(base, "deliver", name);
      await mkdir(dirname(destination), { recursive: true });
      await cp(source, destination, { recursive: true });
      return destination;
    },
    async retrieveDirectory(
      _role: HostRole,
      source: string,
      destination: string,
    ): Promise<void> {
      await mkdir(dirname(destination), { recursive: true });
      await cp(source, destination, { recursive: true });
    },
    deliverConfig,
    async deliverToken(value: string): Promise<string> {
      token = value;
      if (value.length > 0) {
        secrets.hold(value);
      }
      const path = join(home, "token");
      await writeFile(path, `${value}\n`, { mode: 0o600 });
      return path;
    },
    async probeOrigin(input: OriginProbeInput): Promise<readonly ProbeRow[]> {
      return runOriginProbe(
        (script) =>
          runCommand(context.sink, {
            argv: ["/bin/sh", "-c", script],
            env: { PATH: process.env.PATH ?? "" },
          }),
        input,
      );
    },
    async assertBareMachine(): Promise<void> {
      try {
        await stat("/etc/kanthord/config.json");
      } catch {
        return;
      }
      throw new RunnerError(
        "unavailable",
        "/etc/kanthord/config.json exists on the daemon host; P1-E1 needs a bare machine",
      );
    },
    cliAs,
    async cli(argv: readonly string[]): Promise<CommandRecord> {
      return cliAs("client", argv);
    },
    issueAs,
    registerActor,
    async issue(input) {
      return issueAs("client", input);
    },
    async daemonNetwork(): Promise<
      Readonly<{ bind: string; port: number; allowedHosts: readonly string[] }>
    > {
      const port = await allocateLocalPort();
      return {
        bind: "127.0.0.1",
        port,
        allowedHosts: [`127.0.0.1:${String(port)}`],
      };
    },
    async startDaemon(config: DaemonConfig): Promise<DaemonHandle> {
      await deliverConfig(config);
      const binary = await ensureBinary(context);
      baseUrl = `http://${config.http.bind}:${config.http.port}`;
      token = config.http.token;
      if (token.length > 0) {
        secrets.hold(token);
      }

      const migration = await runCommand(context.sink, {
        argv: [binary, "db", "migrate", "--home", config.home],
        cwd: home,
        env: {
          PATH: `${dirname(binary)}:${dirname(process.execPath)}`,
          HOME: home,
        },
      });
      if (migration.exitCode !== 0) {
        throw new RunnerError(
          "unavailable",
          `kanthord db migrate --home ${config.home} exited ${String(migration.exitCode)}: ${migration.stderr}`,
        );
      }

      const { child } = await spawnServe(binary);
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];

      await withDeadline<void>(
        (resolve, reject) => {
          child.stdout?.on("data", (chunk: Buffer) => {
            stdoutChunks.push(chunk);
            daemonLogs = {
              stdout: Buffer.concat(stdoutChunks).toString("utf8"),
              stderr: Buffer.concat(stderrChunks).toString("utf8"),
            };
            if (daemonLogs.stdout.includes("kanthord: ready\n")) {
              resolve();
            }
          });
          child.stderr?.on("data", (chunk: Buffer) => {
            stderrChunks.push(chunk);
            daemonLogs = {
              stdout: Buffer.concat(stdoutChunks).toString("utf8"),
              stderr: Buffer.concat(stderrChunks).toString("utf8"),
            };
          });
          child.on("error", reject);
          child.on("exit", (code) => {
            reject(
              new RunnerError(
                "unavailable",
                `the daemon process exited with code ${String(code)} before becoming ready`,
              ),
            );
          });
        },
        readinessDeadlineMilliseconds,
        () =>
          new RunnerError(
            "assertion-failed",
            `the daemon was not ready within ${readinessDeadlineMilliseconds}ms`,
          ),
      );

      context.take({
        kind: "process",
        id: `${config.http.bind}:${String(config.http.port)}`,
        async release(): Promise<void> {
          if (child.exitCode === null) {
            child.kill("SIGTERM");
            await new Promise<void>((resolve) =>
              child.once("exit", () => resolve()),
            );
          }
        },
      });
      context.take({
        kind: "home",
        id: home,
        async release(): Promise<void> {
          await rm(home, { recursive: true, force: true });
        },
      });

      return {
        baseUrl,
        allowedHost: config.http.allowedHosts[0] ?? "",
        async ready(): Promise<void> {
          return;
        },
        async stop(): Promise<void> {
          if (child.exitCode === null) {
            child.kill("SIGTERM");
            await new Promise<void>((resolve) =>
              child.once("exit", () => resolve()),
            );
          }
        },
        async logs(): Promise<Readonly<{ stdout: string; stderr: string }>> {
          return daemonLogs;
        },
      };
    },
    async startDaemonExpectingRefusal(
      config: DaemonConfig | null,
    ): Promise<CommandRecord> {
      if (config !== null) {
        await deliverConfig(config);
      }
      const binary = await ensureBinary(context);
      const { child } = await spawnServe(binary);

      return new Promise<CommandRecord>((resolve, reject) => {
        const stdoutChunks: Buffer[] = [];
        const stderrChunks: Buffer[] = [];
        child.stdout?.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
        child.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
        child.on("error", reject);
        child.on("exit", (code) => {
          const record: CommandRecord = {
            argv: [binary, "serve"],
            cwd: home,
            exitCode: code ?? 0,
            stdout: Buffer.concat(stdoutChunks).toString("utf8"),
            stderr: Buffer.concat(stderrChunks).toString("utf8"),
          };
          context.sink.record(record);
          resolve(record);
        });
      });
    },
    async collectLogs(): Promise<Readonly<Record<string, string>>> {
      return { daemon: `${daemonLogs.stdout}${daemonLogs.stderr}` };
    },
  };

  return driver;
}
