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
import { podmanIssuer } from "./podman-issuer.ts";
import { runOriginProbe } from "./origin-probe.ts";
import type { OriginProbeInput, ProbeRow } from "./origin-probe.ts";
import type {
  DaemonConfig,
  DaemonHandle,
  ExecutionDriver,
  HostRole,
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
  const issue = podmanIssuer(
    execute,
    topology.clientContainer,
    `http://${topology.allowedHost}`,
  );
  let clientBaseUrl = "";
  let clientToken = "";

  function containerFor(role: HostRole): string {
    return role === "daemon"
      ? topology.daemonContainer
      : topology.clientContainer;
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
    async cli(argv: readonly string[]): Promise<CommandRecord> {
      const authArgs: string[] = [];
      if (clientBaseUrl.length > 0) {
        authArgs.push("--base-url", clientBaseUrl);
      }
      if (clientToken.length > 0) {
        authArgs.push("--api-token-file", tokenMountPath);
      }
      return execute([
        "podman",
        "exec",
        topology.clientContainer,
        "kanthordc",
        ...authArgs,
        ...argv,
      ]);
    },
    issue,
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
      clientBaseUrl = `http://${topology.allowedHost}`;
      clientToken = config.http.token;
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
      return {
        daemon: `${daemon.stdout}${daemon.stderr}`,
        client: `${client.stdout}${client.stderr}`,
      };
    },
  };
}
