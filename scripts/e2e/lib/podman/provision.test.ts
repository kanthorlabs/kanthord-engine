import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

import { provisionImages } from "./provision.ts";
import { baseImageReference } from "./preflight.ts";
import { RunnerError } from "../errors.ts";
import type { CommandRecord } from "../command.ts";
import type { PodmanExecutor } from "../driver/podman.ts";

const runId = "R1";

function record(argv: readonly string[], stdout: string): CommandRecord {
  return { argv, cwd: process.cwd(), exitCode: 0, stdout, stderr: "" };
}

function failure(argv: readonly string[], stderr: string): CommandRecord {
  return { argv, cwd: process.cwd(), exitCode: 1, stdout: "", stderr };
}

function tarHeader(name: string, size: number): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, "utf8");
  header.write("0000644\0", 100, "ascii");
  header.write("0000000\0", 108, "ascii");
  header.write("0000000\0", 116, "ascii");
  header.write(`${size.toString(8).padStart(11, "0")}\0`, 124, "ascii");
  header.write("00000000000\0", 136, "ascii");
  header.write("        ", 148, "ascii");
  header.write("0", 156, "ascii");
  header.write("ustar\0", 257, "ascii");
  header.write("00", 263, "ascii");

  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");

  return header;
}

function tarEntry(name: string, content: Buffer): Buffer {
  const header = tarHeader(name, content.length);
  const paddingLength = (512 - (content.length % 512)) % 512;
  return Buffer.concat([header, content, Buffer.alloc(paddingLength)]);
}

function buildFixtureTarball(): Buffer {
  const packageJson = Buffer.from(
    `${JSON.stringify({ name: "kanthord", version: "27.8.1" })}\n`,
    "utf8",
  );
  const mainTs = Buffer.from("export {};\n", "utf8");
  const tar = Buffer.concat([
    tarEntry("package/package.json", packageJson),
    tarEntry("package/src/main.ts", mainTs),
    Buffer.alloc(1024),
  ]);
  return gzipSync(tar);
}

const packedTarball = buildFixtureTarball();
const expectedProductDigest = `sha256:${createHash("sha256").update(packedTarball).digest("hex")}`;

function fakePodman(
  options: Readonly<{ missingBaseImage?: boolean }>,
): PodmanExecutor & { calls: (readonly string[])[] } {
  const calls: (readonly string[])[] = [];

  const executor = async (argv: readonly string[]): Promise<CommandRecord> => {
    calls.push(argv);

    if (argv[0] !== "podman") {
      throw new Error(`unexpected non-podman argv: ${argv.join(" ")}`);
    }

    if (argv.includes("inspect")) {
      const formatIndex = argv.indexOf("--format");
      const format = argv[formatIndex + 1];
      const ref = argv[argv.length - 1];

      if (ref === baseImageReference) {
        if (options.missingBaseImage === true) {
          return failure(argv, "no such image");
        }
        return record(
          argv,
          "sha256:base00000000000000000000000000000000000000000000000000000000\n",
        );
      }

      if (ref === `kanthord-e2e-product:${runId}`) {
        if (format === "{{.Id}}") {
          return record(
            argv,
            "sha256:product00000000000000000000000000000000000000000000000000\n",
          );
        }
        if (format === "{{.Architecture}}") {
          return record(argv, "arm64\n");
        }
      }

      if (ref === `kanthord-e2e-fixture:${runId}`) {
        if (format === "{{.Id}}") {
          return record(
            argv,
            "sha256:fixture00000000000000000000000000000000000000000000000000\n",
          );
        }
      }

      throw new Error(`unexpected inspect argv: ${argv.join(" ")}`);
    }

    if (argv.includes("build")) {
      return record(argv, "");
    }

    throw new Error(`unexpected podman argv: ${argv.join(" ")}`);
  };

  return Object.assign(executor, { calls });
}

function fakePnpm(): PodmanExecutor & { calls: (readonly string[])[] } {
  const calls: (readonly string[])[] = [];

  const executor = async (argv: readonly string[]): Promise<CommandRecord> => {
    calls.push(argv);

    if (argv[0] !== "pnpm") {
      throw new Error(`unexpected non-pnpm argv: ${argv.join(" ")}`);
    }

    if (argv[1] === "pack") {
      const destinationIndex = argv.indexOf("--pack-destination");
      const destination = argv[destinationIndex + 1];
      if (destination === undefined) {
        throw new Error("pnpm pack missing --pack-destination");
      }
      mkdirSync(destination, { recursive: true });
      const filename = "kanthord-27.8.1.tgz";
      const tarballPath = join(destination, filename);
      writeFileSync(tarballPath, packedTarball);
      // pnpm reports the absolute path, where npm reported a bare filename.
      return record(argv, `${tarballPath}\n`);
    }

    if (argv[1] === "install") {
      return record(argv, "");
    }

    throw new Error(`unexpected pnpm argv: ${argv.join(" ")}`);
  };

  return Object.assign(executor, { calls });
}

