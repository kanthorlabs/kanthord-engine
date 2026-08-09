import type { BundleIdentity } from "../bundle.ts";
import type { CommandRecord } from "../command.ts";
import type { OriginProbeInput, ProbeRow } from "./origin-probe.ts";

export type DriverName = "local" | "podman" | "ssh";

export type HostRole = "daemon" | "client";

export type DaemonConfig = Readonly<{
  home: string;
  actor: string;
  masterKey: string;
  http: Readonly<{
    bind: string;
    port: number;
    token: string;
    allowedHosts: readonly string[];
  }>;
  tools: Readonly<{ git: string; ssh: string; sshKeyscan: string }>;
  attemptLimit: number;
}>;

export type DaemonHandle = Readonly<{
  baseUrl: string;
  allowedHost: string;
  ready(): Promise<void>;
  stop(): Promise<void>;
  logs(): Promise<Readonly<{ stdout: string; stderr: string }>>;
}>;

export type HttpIssuer = (
  request: Readonly<{
    method: string;
    path: string;
    headers: Readonly<Record<string, string>>;
    omitHost: boolean;
    body?: string;
  }>,
) => Promise<Readonly<{ status: number; body: string }>>;

export type ExecutionDriver = Readonly<{
  name: DriverName;
  identity(role: HostRole): Promise<BundleIdentity>;
  deliverBinary(role: HostRole): Promise<string>;
  deliverDirectory(
    role: HostRole,
    source: string,
    name: string,
  ): Promise<string>;
  retrieveDirectory(
    role: HostRole,
    source: string,
    destination: string,
  ): Promise<void>;
  deliverConfig(config: DaemonConfig): Promise<string>;
  deliverToken(token: string): Promise<string>;
  probeOrigin(input: OriginProbeInput): Promise<readonly ProbeRow[]>;
  assertBareMachine(): Promise<void>;
  cli(argv: readonly string[]): Promise<CommandRecord>;
  issue: HttpIssuer;
  daemonNetwork?(): Promise<
    Readonly<{ bind: string; port: number; allowedHosts: readonly string[] }>
  >;
  startDaemon(config: DaemonConfig): Promise<DaemonHandle>;
  startDaemonExpectingRefusal(
    config: DaemonConfig | null,
  ): Promise<CommandRecord>;
  collectLogs(): Promise<Readonly<Record<string, string>>>;
}>;

export const driverMethodNames: readonly (keyof ExecutionDriver)[] = [
  "name",
  "identity",
  "deliverBinary",
  "deliverDirectory",
  "retrieveDirectory",
  "deliverConfig",
  "deliverToken",
  "probeOrigin",
  "assertBareMachine",
  "cli",
  "issue",
  "daemonNetwork",
  "startDaemon",
  "startDaemonExpectingRefusal",
  "collectLogs",
];
