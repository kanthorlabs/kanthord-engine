import assert from "node:assert/strict";
import { test } from "node:test";
import { ContainerRuntime } from "../../worker/contract.ts";
import type { RuntimeAnswer, RuntimeHost } from "./container-runtime.ts";
import {
  ENVIRONMENT_PROBE_TIMEOUT_MS,
  EnvironmentProbe,
  PROBE_OUTPUT_BYTES,
} from "./environment-probe.ts";

const OWNER = "OWNER";
const MEMORY_MB = 512;
const TAG = "localhost/kanthord-env/acme:abc";
const BASE_TAG = `${TAG}-base`;
const CHECKOUT = "/tmp/checkout with space";
const SUCCESS = 0;
const ABSENT = 1;
const TIMEOUT_CODE = 1;
const OS_RELEASE = ["cat", "/etc/os-release"];
const NAME_PATTERN = /^kanthord-probe-[0-9A-Z]{26}$/;
const IMAGE_COMMAND = "image";
const RUN_COMMAND = "run";
const REMOVE_COMMAND = "rm";
const ONE_CONTAINER = 1;
const NO_CONTAINER = 0;
const FAILED_CODE = 3;
const SHORT_OUTPUT = "abcd";

interface Call {
  runtime: ContainerRuntime;
  args: readonly string[];
  timeoutMs: number;
}

function fake(
  present: readonly string[],
  container: Partial<RuntimeAnswer> = {},
): { host: RuntimeHost; calls: Call[] } {
  const calls: Call[] = [];
  const host: RuntimeHost = {
    platform: "linux",
    uid: 1000,
    user: "tester",
    environment: {},
    exists: () => false,
    resolves: () => true,
    run: (runtime, args, timeoutMs) => {
      calls.push({ runtime, args, timeoutMs });
      if (args[0] === IMAGE_COMMAND)
        return Promise.resolve({
          code: present.includes(args[2]!) ? SUCCESS : ABSENT,
          stdout: "",
          stderr: "",
        });
      if (args[0] === RUN_COMMAND)
        return Promise.resolve({
          code: container.code ?? SUCCESS,
          stdout: container.stdout ?? "",
          stderr: container.stderr ?? "",
        });
      return Promise.resolve({ code: SUCCESS, stdout: "", stderr: "" });
    },
  };
  return { host, calls };
}

function probe(host: RuntimeHost): EnvironmentProbe {
  return new EnvironmentProbe(host, ContainerRuntime.Podman, OWNER, MEMORY_MB);
}

function request(argv: string[], tags: string[]) {
  return {
    tags,
    checkout: CHECKOUT,
    command: { argv },
    signal: new AbortController().signal,
  };
}

function containers(calls: Call[]): Call[] {
  return calls.filter((call) => call.args[0] === RUN_COMMAND);
}

test("a probe runs one container with the isolation arguments on the first existing tag", async () => {
  const { host, calls } = fake([TAG, BASE_TAG], { stdout: "out" });
  const answer = await probe(host).run(request(OS_RELEASE, [TAG, BASE_TAG]));
  const [started] = containers(calls);
  assert.equal(containers(calls).length, ONE_CONTAINER);
  const name = started!.args[3]!;
  assert.match(name, NAME_PATTERN);
  assert.deepEqual(started!.args, [
    "run",
    "--rm",
    "--name",
    name,
    "--network=none",
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--pids-limit",
    "256",
    "--user",
    "10001:10001",
    "--tmpfs",
    "/tmp",
    "--label",
    `io.kanthord.owner=${OWNER}`,
    "--memory",
    `${MEMORY_MB}m`,
    "--volume",
    `${CHECKOUT}:/workspace:ro`,
    "--workdir",
    "/workspace",
    "--entrypoint",
    "cat",
    TAG,
    "/etc/os-release",
  ]);
  assert.equal(started!.runtime, ContainerRuntime.Podman);
  assert.deepEqual(answer, { image: TAG, exit_code: SUCCESS, output: "out" });
});

test("a probe falls back to the base tag when the first tag is absent", async () => {
  const { host, calls } = fake([BASE_TAG]);
  const answer = await probe(host).run(request(OS_RELEASE, [TAG, BASE_TAG]));
  const [started] = containers(calls);
  assert.equal(answer.image, BASE_TAG);
  assert.equal(started!.args.at(-2), BASE_TAG);
});

test("a probe starts no container when no tag exists", async () => {
  const { host, calls } = fake([]);
  const answer = await probe(host).run(request(OS_RELEASE, [TAG, BASE_TAG]));
  assert.deepEqual(answer, { image: null, exit_code: null, output: "" });
  assert.equal(containers(calls).length, NO_CONTAINER);
});

test("the output is the standard output then the standard error cut to the last bytes", async () => {
  const stdout = "a".repeat(PROBE_OUTPUT_BYTES);
  const stderr = "é".repeat(10);
  const { host } = fake([TAG], { code: FAILED_CODE, stdout, stderr });
  const answer = await probe(host).run(request(OS_RELEASE, [TAG]));
  assert.equal(answer.exit_code, FAILED_CODE);
  assert.ok(Buffer.byteLength(answer.output) <= PROBE_OUTPUT_BYTES);
  assert.ok(answer.output.endsWith(stderr));
  const exact = fake([TAG], { stdout: "ab", stderr: "cd" });
  const short = await probe(exact.host).run(request(OS_RELEASE, [TAG]));
  assert.equal(short.output, SHORT_OUTPUT);
});

test("a probe that exceeds the timeout answers the runtime exit code and removes the container", async () => {
  const { host, calls } = fake([TAG], { code: TIMEOUT_CODE });
  const answer = await probe(host).run(request(OS_RELEASE, [TAG]));
  const [started] = containers(calls);
  const removal = calls.find((call) => call.args[0] === REMOVE_COMMAND);
  assert.equal(started!.timeoutMs, ENVIRONMENT_PROBE_TIMEOUT_MS);
  assert.equal(answer.exit_code, TIMEOUT_CODE);
  assert.deepEqual(removal!.args, ["rm", "--force", started!.args[3]]);
});

test("an argument reaches the runtime as one array item", async () => {
  const hostile = "a b; $(touch x) 'q'";
  const { host, calls } = fake([TAG]);
  await probe(host).run(request(["sh", "-c", hostile], [TAG]));
  const [started] = containers(calls);
  assert.deepEqual(started!.args.slice(-3), [TAG, "-c", hostile]);
  assert.ok(started!.args.includes(`${CHECKOUT}:/workspace:ro`));
});