const scratchPrefix = "kanthord-e2e-provision-";

function scratchEntries(): readonly string[] {
  return readdirSync(tmpdir()).filter((name) => name.startsWith(scratchPrefix));
}

test("baseImageReference matches the digest-qualified node:24-bookworm pin", () => {
  assert.match(
    baseImageReference,
    /^docker\.io\/library\/node:24-bookworm@sha256:[0-9a-f]{64}$/,
  );
});

test("a missing base image throws unavailable naming podman pull and the digest-qualified reference", async () => {
  const podman = fakePodman({ missingBaseImage: true });
  const pnpm = fakePnpm();

  await assert.rejects(
    provisionImages(podman, pnpm, runId),
    (error: unknown) => {
      assert.ok(error instanceof RunnerError);
      assert.equal(error.code, "unavailable");
      assert.ok(error.message.includes("podman pull"));
      assert.ok(error.message.includes(baseImageReference));
      return true;
    },
  );
});

test("provisionImages builds two images with --pull=never, --network none, their own --file, and the run label, resolves distinct inspected ids and digests, and routes pnpm only to the host executor", async () => {
  const podman = fakePodman({});
  const pnpm = fakePnpm();

  const result = await provisionImages(podman, pnpm, runId);

  const buildCalls = podman.calls.filter((argv) => argv.includes("build"));
  assert.equal(buildCalls.length, 2);
  for (const argv of buildCalls) {
    assert.ok(argv.includes("--pull=never"));
    assert.ok(argv.includes("--network"));
    assert.ok(argv.includes("none"));
    assert.ok(argv.includes(`--label`));
    assert.ok(argv.includes(`kanthord-e2e-run=${runId}`));
    assert.ok(argv.includes("--file"));
  }
  const productBuild = buildCalls.find((argv) =>
    argv.includes(`kanthord-e2e-product:${runId}`),
  );
  const fixtureBuild = buildCalls.find((argv) =>
    argv.includes(`kanthord-e2e-fixture:${runId}`),
  );
  assert.ok(productBuild !== undefined);
  assert.ok(fixtureBuild !== undefined);
  const productFile = productBuild?.[productBuild.indexOf("--file") + 1];
  const fixtureFile = fixtureBuild?.[fixtureBuild.indexOf("--file") + 1];
  assert.notEqual(productFile, fixtureFile);

  assert.equal(
    result.images.product,
    "sha256:product00000000000000000000000000000000000000000000000000",
  );
  assert.equal(
    result.images.fixture,
    "sha256:fixture00000000000000000000000000000000000000000000000000",
  );
  assert.notEqual(result.images.product, `kanthord-e2e-product:${runId}`);
  assert.notEqual(result.images.fixture, `kanthord-e2e-fixture:${runId}`);
  assert.notEqual(result.images.product, result.images.fixture);

  assert.equal(result.productDigest, expectedProductDigest);
  assert.equal(
    result.baseDigest,
    "sha256:base00000000000000000000000000000000000000000000000000000000",
  );
  assert.equal(result.architecture, "arm64");
  assert.notEqual(result.productDigest, result.baseDigest);

  assert.equal(
    podman.calls.some((argv) => argv.includes("pull")),
    false,
  );
  for (const argv of pnpm.calls) {
    assert.equal(argv[0], "pnpm");
  }
  for (const argv of podman.calls) {
    assert.notEqual(argv[0], "pnpm");
  }
});

test("provisionImages leaves no scratch directory behind once it resolves", async () => {
  const before = new Set(scratchEntries());
  const podman = fakePodman({});
  const pnpm = fakePnpm();

  await provisionImages(podman, pnpm, runId);

  const after = scratchEntries().filter((name) => !before.has(name));
  assert.deepEqual(after, []);
});

test("provisionImages leaves no scratch directory behind once it rejects", async () => {
  const before = new Set(scratchEntries());
  const podman = fakePodman({ missingBaseImage: true });
  const pnpm = fakePnpm();

  await assert.rejects(provisionImages(podman, pnpm, runId));

  const after = scratchEntries().filter((name) => !before.has(name));
  assert.deepEqual(after, []);
});
