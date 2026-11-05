import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  ContainerRuntime,
  PlacementIssue,
  type PlacementStatus,
  PoolPlacement,
} from "../../worker/contract.ts";
import {
  absentImage,
  boundedDetail,
  bytesOf,
  cacheOwnerArguments,
  cacheVolumeArguments,
  cacheVolumeName,
  containerOwner,
  containerRemovalFailure,
  detectRuntime,
  IdMap,
  idMapOf,
  imageIdOf,
  imageListArguments,
  infoArguments,
  inspectContainerArguments,
  inspectVolumeArguments,
  killArguments,
  migrationArguments,
  ownedArguments,
  ownedCacheVolumeArguments,
  ownedImageArguments,
  parseCacheVolumes,
  parsePodmanUsage,
  parseRuntimeStore,
  parseSystemUsage,
  parseVolume,
  PODMAN_MIN_VERSION,
  readSystemUsage,
  removeArguments,
  removeImageArguments,
  runArguments,
  type RuntimeAnswer,
  type RuntimeFacts,
  type RuntimeHost,
  sameImage,
  slotInstanceName,
  SUCCESS_CODE,
  systemUsageArguments,
  timeOf,
  unshareMigrationArguments,
  unshareOwnerArguments,
  versionBelow,
  volumeArguments,
} from "./container-runtime.ts";

const INSTANCE_NAME = "coder-1";
const OWNER = "0123456789ABCDEFGHJKMNPQRS";
const IMAGE = "localhost/kanthord-dev:28.0.1";
const NAME_OF_SLOT = `kanthord_slot_${INSTANCE_NAME}`;
const SESSION_DIRECTORY = `/state/workers/${INSTANCE_NAME}/sessions`;
const SLOT_STATE = {
  sessionDirectory: SESSION_DIRECTORY,
  rootless: false,
  selinux: false,
};
const SECRET = "slot_client_secret_value";
const SERVER_USER = "kanthord";
const SERVER_UID = 1000;
const ROOT_UID = 0;
const DETAIL_LIMIT_BYTES = 200;
const ENV_OPTION = "--env";
const FIRST_LINE = "first line";
const SUCCESS = 0;
const ROOTLESS_DOCKER_DETAIL =
  "rootless Docker cannot map the container uid 10001 to the server user. Use rootless Podman or a rootful runtime.";
const FAILURE = 1;
const RUNTIME_ERROR = 125;
const PODMAN_STOPPED =
  "Cannot connect to Podman. Please verify your connection to the Linux system using `podman system connection list`, or try `podman machine init` and `podman machine start` to manage a new Linux VM";
const DOCKER_STOPPED =
  "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?";
const FORWARDED_ENVIRONMENT = {
  TZ: "Europe/Berlin",
  GIT_AUTHOR_NAME: "Author Name",
  GIT_AUTHOR_EMAIL: "author@example.invalid",
  GIT_COMMITTER_NAME: "Committer Name",
  GIT_COMMITTER_EMAIL: "committer@example.invalid",
};
const HOST_ENVIRONMENT = {
  ...FORWARDED_ENVIRONMENT,
  PATH: "/usr/bin:/bin",
  HOME: "/home/kanthord",
  USER: "host-user-name",
  LOGNAME: "host-user-name",
  SHELL: "/bin/bash",
  LANG: "de_DE.UTF-8",
  LC_ALL: "de_DE.UTF-8",
  LC_CTYPE: "de_DE.UTF-8",
  TMPDIR: "/tmp/host",
  KANTHORD_ENDPOINT: "http://127.0.0.1:31415",
  KANTHORD_TOKEN: "host_token_value",
  NODE_OPTIONS: "--inspect",
  SSH_AUTH_SOCK: "/tmp/ssh-agent.sock",
  CLIENT_SECRET: SECRET,
};
const GOLDEN_RUN = [
  "run",
  "--rm",
  "-i",
  "--pull=missing",
  "--name",
  `kanthord_slot_${INSTANCE_NAME}`,
  "--label",
  `io.kanthord.owner=${OWNER}`,
  "--label",
  `io.kanthord.instance=${INSTANCE_NAME}`,
  "--user",
  "10001:10001",
  "--sig-proxy=false",
  "--log-driver",
  "none",
  "--no-healthcheck",
  "--cap-drop=ALL",
  "--security-opt=no-new-privileges",
  "--ulimit",
  "core=0",
  "--read-only",
  "--tmpfs",
  "/tmp:rw,nosuid,nodev,size=64m",
  "--volume",
  `kanthord_slot_${INSTANCE_NAME}:/var/lib/kanthord`,
  "--volume",
  `${SESSION_DIRECTORY}:/var/lib/kanthord/state/kanthord/pi/sessions`,
  "--workdir",
  "/var/lib/kanthord",
  "--env",
  "HOME=/var/lib/kanthord",
  "--env",
  "TMPDIR=/var/lib/kanthord/tmp",
  "--env",
  "LANG=C.UTF-8",
  "--env",
  "XDG_CONFIG_HOME=/var/lib/kanthord/config",
  "--env",
  "XDG_DATA_HOME=/var/lib/kanthord/data",
  "--env",
  "XDG_STATE_HOME=/var/lib/kanthord/state",
  "--env",
  "XDG_CACHE_HOME=/var/lib/kanthord/cache",
  "--env",
  "TZ",
  "--env",
  "GIT_AUTHOR_NAME",
  "--env",
  "GIT_AUTHOR_EMAIL",
  "--env",
  "GIT_COMMITTER_NAME",
  "--env",
  "GIT_COMMITTER_EMAIL",
  "--entrypoint",
  "/usr/bin/tini",
  IMAGE,
  "--",
  "/bin/sh",
  "-c",
  "exec 3>&1 1>&2; exec /usr/local/bin/kanthord serve slot",
];

interface HostFixture {
  platform?: NodeJS.Platform;
  uid?: number;
  markers?: string[];
  environment?: NodeJS.ProcessEnv;
  answers?: Partial<Record<ContainerRuntime, RuntimeAnswer>>;
}

function fakeHost(fixture: HostFixture) {
  const calls: Array<[ContainerRuntime, readonly string[], number]> = [];
  const answers = fixture.answers ?? {};
  const host: RuntimeHost = {
    platform: fixture.platform ?? "linux",
    uid: fixture.uid ?? SERVER_UID,
    user: SERVER_USER,
    environment: fixture.environment ?? {},
    exists: (path) => (fixture.markers ?? []).includes(path),
    resolves: (runtime) => answers[runtime] !== undefined,
    run: (runtime, args, timeoutMs) => {
      calls.push([runtime, args, timeoutMs]);
      return Promise.resolve(answers[runtime]!);
    },
  };
  return { host, calls };
}

function answer(info: unknown, code = SUCCESS, stderr = ""): RuntimeAnswer {
  return {
    code,
    stdout: info === null ? "" : JSON.stringify(info),
    stderr,
  };
}

