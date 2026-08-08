import { RunnerError } from "./errors.ts";
import { secrets } from "./redact.ts";
import type { PodmanExecutor } from "./driver/podman.ts";
import {
  masterKeyMountPath,
  tokenMountPath,
  type Topology,
} from "./podman/topology.ts";
import type { ScenarioContext } from "./scenario/context.ts";

export type DisclosureSurface = Readonly<{ name: string }>;

export const disclosureSurfaces: readonly DisclosureSurface[] = [
  { name: "bearer-header" },
  { name: "basic-header" },
  { name: "config" },
  { name: "printed-commands" },
  { name: "daemon-logs" },
  { name: "podman-inspect" },
  { name: "diagnostics" },
];

const configPath = "/var/lib/kanthord/kanthord.config.json";

function containsAnySecret(text: string): boolean {
  return secrets.forms().some((form) => text.includes(form));
}

async function statMode(
  execute: PodmanExecutor,
  daemonContainer: string,
  path: string,
): Promise<string> {
  const record = await execute([
    "podman",
    "exec",
    daemonContainer,
    "stat",
    "-c",
    "%a",
    path,
  ]);
  return record.stdout.trim();
}

export async function assertNoDisclosure(
  context: ScenarioContext,
  execute: PodmanExecutor,
  topology: Topology,
): Promise<void> {
  if (secrets.forms().length === 0) {
    throw new RunnerError(
      "assertion-failed",
      "the secret registry is empty; a disclosure assertion would be vacuous",
    );
  }

  const httpLogs = Object.entries(context.logs?.() ?? {})
    .filter(([name]) => name.endsWith(".http"))
    .map(([, text]) => text)
    .join("\n");
  context.assert(
    "no-disclosure-bearer-header",
    false,
    containsAnySecret(httpLogs),
  );

  const basicHeaderLog = await execute([
    "podman",
    "logs",
    topology.fixtureContainer,
  ]);
  context.assert(
    "no-disclosure-basic-header",
    false,
    containsAnySecret(basicHeaderLog.stdout),
  );

  const configDump = await execute([
    "podman",
    "exec",
    topology.daemonContainer,
    "cat",
    configPath,
  ]);
  context.assert(
    "no-disclosure-config",
    false,
    containsAnySecret(configDump.stdout),
  );

  const printedCommandsText = [
    ...(context.printedLines?.() ?? []),
    ...(context.commandsRecorded?.() ?? []).flatMap((record) => [
      record.argv.join(" "),
      record.stdout,
      record.stderr,
    ]),
  ].join("\n");
  context.assert(
    "no-disclosure-printed-commands",
    false,
    containsAnySecret(printedCommandsText),
  );

  const daemonLogs = await execute([
    "podman",
    "logs",
    topology.daemonContainer,
  ]);
  context.assert(
    "no-disclosure-daemon-logs",
    false,
    containsAnySecret(daemonLogs.stdout),
  );

  const inspectOutput = await execute([
    "podman",
    "inspect",
    topology.pod,
    topology.fixtureContainer,
    topology.daemonContainer,
    topology.clientContainer,
  ]);
  context.assert(
    "no-disclosure-podman-inspect",
    false,
    containsAnySecret(inspectOutput.stdout),
  );

  const diagnosticsText = Object.values(context.logs?.() ?? {}).join("\n");
  context.assert(
    "no-disclosure-diagnostics",
    false,
    containsAnySecret(diagnosticsText),
  );

  const modes = [
    await statMode(execute, topology.daemonContainer, configPath),
    await statMode(execute, topology.daemonContainer, tokenMountPath),
    await statMode(execute, topology.daemonContainer, masterKeyMountPath),
  ];
  context.assert("no-disclosure-config-mode", ["600", "600", "600"], modes);
}
