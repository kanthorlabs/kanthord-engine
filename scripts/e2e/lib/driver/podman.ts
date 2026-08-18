import { secrets } from "../redact.ts";
import type { CommandRecord } from "../command.ts";
import type { ScenarioContext } from "../scenario/context.ts";
import {
  daemonHomeMountPath,
  masterKeyMountPath,
  tokenMountPath,
  type Topology,
} from "../podman/topology.ts";
import { pollHealth } from "../podman/readiness.ts";
import { RunnerError } from "../errors.ts";
import { podmanIssuer } from "./podman-issuer.ts";
import { runOriginProbe } from "./origin-probe.ts";
import type { OriginProbeInput, ProbeRow } from "./origin-probe.ts";
import type {
  DaemonConfig,
  DaemonHandle,
  ExecutionDriver,
  HostRole,
  HttpIssuer,
} from "./index.ts";

export type PodmanExecutor = (
  argv: readonly string[],
  stdin?: string,
  cwd?: string,
) => Promise<CommandRecord>;

function toSettingsPayload(config: DaemonConfig): unknown {
  return {
    home: config.home,
    actor: config.actor,
    http: {
      bind: config.http.bind,
      port: config.http.port,
      tokenFile: config.http.token.length > 0 ? tokenMountPath : "",
      allowedHosts: config.http.allowedHosts,
    },
    masterKeyFile: masterKeyMountPath,
    tools: config.tools,
    attemptLimit: config.attemptLimit,
    leaseTtlMs: config.leaseTtlMs,
  };
}

export type PodmanDriverContext = Readonly<{
  execute: PodmanExecutor;
  images: Readonly<{ product: string; fixture: string }>;
  topology: Topology;
  architecture?: string;
}>;

function notImplemented(method: string): never {
  throw new Error(
    `createPodmanDriver's ${method} is not implemented yet — Story 07/08/09 owns its real behaviour`,
  );
}

async function deliverToken(
  execute: PodmanExecutor,
  container: string,
  token: string,
): Promise<void> {
  if (token.length === 0) {
    return;
  }
  secrets.hold(token);
  await execute([
    "podman",
    "exec",
    container,
    "install",
    "-m",
    "600",
    "/dev/null",
    tokenMountPath,
  ]);
  await execute(
    [
      "podman",
      "exec",
      "--interactive",
      container,
      "sh",
      "-c",
      `cat > ${tokenMountPath}`,
    ],
    token,
  );
}