function podmanInfo(
  rootless: boolean,
  uidmap: Array<{ container_id: number; host_id: number; size: number }>,
  version = "6.0.2",
  extra: { selinuxEnabled?: boolean; serviceIsRemote?: boolean } = {},
) {
  return {
    host: {
      os: "linux",
      security: { rootless, selinuxEnabled: extra.selinuxEnabled ?? false },
      idMappings: { uidmap, gidmap: uidmap },
      serviceIsRemote: extra.serviceIsRemote ?? false,
    },
    version: { Version: version },
  };
}

function dockerInfo(fields: Record<string, unknown> = {}) {
  return {
    ServerVersion: "27.3.1",
    OperatingSystem: "Ubuntu 24.04.1 LTS",
    SecurityOptions: ["name=seccomp,profile=builtin", "name=cgroupns"],
    ClientInfo: { Version: "27.3.1" },
    ...fields,
  };
}

const ROOTLESS_MAP = [
  { container_id: 0, host_id: SERVER_UID, size: 1 },
  { container_id: 1, host_id: 100000, size: 65536 },
];

function expected(
  reason: PlacementIssue | null,
  runtime: ContainerRuntime | null,
  detail: string | null = null,
): PlacementStatus {
  return {
    placement: PoolPlacement.Container,
    available: reason === null,
    reason,
    detail,
    container_runtime: runtime,
  };
}

for (const runtime of Object.values(ContainerRuntime))
  test(`the ${runtime} run command holds every documented option and no secret or env value`, () => {
    const args = runArguments({
      image: IMAGE,
      instanceName: INSTANCE_NAME,
      owner: OWNER,
      environment: HOST_ENVIRONMENT,
      cacheVolume: null,
      ...SLOT_STATE,
    });
    assert.deepEqual([runtime, ...args], [runtime, ...GOLDEN_RUN]);
    const text = args.join("\n");
    assert.ok(!text.includes(SECRET));
    for (const [name, value] of Object.entries(HOST_ENVIRONMENT))
      assert.ok(!text.includes(value), `${name} value reaches the argv`);
    for (const name of [
      "PATH",
      "USER",
      "LOGNAME",
      "SHELL",
      "LC_ALL",
      "LC_CTYPE",
      "KANTHORD_ENDPOINT",
      "KANTHORD_TOKEN",
      "NODE_OPTIONS",
      "SSH_AUTH_SOCK",
      "CLIENT_SECRET",
    ])
      assert.ok(!args.includes(name) && !text.includes(`${name}=`), name);
    assert.ok(!args.includes("-t") && !args.includes("--tty"));
    assert.ok(!args.includes("--init"));
    assert.ok(!args.some((arg) => arg.startsWith("--network")));
    assert.ok(!args.some((arg) => arg.startsWith("--publish")));
  });

test("the run command forwards only the env names that the server sets", () => {
  const args = runArguments({
    image: IMAGE,
    instanceName: INSTANCE_NAME,
    owner: OWNER,
    environment: { TZ: "UTC" },
    cacheVolume: null,
    ...SLOT_STATE,
  });
  const forwarded = args.filter(
    (arg, index) => args[index - 1] === ENV_OPTION && !arg.includes("="),
  );
  assert.deepEqual(forwarded, ["TZ"]);
});

test("the runtime commands of the driver hold their documented argv", () => {
  assert.deepEqual(infoArguments(), ["info", "--format", "json"]);
  assert.deepEqual(ownedArguments(OWNER), [
    "ps",
    "--all",
    "--filter",
    `label=io.kanthord.owner=${OWNER}`,
    "--format",
    "{{.Names}}",
  ]);
  assert.deepEqual(removeArguments(`kanthord_slot_${INSTANCE_NAME}`), [
    "rm",
    "--force",
    `kanthord_slot_${INSTANCE_NAME}`,
  ]);
  assert.deepEqual(
    inspectContainerArguments(`kanthord_slot_${INSTANCE_NAME}`),
    [
      "container",
      "inspect",
      "--format",
      "{{.Id}}",
      `kanthord_slot_${INSTANCE_NAME}`,
    ],
  );
  assert.deepEqual(killArguments(`kanthord_slot_${INSTANCE_NAME}`), [
    "kill",
    "--signal",
    "KILL",
    `kanthord_slot_${INSTANCE_NAME}`,
  ]);
  assert.deepEqual(volumeArguments(INSTANCE_NAME, OWNER), [
    "volume",
    "create",
    "--label",
    `io.kanthord.owner=${OWNER}`,
    "--label",
    `io.kanthord.instance=${INSTANCE_NAME}`,
    "--label",
    "io.kanthord.id_map=auto",
    `kanthord_slot_${INSTANCE_NAME}`,
  ]);
});

