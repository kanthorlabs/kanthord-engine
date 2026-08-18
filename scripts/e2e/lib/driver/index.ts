import type { BundleIdentity } from "../bundle.ts";
import type { CommandRecord } from "../command.ts";
import type { OriginProbeInput, ProbeRow } from "./origin-probe.ts";

export type DriverName = "local" | "podman" | "ssh";

export type HostRole = "daemon" | "client" | "client2";

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
  leaseTtlMs: number;
}>;

export type DaemonHandle = Readonly<{
  baseUrl: string;
  allowedHost: string;
  ready(): Promise<void>;
  stop(): Promise<void>;
  logs(): Promise<Readonly<{ stdout: string; stderr: string }>>;
}>;

export type HttpRequest = Readonly<{
  method: string;
  path: string;
  headers: Readonly<Record<string, string>>;
  omitHost: boolean;
  body?: string;
  tokenFile?: string;
}>;

export type HttpResponse = Readonly<{ status: number; body: string }>;

export type HttpIssuer = (request: HttpRequest) => Promise<HttpResponse>;

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
  cliAs(
    role: HostRole,
    argv: readonly string[],
    options?: Readonly<{ tokenFile?: string }>,
  ): Promise<CommandRecord>;
  issue: HttpIssuer;
  issueAs(role: HostRole, request: HttpRequest): Promise<HttpResponse>;
  registerActor(
    role: HostRole,
    name: string,
  ): Promise<Readonly<{ actorId: string; tokenFile: string }>>;
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
  "cliAs",
  "issue",
  "issueAs",
  "registerActor",
  "daemonNetwork",
  "startDaemon",
  "startDaemonExpectingRefusal",
  "collectLogs",
];
