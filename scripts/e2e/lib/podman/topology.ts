import type { ScenarioContext } from "../scenario/context.ts";
import type { PodmanExecutor } from "../driver/podman.ts";

export type Topology = Readonly<{
  runId: string;
  network: string;
  pod: string;
  fixtureContainer: string;
  daemonContainer: string;
  clientContainer: string;
  volume: string;
  daemonAlias: string;
  daemonPort: number;
  fixturePort: number;
  allowedHost: string;
  fixtureOrigin: string;
}>;

export const tokenMountPath = "/run/secrets/kanthord-token";
export const masterKeyMountPath = "/run/secrets/kanthord-master";
export const daemonHomeMountPath = "/var/lib/kanthord";

export function tokenSecretName(runId: string): string {
  return `kanthord-token-${runId}`;
}

export function planTopology(runId: string): Topology {
  return {
    runId,
    network: `kanthord-e2e-${runId}`,
    pod: `kanthord-e2e-pod-${runId}`,
    fixtureContainer: `kanthord-e2e-fixture-${runId}`,
    daemonContainer: `kanthord-e2e-daemon-${runId}`,
    clientContainer: `kanthord-e2e-client-${runId}`,
    volume: `kanthord-e2e-home-${runId}`,
    daemonAlias: "kanthord-daemon",
    daemonPort: 7421,
    fixturePort: 7422,
    allowedHost: "kanthord-daemon:7421",
    fixtureOrigin: "http://127.0.0.1:7422",
  };
}

export async function createTopology(
  context: ScenarioContext,
  execute: PodmanExecutor,
  images: Readonly<{ product: string; fixture: string }>,
  topology: Topology,
  secretPaths: Readonly<{ tokenFile: string; masterKeyFile: string }>,
): Promise<void> {
  const label = `kanthord-e2e-run=${topology.runId}`;
  const tokenSecret = tokenSecretName(topology.runId);
  const masterSecret = `kanthord-master-${topology.runId}`;
  const secretArguments = [
    "--secret",
    `${tokenSecret},type=mount,target=${tokenMountPath},mode=0600`,
    "--secret",
    `${masterSecret},type=mount,target=${masterKeyMountPath},mode=0600`,
  ];

  await execute([
    "podman",
    "network",
    "create",
    "--internal",
    "--label",
    label,
    topology.network,
  ]);
  context.take({
    kind: "network",
    id: topology.network,
    async release(): Promise<void> {
      await execute(["podman", "network", "rm", topology.network]);
    },
  });

  await execute([
    "podman",
    "volume",
    "create",
    "--label",
    label,
    topology.volume,
  ]);
  context.take({
    kind: "volume",
    id: topology.volume,
    async release(): Promise<void> {
      await execute(["podman", "volume", "rm", topology.volume]);
    },
  });

  await execute([
    "podman",
    "pod",
    "create",
    "--name",
    topology.pod,
    "--network",
    `${topology.network}:alias=${topology.daemonAlias}`,
    "--label",
    label,
  ]);
  context.take({
    kind: "pod",
    id: topology.pod,
    async release(): Promise<void> {
      await execute(["podman", "pod", "rm", "-f", topology.pod]);
    },
  });

  await execute([
    "podman",
    "run",
    "--detach",
    "--pod",
    topology.pod,
    "--name",
    topology.fixtureContainer,
    "--label",
    label,
    "--pull=never",
    images.fixture,
    "node",
    "/opt/fixture/main.ts",
    "--bind",
    "127.0.0.1",
    "--port",
    String(topology.fixturePort),
  ]);
  context.take({
    kind: "container",
    id: topology.fixtureContainer,
    async release(): Promise<void> {
      await execute(["podman", "rm", "-f", topology.fixtureContainer]);
    },
  });

  await execute([
    "podman",
    "secret",
    "create",
    "--label",
    label,
    tokenSecret,
    secretPaths.tokenFile,
  ]);
  context.take({
    kind: "secret",
    id: tokenSecret,
    async release(): Promise<void> {
      await execute(["podman", "secret", "rm", tokenSecret]);
    },
  });

  await execute([
    "podman",
    "secret",
    "create",
    "--label",
    label,
    masterSecret,
    secretPaths.masterKeyFile,
  ]);
  context.take({
    kind: "secret",
    id: masterSecret,
    async release(): Promise<void> {
      await execute(["podman", "secret", "rm", masterSecret]);
    },
  });

  await execute([
    "podman",
    "run",
    "--detach",
    "--pod",
    topology.pod,
    "--name",
    topology.daemonContainer,
    "--label",
    label,
    "--pull=never",
    "--volume",
    `${topology.volume}:${daemonHomeMountPath}`,
    ...secretArguments,
    images.product,
    "sleep",
    "infinity",
  ]);
  context.take({
    kind: "container",
    id: topology.daemonContainer,
    async release(): Promise<void> {
      await execute(["podman", "rm", "-f", topology.daemonContainer]);
    },
  });

  await execute([
    "podman",
    "run",
    "--detach",
    "--network",
    topology.network,
    "--name",
    topology.clientContainer,
    "--label",
    label,
    "--pull=never",
    ...secretArguments,
    images.product,
    "sleep",
    "infinity",
  ]);
  context.take({
    kind: "container",
    id: topology.clientContainer,
    async release(): Promise<void> {
      await execute(["podman", "rm", "-f", topology.clientContainer]);
    },
  });
}