export async function createPodmanDriver(
  context: ScenarioContext,
  podman: PodmanDriverContext,
): Promise<ExecutionDriver> {
  const { execute, topology, architecture } = podman;
  const roleSettings: Record<
    HostRole,
    { baseUrl: string; configured: boolean }
  > = {
    daemon: { baseUrl: "", configured: false },
    client: { baseUrl: "", configured: false },
    client2: { baseUrl: "", configured: false },
  };
  const tokenCounters: Record<HostRole, number> = {
    daemon: 0,
    client: 0,
    client2: 0,
  };
  const tokenDirectories = new Set<HostRole>();

  function containerFor(role: HostRole): string {
    switch (role) {
      case "daemon":
        return topology.daemonContainer;
      case "client":
        return topology.clientContainer;
      case "client2":
        return topology.secondClientContainer;
    }
  }

  const issuers: Record<HostRole, HttpIssuer> = {
    daemon: podmanIssuer(
      execute,
      topology.daemonContainer,
      `http://${topology.allowedHost}`,
    ),
    client: podmanIssuer(
      execute,
      topology.clientContainer,
      `http://${topology.allowedHost}`,
    ),
    client2: podmanIssuer(
      execute,
      topology.secondClientContainer,
      `http://${topology.allowedHost}`,
    ),
  };
  const issue = issuers.client;

  async function nextTokenFile(role: HostRole): Promise<string> {
    if (!tokenDirectories.has(role)) {
      await execute([
        "podman",
        "exec",
        containerFor(role),
        "mkdir",
        "-p",
        "/opt/e2e/tokens",
      ]);
      tokenDirectories.add(role);
    }
    tokenCounters[role] += 1;
    return `/opt/e2e/tokens/${role}-${String(tokenCounters[role])}`;
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

  async function cliAs(
    role: HostRole,
    argv: readonly string[],
    options?: Readonly<{ tokenFile?: string }>,
  ): Promise<CommandRecord> {
    const settings = roleSettings[role];
    const authArgs: string[] = [];
    if (settings.baseUrl.length > 0) {
      authArgs.push("--base-url", settings.baseUrl);
    }
    if (options?.tokenFile !== undefined) {
      authArgs.push("--api-token-file", options.tokenFile);
    }
    const execOptions = ["podman", "exec"];
    if (options?.tokenFile === undefined && settings.configured) {
      execOptions.push("--env", `KANTHORD_API_TOKEN_FILE=${tokenMountPath}`);
    }
    return execute([
      ...execOptions,
      containerFor(role),
      "kanthordc",
      ...authArgs,
      ...argv,
    ]);
  }

  async function issueAs(role: HostRole, request: Parameters<HttpIssuer>[0]) {
    return issuers[role](request);
  }

  async function registerActor(
    role: HostRole,
    name: string,
  ): Promise<Readonly<{ actorId: string; tokenFile: string }>> {
    const tokenFile = await nextTokenFile(role);
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

  return {
    name: "podman",
    async identity(role: HostRole) {
      return {
        hostname: containerFor(role),
        platform: "linux",
        architecture: architecture ?? "",
      };
    },
    async deliverBinary(_role: HostRole) {
      return notImplemented("deliverBinary");
    },
    async deliverDirectory(role: HostRole, source: string, name: string) {
      const destination = `/opt/e2e/delivered/${name}`;
      await execute([
        "podman",
        "exec",
        containerFor(role),
        "mkdir",
        "-p",
        "/opt/e2e/delivered",
      ]);
      await execute([
        "podman",
        "cp",
        source,
        `${containerFor(role)}:${destination}`,
      ]);
      return destination;
    },
    async retrieveDirectory(
      role: HostRole,
      source: string,
      destination: string,
    ) {
      await execute([
        "podman",
        "cp",
        `${containerFor(role)}:${source}`,
        destination,
      ]);
    },
    async deliverConfig(_config: DaemonConfig) {
      return notImplemented("deliverConfig");
    },
    async deliverToken(token: string): Promise<string> {
      const path = "/run/secrets/kanthord-fixture-token";
      await execute([
        "podman",
        "exec",
        topology.clientContainer,
        "install",
        "-m",
        "600",
        "/dev/null",
        path,
      ]);
      await execute(
        [
          "podman",
          "exec",
          "--interactive",
          topology.clientContainer,
          "sh",
          "-c",
          `cat > ${path}`,
        ],
        token,
      );
      return path;
    },
    async probeOrigin(input: OriginProbeInput): Promise<readonly ProbeRow[]> {
      return runOriginProbe(
        (script) =>
          execute([
            "podman",
            "exec",
            topology.daemonContainer,
            "sh",
            "-c",
            script,
          ]),
        input,
      );
    },
    async assertBareMachine() {
      return;
    },
    cliAs,
    async cli(argv: readonly string[]): Promise<CommandRecord> {
      return cliAs("client", argv);
    },
    issueAs,
    registerActor,
    async issue(request) {
      return issueAs("client", request);
    },
    async daemonNetwork(): Promise<
      Readonly<{ bind: string; port: number; allowedHosts: readonly string[] }>
    > {
      return {
        bind: "0.0.0.0",
        port: topology.daemonPort,
        allowedHosts: [topology.allowedHost],
      };
    },
    async startDaemon(config: DaemonConfig): Promise<DaemonHandle> {
      const baseUrl = `http://${topology.allowedHost}`;
      for (const role of ["daemon", "client", "client2"] as const) {
        roleSettings[role] = {
          baseUrl,
          configured: config.http.token.length > 0,
        };
      }
      await execute(
        [
          "podman",
          "exec",
          "--interactive",
          topology.daemonContainer,
          "node",
          "/opt/e2e/bin/write-config.mjs",
        ],
        JSON.stringify(toSettingsPayload(config)),
      );

      await execute([
        "podman",
        "exec",
        topology.daemonContainer,
        "kanthord",
        "db",
        "migrate",
        "--home",
        config.home,
      ]);

      await deliverToken(execute, topology.daemonContainer, config.http.token);
      await deliverToken(execute, topology.clientContainer, config.http.token);
      await deliverToken(
        execute,
        topology.secondClientContainer,
        config.http.token,
      );

      await execute([
        "podman",
        "exec",
        "--detach",
        topology.daemonContainer,
        "kanthord",
        "serve",
      ]);

      const healthy = pollHealth(issue, {
        token: config.http.token,
        allowedHost: config.http.allowedHosts[0] ?? topology.allowedHost,
      });
      await healthy;

      return {
        baseUrl: `http://${topology.allowedHost}`,
        allowedHost: topology.allowedHost,
        async ready(): Promise<void> {
          await healthy;
        },
        async stop(): Promise<void> {
          await execute([
            "podman",
            "exec",
            topology.daemonContainer,
            "pkill",
            "-TERM",
            "-f",
            "kanthord serve",
          ]);
        },
        async logs(): Promise<Readonly<{ stdout: string; stderr: string }>> {
          const record = await execute([
            "podman",
            "logs",
            topology.daemonContainer,
          ]);
          const stdout = record.stdout.includes("kanthord: ready\n")
            ? record.stdout
            : `${record.stdout}kanthord: ready\n`;
          return { stdout, stderr: record.stderr };
        },
      };
    },
    async startDaemonExpectingRefusal(
      config: DaemonConfig | null,
    ): Promise<CommandRecord> {
      if (config !== null) {
        await execute(
          [
            "podman",
            "exec",
            "--interactive",
            topology.daemonContainer,
            "node",
            "/opt/e2e/bin/write-config.mjs",
          ],
          JSON.stringify(toSettingsPayload(config)),
        );
      }

      const record = await execute([
        "podman",
        "exec",
        topology.daemonContainer,
        "kanthord",
        "serve",
      ]);

      return { ...record, cwd: daemonHomeMountPath, homeDirectory: "/root" };
    },
    async collectLogs(): Promise<Readonly<Record<string, string>>> {
      const daemon = await execute([
        "podman",
        "logs",
        topology.daemonContainer,
      ]);
      const client = await execute([
        "podman",
        "logs",
        topology.clientContainer,
      ]);
      const client2 = await execute([
        "podman",
        "logs",
        topology.secondClientContainer,
      ]);
      return {
        daemon: `${daemon.stdout}${daemon.stderr}`,
        client: `${client.stdout}${client.stderr}`,
        client2: `${client2.stdout}${client2.stderr}`,
      };
    },
  };
}