test("the owner is a stable 26-character Crockford value of the master key", () => {
  const masterKey = randomBytes(32).toString("base64");
  const owner = containerOwner(masterKey);
  assert.match(owner, /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
  assert.equal(containerOwner(masterKey), owner);
  assert.notEqual(containerOwner(randomBytes(32).toString("base64")), owner);
});

test("a detail holds the first line of the runtime answer within 200 bytes", () => {
  assert.equal(boundedDetail(`\n  ${FIRST_LINE} \nsecond`), FIRST_LINE);
  assert.equal(boundedDetail(""), null);
  const long = boundedDetail("é".repeat(DETAIL_LIMIT_BYTES));
  assert.ok(Buffer.byteLength(long!) <= DETAIL_LIMIT_BYTES);
});

test("a server in a container answers server_in_container before any runtime check", async () => {
  for (const fixture of [
    { markers: ["/.dockerenv"] },
    { markers: ["/run/.containerenv"] },
    { environment: { KUBERNETES_SERVICE_HOST: "10.0.0.1" } },
  ]) {
    const { host, calls } = fakeHost({
      ...fixture,
      answers: { podman: answer(podmanInfo(true, ROOTLESS_MAP)) },
    });
    assert.deepEqual(
      (await detectRuntime(host)).status,
      expected(PlacementIssue.ServerInContainer, null),
    );
    assert.deepEqual(calls, []);
  }
});

test("a host with no runtime on the PATH answers runtime_absent", async () => {
  const { host } = fakeHost({});
  assert.deepEqual(
    (await detectRuntime(host)).status,
    expected(PlacementIssue.RuntimeAbsent, null),
  );
});

test("rootless Podman answers available with a 10 s info check", async () => {
  const { host, calls } = fakeHost({
    answers: {
      podman: answer(podmanInfo(true, ROOTLESS_MAP)),
      docker: answer(dockerInfo()),
    },
  });
  assert.deepEqual(
    (await detectRuntime(host)).status,
    expected(null, ContainerRuntime.Podman),
  );
  assert.deepEqual(calls, [
    [ContainerRuntime.Podman, ["info", "--format", "json"], 10000],
  ]);
});

test("a stopped Podman machine answers runtime_failed with the first stderr line", async () => {
  const { host } = fakeHost({
    platform: "darwin",
    answers: {
      podman: answer(
        null,
        RUNTIME_ERROR,
        `${PODMAN_STOPPED}\nError: unable to connect to Podman socket`,
      ),
    },
  });
  assert.deepEqual(
    (await detectRuntime(host)).status,
    expected(PlacementIssue.RuntimeFailed, null, boundedDetail(PODMAN_STOPPED)),
  );
});

test("the subordinate uid range must cover the container uid 10001", async () => {
  const exact = fakeHost({
    answers: {
      podman: answer(
        podmanInfo(true, [
          { container_id: 0, host_id: SERVER_UID, size: 1 },
          { container_id: 1, host_id: 200000, size: 10001 },
        ]),
      ),
    },
  });
  assert.deepEqual(
    (await detectRuntime(exact.host)).status,
    expected(null, ContainerRuntime.Podman),
  );
  const short = fakeHost({
    answers: {
      podman: answer(
        podmanInfo(true, [
          { container_id: 0, host_id: SERVER_UID, size: 1 },
          { container_id: 1, host_id: 200000, size: 10000 },
        ]),
      ),
    },
  });
  assert.deepEqual(
    (await detectRuntime(short.host)).status,
    expected(
      PlacementIssue.RuntimeFailed,
      ContainerRuntime.Podman,
      `the subordinate uid range of ${SERVER_USER} does not cover the container uid 10001. Add a subordinate uid range of at least 10001 ids for ${SERVER_USER}.`,
    ),
  );
});

test("rootful Podman on Linux answers runtime_rootful for a non-root server", async () => {
  const { host } = fakeHost({
    answers: { podman: answer(podmanInfo(false, [])) },
  });
  assert.deepEqual(
    (await detectRuntime(host)).status,
    expected(PlacementIssue.RuntimeRootful, ContainerRuntime.Podman),
  );
});

test("Docker Desktop answers available on every host", async () => {
  for (const platform of ["darwin", "linux"] as const) {
    const { host } = fakeHost({
      platform,
      answers: {
        docker: answer(dockerInfo({ OperatingSystem: "Docker Desktop" })),
      },
    });
    assert.deepEqual(
      (await detectRuntime(host)).status,
      expected(null, ContainerRuntime.Docker),
    );
  }
});

test("rootless Docker on Linux answers runtime_failed with the detail of its action", async () => {
  const { host } = fakeHost({
    answers: {
      docker: answer(
        dockerInfo({
          SecurityOptions: ["name=seccomp,profile=builtin", "name=rootless"],
        }),
      ),
    },
  });
  assert.deepEqual(await detectRuntime(host), {
    status: expected(
      PlacementIssue.RuntimeFailed,
      ContainerRuntime.Docker,
      ROOTLESS_DOCKER_DETAIL,
    ),
    facts: null,
  });
});

test("rootful Docker on Linux answers runtime_rootful only for a non-root server", async () => {
  const rootful = fakeHost({ answers: { docker: answer(dockerInfo()) } });
  assert.deepEqual(
    (await detectRuntime(rootful.host)).status,
    expected(PlacementIssue.RuntimeRootful, ContainerRuntime.Docker),
  );
  const root = fakeHost({
    uid: ROOT_UID,
    answers: { docker: answer(dockerInfo()) },
  });
  assert.deepEqual(
    (await detectRuntime(root.host)).status,
    expected(null, ContainerRuntime.Docker),
  );
});

test("a stopped Docker daemon answers runtime_failed with its server error", async () => {
  const { host } = fakeHost({
    answers: {
      docker: answer(
        dockerInfo({ ServerVersion: "", ServerErrors: [DOCKER_STOPPED] }),
        FAILURE,
      ),
    },
  });
  assert.deepEqual(
    (await detectRuntime(host)).status,
    expected(PlacementIssue.RuntimeFailed, null, DOCKER_STOPPED),
  );
});

test("a Docker client below version 23 answers runtime_failed with its version", async () => {
  const { host } = fakeHost({
    answers: {
      docker: answer(dockerInfo({ ClientInfo: { Version: "20.10.24" } })),
    },
  });
  assert.deepEqual(
    (await detectRuntime(host)).status,
    expected(
      PlacementIssue.RuntimeFailed,
      null,
      "docker client 20.10.24 is below 23. Upgrade the Docker client to 23 or later.",
    ),
  );
});

test("the podman-docker shim counts as a failed Docker answer", async () => {
  const shim = fakeHost({
    answers: { docker: answer(podmanInfo(true, ROOTLESS_MAP)) },
  });
  assert.deepEqual(
    (await detectRuntime(shim.host)).status,
    expected(
      PlacementIssue.RuntimeFailed,
      null,
      "docker answers no server version. Remove the podman-docker shim, or point docker at a Docker Engine.",
    ),
  );
  const stopped = fakeHost({
    platform: "darwin",
    answers: {
      podman: answer(null, RUNTIME_ERROR, PODMAN_STOPPED),
      docker: answer(null, RUNTIME_ERROR, PODMAN_STOPPED),
    },
  });
  assert.deepEqual(
    (await detectRuntime(stopped.host)).status,
    expected(PlacementIssue.RuntimeFailed, null, boundedDetail(PODMAN_STOPPED)),
  );
});

test("Docker answers when Podman fails, and the first failure names the detail otherwise", async () => {
  const fallback = fakeHost({
    answers: {
      podman: answer(null, RUNTIME_ERROR, PODMAN_STOPPED),
      docker: answer(dockerInfo({ OperatingSystem: "Docker Desktop" })),
    },
  });
  assert.deepEqual(
    (await detectRuntime(fallback.host)).status,
    expected(null, ContainerRuntime.Docker),
  );
  const silent = fakeHost({
    answers: { podman: answer(null, FAILURE) },
  });
  assert.deepEqual(
    (await detectRuntime(silent.host)).status,
    expected(PlacementIssue.RuntimeFailed, null, "podman info exits 1"),
  );
});

const PROJECT_ID = "project_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const RESOURCE = "repository:github:acme/app";
const CACHE_NAME = /^kanthord_cache_[0-9a-f]{24}$/;
const VOLUME_OPTION = "--volume";
const SLOT_VOLUMES = 2;
const NETAVARK_ERROR =
  'Error: netavark (exit code 1): nftables error: "nft" did not return successfully while applying ruleset';
const REMOVE_REFUSED = 125;
const INSPECT_ABSENT = 125;
const CACHE_MOUNT = "/var/lib/kanthord/.cache";

test("cacheVolumeName answers one name for one group and another name for another group", () => {
  const name = cacheVolumeName(OWNER, PROJECT_ID, RESOURCE);
  assert.match(name, CACHE_NAME);
  assert.equal(cacheVolumeName(OWNER, PROJECT_ID, RESOURCE), name);
  assert.notEqual(cacheVolumeName("OTHER", PROJECT_ID, RESOURCE), name);
  assert.notEqual(cacheVolumeName(OWNER, "project_other", RESOURCE), name);
  assert.notEqual(cacheVolumeName(OWNER, PROJECT_ID, "repository:other"), name);
});

test("the run command mounts the cache volume after the slot volume and only when it is set", () => {
  const base = {
    image: IMAGE,
    instanceName: INSTANCE_NAME,
    owner: OWNER,
    environment: {},
    ...SLOT_STATE,
  };
  const mounted = runArguments({ ...base, cacheVolume: "kanthord_cache_abc" });
  const volumes = mounted.flatMap((arg, index) =>
    mounted[index - 1] === VOLUME_OPTION ? [arg] : [],
  );
  assert.deepEqual(volumes, [
    `kanthord_slot_${INSTANCE_NAME}:/var/lib/kanthord`,
    `${SESSION_DIRECTORY}:/var/lib/kanthord/state/kanthord/pi/sessions`,
    `kanthord_cache_abc:${CACHE_MOUNT}`,
  ]);
  const bare = runArguments({ ...base, cacheVolume: null });
  assert.equal(
    bare.filter((arg) => arg === VOLUME_OPTION).length,
    SLOT_VOLUMES,
  );
});

test("cacheVolumeArguments creates the named volume with the owner and group labels", () => {
  assert.deepEqual(cacheVolumeArguments(OWNER, PROJECT_ID, RESOURCE), [
    "volume",
    "create",
    "--label",
    `io.kanthord.owner=${OWNER}`,
    "--label",
    `io.kanthord.cache_project=${PROJECT_ID}`,
    "--label",
    `io.kanthord.cache_resource=${RESOURCE}`,
    "--label",
    "io.kanthord.id_map=auto",
    cacheVolumeName(OWNER, PROJECT_ID, RESOURCE),
  ]);
});

test("slotInstanceName answers null for a cache volume name", () => {
  assert.equal(
    slotInstanceName(cacheVolumeName(OWNER, PROJECT_ID, RESOURCE)),
    null,
  );
});

test("ownedCacheVolumeArguments lists the names of the cache volumes of the owner with no label template", () => {
  assert.deepEqual(ownedCacheVolumeArguments(OWNER), [
    "volume",
    "ls",
    "--filter",
    `label=io.kanthord.owner=${OWNER}`,
    "--filter",
    "label=io.kanthord.cache_project",
    "--format",
    "{{.Name}}",
  ]);
});

test("inspectVolumeArguments inspects each named volume in one command", () => {
  assert.deepEqual(
    inspectVolumeArguments(["kanthord_cache_a", "kanthord_cache_b"]),
    ["volume", "inspect", "kanthord_cache_a", "kanthord_cache_b"],
  );
});

test("parseCacheVolumes answers the name, the creation time and the two labels of each inspected volume and skips a volume without both labels", () => {
  const output = JSON.stringify([
    {
      Name: "kanthord_cache_aaa",
      CreatedAt: "2026-11-01T10:00:00Z",
      Labels: {
        "io.kanthord.owner": OWNER,
        "io.kanthord.cache_project": PROJECT_ID,
        "io.kanthord.cache_resource": RESOURCE,
      },
    },
    {
      Name: `kanthord_slot_${INSTANCE_NAME}`,
      Labels: { "io.kanthord.owner": OWNER },
    },
    {
      Name: "kanthord_cache_bbb",
      Labels: { "io.kanthord.cache_project": PROJECT_ID },
    },
    { Name: "kanthord_cache_ccc", Labels: null },
  ]);
  assert.deepEqual(parseCacheVolumes(output), [
    {
      name: "kanthord_cache_aaa",
      project_id: PROJECT_ID,
      resource_identity: RESOURCE,
      created_at: Date.parse("2026-11-01T10:00:00Z"),
    },
  ]);
});

test("parseCacheVolumes rejects an answer that is not a list", () => {
  assert.throws(() => parseCacheVolumes("not json"));
  assert.throws(() => parseCacheVolumes("{}"));
});

function removal(answers: readonly RuntimeAnswer[]) {
  const calls: string[][] = [];
  const call = (args: readonly string[]) => {
    calls.push([...args]);
    return Promise.resolve(
      answers[calls.length - 1] ?? {
        code: SUCCESS_CODE,
        stdout: "",
        stderr: "",
      },
    );
  };
  return { call, calls };
}

test("containerRemovalFailure answers null after a removal that exits 0 and inspects nothing", async () => {
  const { call, calls } = removal([
    { code: SUCCESS_CODE, stdout: "", stderr: "" },
  ]);
  assert.equal(await containerRemovalFailure(call, NAME_OF_SLOT), null);
  assert.deepEqual(calls, [["rm", "--force", NAME_OF_SLOT]]);
});

test("containerRemovalFailure answers null when the runtime answers no such container", async () => {
  const { call, calls } = removal([
    {
      code: REMOVE_REFUSED,
      stdout: "",
      stderr: `Error: no such container "${NAME_OF_SLOT}"`,
    },
  ]);
  assert.equal(await containerRemovalFailure(call, NAME_OF_SLOT), null);
  assert.deepEqual(calls, [["rm", "--force", NAME_OF_SLOT]]);
});

test("containerRemovalFailure answers null when a refused removal leaves no container", async () => {
  const { call, calls } = removal([
    { code: REMOVE_REFUSED, stdout: "", stderr: NETAVARK_ERROR },
    {
      code: INSPECT_ABSENT,
      stdout: "",
      stderr: `Error: no such container "${NAME_OF_SLOT}"`,
    },
  ]);
  assert.equal(await containerRemovalFailure(call, NAME_OF_SLOT), null);
  assert.deepEqual(calls, [
    ["rm", "--force", NAME_OF_SLOT],
    inspectContainerArguments(NAME_OF_SLOT),
  ]);
});

test("containerRemovalFailure answers the refused removal when the container still exists", async () => {
  const refused = { code: REMOVE_REFUSED, stdout: "", stderr: NETAVARK_ERROR };
  const { call } = removal([
    refused,
    { code: SUCCESS_CODE, stdout: "abc\n", stderr: "" },
  ]);
  assert.deepEqual(await containerRemovalFailure(call, NAME_OF_SLOT), refused);
});

test("containerRemovalFailure answers the refused removal when the inspection fails for another reason", async () => {
  const refused = { code: REMOVE_REFUSED, stdout: "", stderr: NETAVARK_ERROR };
  const { call } = removal([
    refused,
    { code: INSPECT_ABSENT, stdout: "", stderr: "Error: cannot connect" },
  ]);
  assert.deepEqual(await containerRemovalFailure(call, NAME_OF_SLOT), refused);
});

const AUTO_OPTION = "--userns=auto:uidmapping=10001:0:1,gidmapping=10001:0:1";
const KEEP_ID_OPTION = "--userns=keep-id:uid=10001,gid=10001";
const SLOT_USER = "10001:10001";
const MIGRATE_DIRECTORY = `/state/workers/${INSTANCE_NAME}/sessions.partial`;
const LINUX_FACTS: RuntimeFacts = {
  rootless: true,
  selinux: false,
  platform: "linux",
  dockerDesktop: false,
  remote: false,
};
const MACOS_FACTS: RuntimeFacts = {
  ...LINUX_FACTS,
  platform: "darwin",
  remote: true,
};
const HOST_DIRECTORY_SCRIPT =
  'src=/var/lib/kanthord/state/kanthord/pi/sessions; if [ -d "$src" ]; then cp -a "$src/." /migrate/ && rm -rf "$src"; fi; mkdir -p "$src" && chmod 700 /migrate && chown -R 10001:10001 /var/lib/kanthord /migrate';
const FILE_SHARE_SCRIPT =
  'src=/var/lib/kanthord/state/kanthord/pi/sessions; if [ -d "$src" ]; then cp -R --preserve=mode,timestamps "$src/." /migrate/ && rm -rf "$src"; fi; mkdir -p "$src" && chmod 700 /migrate && chown -R 10001:10001 /var/lib/kanthord';
const UNSHARE_SCRIPT =
  'src="$1/state/kanthord/pi/sessions"; if [ -d "$src" ]; then cp -a "$src/." "$2/" && rm -rf "$src"; fi; mkdir -p "$src" && chmod 700 "$2" && chown -R 0:0 "$1" "$2"';

function userNamespaceOf(args: readonly string[]): string[] {
  return args.filter((arg) => arg.startsWith("--userns"));
}

function migrationOf(
  runtime: ContainerRuntime,
  facts: RuntimeFacts,
  labeled: boolean,
) {
  const idMap = idMapOf(runtime, facts, labeled);
  assert.notEqual(idMap, IdMap.Unshare);
  return migrationArguments({
    image: IMAGE,
    instanceName: INSTANCE_NAME,
    owner: OWNER,
    mount: MIGRATE_DIRECTORY,
    idMap: idMap as Exclude<IdMap, typeof IdMap.Unshare>,
    facts,
  });
}

test("the run command mounts the session directory with :Z only on an SELinux host", () => {
  const base = {
    image: IMAGE,
    instanceName: INSTANCE_NAME,
    owner: OWNER,
    environment: {},
    cacheVolume: null,
    ...SLOT_STATE,
  };
  const plain = runArguments(base);
  assert.ok(
    plain.includes(
      `${SESSION_DIRECTORY}:/var/lib/kanthord/state/kanthord/pi/sessions`,
    ),
  );
  const labeled = runArguments({ ...base, selinux: true });
  assert.ok(
    labeled.includes(
      `${SESSION_DIRECTORY}:/var/lib/kanthord/state/kanthord/pi/sessions:Z`,
    ),
  );
});

test("the run command takes the auto option only on rootless Podman, with no keep-id and no size", () => {
  const base = {
    image: IMAGE,
    instanceName: INSTANCE_NAME,
    owner: OWNER,
    environment: {},
    cacheVolume: null,
    ...SLOT_STATE,
  };
  const rootless = runArguments({
    ...base,
    rootless:
      idMapOf(ContainerRuntime.Podman, LINUX_FACTS, true) === IdMap.Auto,
  });
  assert.deepEqual(userNamespaceOf(rootless), [AUTO_OPTION]);
  assert.ok(!rootless.join(" ").includes("keep-id"));
  assert.ok(!userNamespaceOf(rootless).join(" ").includes("size="));
  assert.equal(rootless[rootless.indexOf("--user") + 1], SLOT_USER);
  assert.equal(idMapOf(ContainerRuntime.Docker, LINUX_FACTS, true), IdMap.None);
  assert.deepEqual(userNamespaceOf(runArguments(base)), []);
});

test("idMapOf picks the auto option for a labeled volume and a full map for an earlier volume", () => {
  assert.equal(idMapOf(ContainerRuntime.Podman, LINUX_FACTS, true), IdMap.Auto);
  assert.equal(
    idMapOf(ContainerRuntime.Podman, LINUX_FACTS, false),
    IdMap.Unshare,
  );
  assert.equal(
    idMapOf(ContainerRuntime.Podman, { ...LINUX_FACTS, remote: true }, false),
    IdMap.KeepId,
  );
  assert.equal(
    idMapOf(ContainerRuntime.Podman, MACOS_FACTS, false),
    IdMap.KeepId,
  );
  assert.equal(
    idMapOf(
      ContainerRuntime.Podman,
      { ...LINUX_FACTS, rootless: false },
      false,
    ),
    IdMap.None,
  );
});

test("migrationArguments on rootless Podman on macOS takes keep-id with no size for a volume without the label", () => {
  const args = migrationOf(ContainerRuntime.Podman, MACOS_FACTS, false);
  assert.deepEqual(userNamespaceOf(args), [KEEP_ID_OPTION]);
  assert.ok(!args.join(" ").includes("size="));
});

test("migrationArguments on rootless Podman on macOS takes the auto option for a labeled volume", () => {
  const args = migrationOf(ContainerRuntime.Podman, MACOS_FACTS, true);
  assert.deepEqual(userNamespaceOf(args), [AUTO_OPTION]);
  assert.ok(!args.join(" ").includes("keep-id"));
  assert.equal(args.at(-1), FILE_SHARE_SCRIPT);
});

test("migrationArguments on rootless Podman on Linux takes the auto option and the host directory variant for a labeled volume", () => {
  const args = migrationOf(ContainerRuntime.Podman, LINUX_FACTS, true);
  assert.deepEqual(userNamespaceOf(args), [AUTO_OPTION]);
  assert.equal(args.at(-1), HOST_DIRECTORY_SCRIPT);
});

test("migrationArguments holds the documented argv of the host directory variant", () => {
  const rootful = { ...LINUX_FACTS, rootless: false };
  assert.deepEqual(migrationOf(ContainerRuntime.Podman, rootful, true), [
    "run",
    "--rm",
    "--pull=never",
    "--network=none",
    "--name",
    `kanthord_migrate_${INSTANCE_NAME}`,
    "--label",
    `io.kanthord.owner=${OWNER}`,
    "--user",
    "0:0",
    "--cap-drop=ALL",
    "--cap-add=CHOWN",
    "--cap-add=DAC_OVERRIDE",
    "--cap-add=FOWNER",
    "--security-opt=no-new-privileges",
    "--volume",
    `kanthord_slot_${INSTANCE_NAME}:/var/lib/kanthord`,
    "--volume",
    `${MIGRATE_DIRECTORY}:/migrate`,
    "--entrypoint",
    "/bin/sh",
    IMAGE,
    "-c",
    HOST_DIRECTORY_SCRIPT,
  ]);
  assert.deepEqual(
    userNamespaceOf(migrationOf(ContainerRuntime.Docker, rootful, false)),
    [],
  );
});

test("migrationArguments on macOS runs the file share variant also on rootless Podman, and Docker Desktop on Linux too", () => {
  for (const [runtime, facts] of [
    [ContainerRuntime.Podman, MACOS_FACTS],
    [ContainerRuntime.Podman, { ...MACOS_FACTS, rootless: false }],
    [
      ContainerRuntime.Docker,
      { ...LINUX_FACTS, rootless: false, dockerDesktop: true },
    ],
  ] as const) {
    const args = migrationOf(runtime, facts, true);
    assert.equal(args.at(-1), FILE_SHARE_SCRIPT);
    assert.ok(!args.at(-1)!.includes("/var/lib/kanthord /migrate"));
  }
});

test("migrationArguments mounts /migrate with :Z only on an SELinux host", () => {
  const plain = migrationOf(ContainerRuntime.Podman, LINUX_FACTS, true);
  assert.ok(plain.includes(`${MIGRATE_DIRECTORY}:/migrate`));
  const labeled = migrationOf(
    ContainerRuntime.Podman,
    { ...LINUX_FACTS, selinux: true },
    true,
  );
  assert.ok(labeled.includes(`${MIGRATE_DIRECTORY}:/migrate:Z`));
});

test("unshareMigrationArguments passes both paths as arguments, not in the script", () => {
  const mountPoint =
    "/home/kanthord/.local/share/containers/storage/volumes/kanthord_slot_coder-1/_data";
  assert.deepEqual(unshareMigrationArguments(mountPoint, MIGRATE_DIRECTORY), [
    "unshare",
    "/bin/sh",
    "-c",
    UNSHARE_SCRIPT,
    "sh",
    mountPoint,
    MIGRATE_DIRECTORY,
  ]);
  assert.ok(!UNSHARE_SCRIPT.includes(mountPoint));
  assert.ok(!UNSHARE_SCRIPT.includes(MIGRATE_DIRECTORY));
});

test("unshareOwnerArguments changes the owner of the mount point to the server user", () => {
  assert.deepEqual(unshareOwnerArguments("/volumes/cache/_data"), [
    "unshare",
    "chown",
    "-R",
    "0:0",
    "/volumes/cache/_data",
  ]);
});

test("cacheOwnerArguments runs the owner step once for a volume without the marker", () => {
  for (const [idMap, option] of [
    [IdMap.Auto, AUTO_OPTION],
    [IdMap.KeepId, KEEP_ID_OPTION],
  ] as const) {
    const args = cacheOwnerArguments({
      image: IMAGE,
      owner: OWNER,
      volume: "kanthord_cache_abc",
      idMap,
    });
    assert.deepEqual(userNamespaceOf(args), [option]);
    assert.ok(args.includes("--pull=never"));
    assert.ok(args.includes(`kanthord_cache_abc:${CACHE_MOUNT}`));
    assert.equal(
      args.at(-1),
      `[ -e ${CACHE_MOUNT}/.kanthord_owner ] || { chown -R 10001:10001 ${CACHE_MOUNT} && touch ${CACHE_MOUNT}/.kanthord_owner && chown 10001:10001 ${CACHE_MOUNT}/.kanthord_owner; }`,
    );
  }
});

test("parseVolume answers the creation time, the id map label and the mount point", () => {
  assert.deepEqual(
    parseVolume(
      JSON.stringify([
        {
          CreatedAt: "2026-11-04T00:00:00Z",
          Mountpoint: "/volumes/a/_data",
          Labels: { "io.kanthord.id_map": "auto" },
        },
      ]),
    ),
    {
      createdAt: "2026-11-04T00:00:00Z",
      labeled: true,
      mountPoint: "/volumes/a/_data",
    },
  );
  assert.equal(
    parseVolume(
      JSON.stringify([
        { CreatedAt: "2026-11-04T00:00:00Z", Mountpoint: "/m", Labels: null },
      ]),
    ).labeled,
    false,
  );
  assert.throws(() => parseVolume("[]"));
});

test("detectRuntime answers the facts of an available runtime and no facts otherwise", async () => {
  const podman = fakeHost({
    answers: {
      podman: answer(
        podmanInfo(true, ROOTLESS_MAP, "6.0.2", {
          selinuxEnabled: true,
          serviceIsRemote: true,
        }),
      ),
    },
  });
  assert.deepEqual(await detectRuntime(podman.host), {
    status: expected(null, ContainerRuntime.Podman),
    facts: {
      rootless: true,
      selinux: true,
      platform: "linux",
      dockerDesktop: false,
      remote: true,
    },
  });
  const desktop = fakeHost({
    platform: "darwin",
    answers: {
      docker: answer(
        dockerInfo({
          OperatingSystem: "Docker Desktop",
          SecurityOptions: ["name=seccomp,profile=builtin", "name=selinux"],
        }),
      ),
    },
  });
  assert.deepEqual(await detectRuntime(desktop.host), {
    status: expected(null, ContainerRuntime.Docker),
    facts: {
      rootless: false,
      selinux: true,
      platform: "darwin",
      dockerDesktop: true,
      remote: false,
    },
  });
  const rootful = fakeHost({
    answers: { podman: answer(podmanInfo(false, [])) },
  });
  assert.equal((await detectRuntime(rootful.host)).facts, null);
});

test("a rootless Podman below the minimum version answers runtime_failed with the version detail", async () => {
  const { host } = fakeHost({
    answers: { podman: answer(podmanInfo(true, ROOTLESS_MAP, "5.4.2")) },
  });
  assert.deepEqual(await detectRuntime(host), {
    status: expected(
      PlacementIssue.RuntimeFailed,
      ContainerRuntime.Podman,
      "podman 5.4.2 is below the required version 6.0.0. Upgrade Podman to 6.0.0 or later.",
    ),
    facts: null,
  });
});

test("a rootful Podman below the minimum version with server uid 0 answers runtime_failed with the version detail", async () => {
  const { host } = fakeHost({
    uid: ROOT_UID,
    answers: { podman: answer(podmanInfo(false, [], "5.4.2")) },
  });
  assert.deepEqual(
    (await detectRuntime(host)).status,
    expected(
      PlacementIssue.RuntimeFailed,
      ContainerRuntime.Podman,
      "podman 5.4.2 is below the required version 6.0.0. Upgrade Podman to 6.0.0 or later.",
    ),
  );
});

test("a Podman with no version answers runtime_failed with the unknown version detail", async () => {
  const info: Record<string, unknown> = podmanInfo(true, ROOTLESS_MAP);
  delete info["version"];
  const { host } = fakeHost({ answers: { podman: answer(info) } });
  assert.deepEqual(
    (await detectRuntime(host)).status,
    expected(
      PlacementIssue.RuntimeFailed,
      ContainerRuntime.Podman,
      "podman unknown is below the required version 6.0.0. Upgrade Podman to 6.0.0 or later.",
    ),
  );
});

test("a Podman at or above the minimum version answers available", async () => {
  for (const version of [PODMAN_MIN_VERSION, "6.1.3"]) {
    const { host } = fakeHost({
      answers: { podman: answer(podmanInfo(true, ROOTLESS_MAP, version)) },
    });
    assert.deepEqual(
      (await detectRuntime(host)).status,
      expected(null, ContainerRuntime.Podman),
    );
  }
});

test("versionBelow compares the Podman minimum version", () => {
  assert.equal(versionBelow("5.4.2", PODMAN_MIN_VERSION), true);
  assert.equal(versionBelow(PODMAN_MIN_VERSION, PODMAN_MIN_VERSION), false);
  assert.equal(versionBelow("6.1.3", PODMAN_MIN_VERSION), false);
  assert.equal(versionBelow("6.0.0-dev", PODMAN_MIN_VERSION), true);
  assert.equal(versionBelow("6.0.0-rc1", PODMAN_MIN_VERSION), true);
  assert.equal(versionBelow("6.1.0-dev", PODMAN_MIN_VERSION), false);
  assert.equal(versionBelow("unknown", PODMAN_MIN_VERSION), true);
});

const IMAGE_HEX = "a".repeat(64);
const OTHER_HEX = "b".repeat(64);

test("systemUsageArguments reads the Docker verbose usage as JSON, the Podman verbose usage as a table, and the image reads hold the owner label", () => {
  assert.deepEqual(systemUsageArguments(ContainerRuntime.Docker), [
    "system",
    "df",
    "--verbose",
    "--format",
    "json",
  ]);
  assert.deepEqual(systemUsageArguments(ContainerRuntime.Podman), [
    "system",
    "df",
    "--verbose",
  ]);
  assert.deepEqual(imageListArguments(), [
    "image",
    "ls",
    "--all",
    "--format",
    "json",
  ]);
  assert.deepEqual(removeImageArguments("localhost/x:1"), [
    "image",
    "rm",
    "localhost/x:1",
  ]);
  assert.deepEqual(ownedImageArguments(OWNER), [
    "image",
    "ls",
    "--all",
    "--no-trunc",
    "--filter",
    `label=io.kanthord.owner=${OWNER}`,
    "--format",
    "{{.ID}}",
  ]);
});

test("parseSystemUsage reads the Docker verbose answer: one image for each id, its references, unique size and containers", () => {
  const stdout = JSON.stringify({
    Images: [
      {
        ID: `sha256:${IMAGE_HEX}`,
        Repository: "localhost/kanthord-dev-node",
        Tag: "1.0.0",
        CreatedAt: "2026-10-01 10:00:00 +0000 UTC",
        UniqueSize: "1.5GB",
        Containers: "2",
      },
      {
        ID: `sha256:${IMAGE_HEX}`,
        Repository: "localhost/kanthord-dev-node",
        Tag: "latest",
        CreatedAt: "2026-10-01 10:00:00 +0000 UTC",
        UniqueSize: "1.5GB",
        Containers: "2",
      },
      {
        ID: OTHER_HEX,
        Repository: "<none>",
        Tag: "<none>",
        CreatedAt: "2026-09-01 10:00:00 +0000 UTC",
        UniqueSize: "12.5MB",
        Containers: "0",
      },
    ],
    Volumes: [{ Name: "kanthord_cache_x", Size: "2kB", Links: 1 }],
  });
  assert.deepEqual(parseSystemUsage(ContainerRuntime.Docker, stdout), {
    runtime: ContainerRuntime.Docker,
    images: [
      {
        id: `sha256:${IMAGE_HEX}`,
        references: [
          "localhost/kanthord-dev-node:1.0.0",
          "localhost/kanthord-dev-node:latest",
        ],
        created_at: Date.parse("2026-10-01T10:00:00Z"),
        unique_bytes: 1500000000,
        containers: 2,
      },
      {
        id: `sha256:${OTHER_HEX}`,
        references: [],
        created_at: Date.parse("2026-09-01T10:00:00Z"),
        unique_bytes: 12500000,
        containers: 0,
      },
    ],
    volumes: [{ name: "kanthord_cache_x", bytes: 2000, links: 1 }],
  });
});

function podmanFixture(name: string): string {
  return readFileSync(
    join(import.meta.dirname, "__fixtures__", "podman-6", name),
    "utf8",
  );
}

const PODMAN_SYSTEM_DF = podmanFixture("system-df-verbose.txt");
const PODMAN_IMAGE_LIST = podmanFixture("image-ls-all.json");
const REFUSED_CODE = 1;
const BASE_PATH_ID =
  "sha256:59099780447be540a85daa4ad5248be3b941c28b750f054e16cdd5c978683b74";
const PODMAN_IMAGES: [string, string[], number, number, number][] = [
  [
    "59099780447be540a85daa4ad5248be3b941c28b750f054e16cdd5c978683b74",
    [
      "localhost/kanthord-base-path:28.0.1",
      "localhost/kanthord-base-path:latest",
    ],
    1791888738,
    4638,
    1,
  ],
  [
    "3f314435c3f2013e6e42e499361501684dba6bcc8610a6989bec7e7d9976919a",
    [],
    1791430470,
    4020,
    0,
  ],
  [
    "0d48ad089aab9942ecc66590e6cf00165c8e6f8d1dd7c1b3acfefd9051a15ca6",
    [],
    1791429131,
    191800000,
    0,
  ],
  [
    "320994c3b997e2ec6433f717f153e108023c5bec8fefa8d76b83451d16d05ea8",
    ["docker.io/library/alpine:latest"],
    1789677440,
    8716000,
    0,
  ],
  [
    "8a210a6fcfc4300faac566229c246999492fb9e563afbdc3359b5dea2e360f9b",
    ["docker.io/library/node:24.15.0-trixie-slim"],
    1779233321,
    233000000,
    0,
  ],
  [
    "4851d2b598cb9f0b875a88628c90b12c129b2286dbcd004193f140e353a7785f",
    ["public.ecr.aws/supabase/postgres:17.6.1.037"],
    1762173727,
    3021000000,
    0,
  ],
  [
    "1b44b5a3e06a9aae883e7bf25e45c100be0bb81a0e01b32de604f3ac44711634",
    ["docker.io/library/hello-world:latest"],
    1754679917,
    26730,
    0,
  ],
  [
    "f0494e814793db7c889d85e35d12cf5613a4e080a8cbe82d6f6ece79c9f2b4a6",
    ["public.ecr.aws/supabase/vector:0.28.1-alpine"],
    1678113227,
    125700000,
    0,
  ],
];
const PODMAN_USAGE = {
  runtime: ContainerRuntime.Podman,
  images: PODMAN_IMAGES.map(
    ([hex, references, created, unique_bytes, containers]) => ({
      id: `sha256:${hex}`,
      references,
      created_at: created * 1000,
      unique_bytes,
      containers,
    }),
  ),
  volumes: [
    { name: "buildx_buildkit_default_state", bytes: 2726000000, links: 0 },
    {
      name: "e01704bbbdb4cc480bc4eec0f5beacf3c0e58f41261641bb9cfbfe013d1570ca",
      bytes: 0,
      links: 0,
    },
    { name: "kanthord-homelab", bytes: 567200, links: 1 },
    {
      name: "b5f9eb7ae933df1ec4d2c583ba846c02444ba0f1d4dfbe082e156d7d88d0a4ce",
      bytes: 4553,
      links: 0,
    },
    { name: "kanthord_slot_coder-c1", bytes: 0, links: 0 },
  ],
};

test("parsePodmanUsage reads the Podman 6.1.3 verbose table and takes the id, references, creation time and containers from the image list", () => {
  assert.deepEqual(
    parsePodmanUsage(PODMAN_SYSTEM_DF, PODMAN_IMAGE_LIST),
    PODMAN_USAGE,
  );
});

test("parsePodmanUsage skips an image that only one of the two reads holds", () => {
  const listed = JSON.parse(PODMAN_IMAGE_LIST) as { Id: string }[];
  const kept = listed.filter((image) => `sha256:${image.Id}` !== BASE_PATH_ID);
  const added = { ...listed[0], Id: "c".repeat(64), Containers: 0 };
  const usage = parsePodmanUsage(
    PODMAN_SYSTEM_DF,
    JSON.stringify([...kept, added]),
  );
  assert.deepEqual(
    usage.images.map((image) => image.id),
    PODMAN_USAGE.images
      .map((image) => image.id)
      .filter((id) => id !== BASE_PATH_ID),
  );
});

test("parsePodmanUsage refuses an unknown table line or image entry and answers no number", () => {
  const variants = [
    PODMAN_SYSTEM_DF.replace("4.02kB", "4,02kB"),
    PODMAN_SYSTEM_DF.replace("2.726GB", "2.726EB"),
    PODMAN_SYSTEM_DF.replace("2.726GB", "2.726GiB"),
    PODMAN_SYSTEM_DF.replace("26.73kB      0", "26.73kB"),
    PODMAN_SYSTEM_DF.replace("1b44b5a3e06a", "1b44b5a3e06"),
    PODMAN_SYSTEM_DF.replace("VOLUME NAME", "VOLUME"),
    PODMAN_SYSTEM_DF.replace("Local Volumes space usage:", "Volumes:"),
    `Total reclaimable: 1GB\n${PODMAN_SYSTEM_DF}`,
    `${PODMAN_SYSTEM_DF}kanthord_slot_coder-c2  0  0B  extra\n`,
  ];
  for (const table of variants)
    assert.throws(() => parsePodmanUsage(table, PODMAN_IMAGE_LIST));
  assert.throws(() => parsePodmanUsage(PODMAN_SYSTEM_DF, "{}"));
  assert.throws(() =>
    parsePodmanUsage(PODMAN_SYSTEM_DF, JSON.stringify([{ Id: "x" }])),
  );
});

test("parsePodmanUsage reads a volume named like a table header as a volume", () => {
  const usage = parsePodmanUsage(
    `${PODMAN_SYSTEM_DF}REPOSITORY  2  1.5kB\n`,
    PODMAN_IMAGE_LIST,
  );
  assert.deepEqual(usage.volumes.at(-1), {
    name: "REPOSITORY",
    bytes: 1500,
    links: 2,
  });
  assert.deepEqual(usage.images, PODMAN_USAGE.images);
});

test("readSystemUsage runs the table and the image list on Podman and one JSON read on Docker", async () => {
  const calls: string[][] = [];
  const answers: Record<string, string> = {
    system: PODMAN_SYSTEM_DF,
    image: PODMAN_IMAGE_LIST,
  };
  const call = (args: readonly string[]) => {
    calls.push([...args]);
    return Promise.resolve({
      code: SUCCESS_CODE,
      stdout: answers[args[0] ?? ""] ?? "",
      stderr: "",
    });
  };
  const failure = (stderr: string) => new Error(stderr);
  assert.deepEqual(
    await readSystemUsage(ContainerRuntime.Podman, call, failure),
    PODMAN_USAGE,
  );
  assert.deepEqual(calls, [
    systemUsageArguments(ContainerRuntime.Podman),
    imageListArguments(),
  ]);
  calls.length = 0;
  answers.system = JSON.stringify({ Images: [], Volumes: [] });
  assert.deepEqual(
    await readSystemUsage(ContainerRuntime.Docker, call, failure),
    {
      runtime: ContainerRuntime.Docker,
      images: [],
      volumes: [],
    },
  );
  assert.deepEqual(calls, [systemUsageArguments(ContainerRuntime.Docker)]);
  await assert.rejects(
    readSystemUsage(
      ContainerRuntime.Podman,
      (args) =>
        Promise.resolve({
          code:
            args[0] === imageListArguments()[0] ? REFUSED_CODE : SUCCESS_CODE,
          stdout: PODMAN_SYSTEM_DF,
          stderr: "image list refused",
        }),
      failure,
    ),
    /image list refused/,
  );
});

test("bytesOf, timeOf and the image id helpers read the runtime value forms", () => {
  const noBytes = 0;
  const kiloBytes = 1200;
  const mebiBytes = 2097152;
  const plainBytes = 77;
  assert.equal(bytesOf("0B"), noBytes);
  assert.equal(bytesOf("1.2kB"), kiloBytes);
  assert.equal(bytesOf("2MiB"), mebiBytes);
  assert.equal(bytesOf(plainBytes), plainBytes);
  assert.equal(bytesOf("n/a"), noBytes);
  assert.equal(timeOf(null), null);
  assert.equal(
    timeOf("2026-11-01T00:00:00Z"),
    Date.parse("2026-11-01T00:00:00Z"),
  );
  assert.equal(imageIdOf(IMAGE_HEX), `sha256:${IMAGE_HEX}`);
  assert.ok(sameImage(IMAGE_HEX.slice(0, 12), `sha256:${IMAGE_HEX}`));
  assert.ok(!sameImage(OTHER_HEX, `sha256:${IMAGE_HEX}`));
  assert.ok(
    absentImage({ code: 1, stdout: "", stderr: "Error: image not known" }),
  );
  assert.ok(!absentImage({ code: 1, stdout: "", stderr: "permission denied" }));
});

test("parseRuntimeStore reads the Podman graph root sizes and the Docker root directory and system", () => {
  assert.deepEqual(
    parseRuntimeStore(
      ContainerRuntime.Podman,
      JSON.stringify({
        host: {},
        store: {
          graphRoot: "/var/lib/containers/storage",
          graphRootAllocated: 1000,
          graphRootUsed: 400,
        },
      }),
    ),
    {
      runtime: ContainerRuntime.Podman,
      graph_root: "/var/lib/containers/storage",
      graph_root_allocated: 1000,
      graph_root_used: 400,
      docker_root_dir: null,
      operating_system: null,
    },
  );
  assert.deepEqual(
    parseRuntimeStore(
      ContainerRuntime.Docker,
      JSON.stringify({
        DockerRootDir: "/var/lib/docker",
        OperatingSystem: "Docker Desktop",
      }),
    ),
    {
      runtime: ContainerRuntime.Docker,
      graph_root: null,
      graph_root_allocated: null,
      graph_root_used: null,
      docker_root_dir: "/var/lib/docker",
      operating_system: "Docker Desktop",
    },
  );
  assert.throws(() => parseRuntimeStore(ContainerRuntime.Docker, "[]"));
});
