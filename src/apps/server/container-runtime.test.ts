import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import {
  ContainerRuntime,
  PlacementIssue,
  PoolPlacement,
  type PlacementStatus,
} from "../../worker/contract.ts";
import {
  boundedDetail,
  cacheVolumeArguments,
  cacheVolumeName,
  containerOwner,
  containerRemovalFailure,
  detectRuntime,
  infoArguments,
  inspectVolumeArguments,
  killArguments,
  ownedArguments,
  ownedCacheVolumeArguments,
  parseCacheVolumes,
  removeArguments,
  runArguments,
  slotClientId,
  SUCCESS_CODE,
  volumeArguments,
  type RuntimeAnswer,
  type RuntimeHost,
} from "./container-runtime.ts";

const CLIENT_ID = "client_identity_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const OWNER = "0123456789ABCDEFGHJKMNPQRS";
const IMAGE = "localhost/kanthord-dev:28.0.1";
const NAME_OF_SLOT = `kanthord_slot_${CLIENT_ID}`;
const SECRET = "slot_client_secret_value";
const SERVER_USER = "kanthord";
const SERVER_UID = 1000;
const ROOT_UID = 0;
const DETAIL_LIMIT_BYTES = 200;
const ENV_OPTION = "--env";
const FIRST_LINE = "first line";
const SUCCESS = 0;
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
  `kanthord_slot_${CLIENT_ID}`,
  "--label",
  `io.kanthord.owner=${OWNER}`,
  "--label",
  `io.kanthord.client_id=${CLIENT_ID}`,
  "--user",
  "10001",
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
  `kanthord_slot_${CLIENT_ID}:/var/lib/kanthord`,
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
) {
  return {
    host: {
      os: "linux",
      security: { rootless },
      idMappings: { uidmap, gidmap: uidmap },
    },
    version: { Version: "5.4.2" },
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
      clientId: CLIENT_ID,
      owner: OWNER,
      environment: HOST_ENVIRONMENT,
      cacheVolume: null,
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
    clientId: CLIENT_ID,
    owner: OWNER,
    environment: { TZ: "UTC" },
    cacheVolume: null,
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
  assert.deepEqual(removeArguments(`kanthord_slot_${CLIENT_ID}`), [
    "rm",
    "--force",
    `kanthord_slot_${CLIENT_ID}`,
  ]);
  assert.deepEqual(killArguments(`kanthord_slot_${CLIENT_ID}`), [
    "kill",
    "--signal",
    "KILL",
    `kanthord_slot_${CLIENT_ID}`,
  ]);
  assert.deepEqual(volumeArguments(CLIENT_ID, OWNER), [
    "volume",
    "create",
    "--label",
    `io.kanthord.owner=${OWNER}`,
    "--label",
    `io.kanthord.client_id=${CLIENT_ID}`,
    `kanthord_slot_${CLIENT_ID}`,
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
      await detectRuntime(host),
      expected(PlacementIssue.ServerInContainer, null),
    );
    assert.deepEqual(calls, []);
  }
});

test("a host with no runtime on the PATH answers runtime_absent", async () => {
  const { host } = fakeHost({});
  assert.deepEqual(
    await detectRuntime(host),
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
    await detectRuntime(host),
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
    await detectRuntime(host),
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
    await detectRuntime(exact.host),
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
    await detectRuntime(short.host),
    expected(
      PlacementIssue.RuntimeFailed,
      ContainerRuntime.Podman,
      `the subordinate uid range of ${SERVER_USER} does not cover the container uid 10001`,
    ),
  );
});

test("rootful Podman on Linux answers runtime_rootful for a non-root server", async () => {
  const { host } = fakeHost({
    answers: { podman: answer(podmanInfo(false, [])) },
  });
  assert.deepEqual(
    await detectRuntime(host),
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
      await detectRuntime(host),
      expected(null, ContainerRuntime.Docker),
    );
  }
});

test("rootless Docker answers available", async () => {
  const { host } = fakeHost({
    answers: {
      docker: answer(
        dockerInfo({
          SecurityOptions: ["name=seccomp,profile=builtin", "name=rootless"],
        }),
      ),
    },
  });
  assert.deepEqual(
    await detectRuntime(host),
    expected(null, ContainerRuntime.Docker),
  );
});

test("rootful Docker on Linux answers runtime_rootful only for a non-root server", async () => {
  const rootful = fakeHost({ answers: { docker: answer(dockerInfo()) } });
  assert.deepEqual(
    await detectRuntime(rootful.host),
    expected(PlacementIssue.RuntimeRootful, ContainerRuntime.Docker),
  );
  const root = fakeHost({
    uid: ROOT_UID,
    answers: { docker: answer(dockerInfo()) },
  });
  assert.deepEqual(
    await detectRuntime(root.host),
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
    await detectRuntime(host),
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
    await detectRuntime(host),
    expected(
      PlacementIssue.RuntimeFailed,
      null,
      "docker client 20.10.24 is below 23",
    ),
  );
});

test("the podman-docker shim counts as a failed Docker answer", async () => {
  const shim = fakeHost({
    answers: { docker: answer(podmanInfo(true, ROOTLESS_MAP)) },
  });
  assert.deepEqual(
    await detectRuntime(shim.host),
    expected(
      PlacementIssue.RuntimeFailed,
      null,
      "docker answers no server version",
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
    await detectRuntime(stopped.host),
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
    await detectRuntime(fallback.host),
    expected(null, ContainerRuntime.Docker),
  );
  const silent = fakeHost({
    answers: { podman: answer(null, FAILURE) },
  });
  assert.deepEqual(
    await detectRuntime(silent.host),
    expected(PlacementIssue.RuntimeFailed, null, "podman info exits 1"),
  );
});

const PROJECT_ID = "project_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const RESOURCE = "repository:github:acme/app";
const CACHE_NAME = /^kanthord_cache_[0-9a-f]{24}$/;
const VOLUME_OPTION = "--volume";
const SLOT_VOLUMES = 1;
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
    clientId: CLIENT_ID,
    owner: OWNER,
    environment: {},
  };
  const mounted = runArguments({ ...base, cacheVolume: "kanthord_cache_abc" });
  const volumes = mounted.flatMap((arg, index) =>
    mounted[index - 1] === VOLUME_OPTION ? [arg] : [],
  );
  assert.deepEqual(volumes, [
    `kanthord_slot_${CLIENT_ID}:/var/lib/kanthord`,
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
    cacheVolumeName(OWNER, PROJECT_ID, RESOURCE),
  ]);
});

test("slotClientId answers null for a cache volume name", () => {
  assert.equal(
    slotClientId(cacheVolumeName(OWNER, PROJECT_ID, RESOURCE)),
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

test("parseCacheVolumes answers the name and the two labels of each inspected volume and skips a volume without both labels", () => {
  const output = JSON.stringify([
    {
      Name: "kanthord_cache_aaa",
      Labels: {
        "io.kanthord.owner": OWNER,
        "io.kanthord.cache_project": PROJECT_ID,
        "io.kanthord.cache_resource": RESOURCE,
      },
    },
    {
      Name: `kanthord_slot_${CLIENT_ID}`,
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
    ["container", "inspect", "--format", "{{.Id}}", NAME_OF_SLOT],
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
