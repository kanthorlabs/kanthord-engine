import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  PI_TOOLS_MANIFEST,
  shippedAsset,
  type BinaryAssetSource,
} from "../kernel/assets.ts";
import { temporary } from "../kernel/test-support.ts";
import {
  installPiTools,
  piToolsManifestSchema,
  type PiToolsManifest,
} from "./pi-tools.ts";

const TARGET = "test-target";
const TOOL = "fd";
const LICENSE = "LICENSE-MIT";
const LICENSE_TEXT = "license text";
const WORKING_BINARY = "#!/bin/sh\necho test_tool\n";
const FAILING_BINARY = "#!/bin/sh\nexit 1\n";
const EXECUTABLE_MODE = 0o755;
const MODE_MASK = 0o777;
const RELEASE_TARGETS = ["darwin-arm64", "linux-arm64", "linux-x64"];
const SHA256_HEX_LENGTH = 64;
const NO_ITEMS = 0;

function digest(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function manifestOf(binary: string): PiToolsManifest {
  return {
    tools: {
      [TOOL]: {
        version: "1.0.0",
        repository: "owner/fd",
        targets: {
          [TARGET]: {
            url: "https://example.com/fd.tar.gz",
            archive_sha256: digest("archive"),
            binary_path: "fd-1.0.0/fd",
            binary_sha256: digest(binary),
            license_paths: [`fd-1.0.0/${LICENSE}`],
          },
        },
      },
    },
  };
}

function developmentRoot(t: TestContext, binary: string): URL {
  const root = temporary(t);
  mkdirSync(join(root, TARGET, "bin"), { recursive: true });
  mkdirSync(join(root, TARGET, "licenses", TOOL), { recursive: true });
  writeFileSync(join(root, TARGET, "bin", TOOL), binary);
  writeFileSync(join(root, TARGET, "licenses", TOOL, LICENSE), LICENSE_TEXT);
  return pathToFileURL(`${root}/`);
}

function embeddedAssets(binary: string): BinaryAssetSource {
  const files = new Map<string, ArrayBuffer>([
    [`pi-tools/bin/${TOOL}`, new TextEncoder().encode(binary).buffer],
    [
      `pi-tools/licenses/${TOOL}/${LICENSE}`,
      new TextEncoder().encode(LICENSE_TEXT).buffer,
    ],
  ]);
  return {
    isSea: () => true,
    getAssetKeys: () => [...files.keys()],
    getAsset: (name) => files.get(name)!,
  };
}

function state(t: TestContext): { env: NodeJS.ProcessEnv; bin: string } {
  const directory = temporary(t);
  return {
    env: { XDG_STATE_HOME: directory },
    bin: join(directory, "kanthord", "pi", "bin"),
  };
}

test("installer writes the tool and its license from a development checkout", (t) => {
  const { env, bin } = state(t);
  installPiTools({
    env,
    target: TARGET,
    manifest: manifestOf(WORKING_BINARY),
    root: developmentRoot(t, WORKING_BINARY),
  });
  assert.equal(readFileSync(join(bin, TOOL), "utf8"), WORKING_BINARY);
  assert.equal(statSync(join(bin, TOOL)).mode & MODE_MASK, EXECUTABLE_MODE);
  assert.equal(
    readFileSync(join(bin, "licenses", TOOL, LICENSE), "utf8"),
    LICENSE_TEXT,
  );
  assert.deepEqual(readdirSync(bin).sort(), [TOOL, "licenses"]);
});

test("installer writes the tool and its license from the embedded assets of a single executable", (t) => {
  const { env, bin } = state(t);
  installPiTools({
    env,
    target: TARGET,
    manifest: manifestOf(WORKING_BINARY),
    assets: embeddedAssets(WORKING_BINARY),
    root: new URL("file:///absent/"),
  });
  assert.equal(readFileSync(join(bin, TOOL), "utf8"), WORKING_BINARY);
  assert.equal(statSync(join(bin, TOOL)).mode & MODE_MASK, EXECUTABLE_MODE);
  assert.equal(
    readFileSync(join(bin, "licenses", TOOL, LICENSE), "utf8"),
    LICENSE_TEXT,
  );
});

test("installer refuses a binary whose digest differs from the manifest", (t) => {
  const { env, bin } = state(t);
  assert.throws(
    () =>
      installPiTools({
        env,
        target: TARGET,
        manifest: manifestOf(WORKING_BINARY),
        root: developmentRoot(t, `${WORKING_BINARY}# changed\n`),
      }),
    {
      code: "worker.start.tool_missing",
      message: "binary digest differs from the manifest.",
      fields: [["tool", TOOL]],
    },
  );
  assert.throws(() => statSync(join(bin, TOOL)), { code: "ENOENT" });
});

test("installer skips a file that already has the digest and replaces a file that differs", (t) => {
  const { env, bin } = state(t);
  const options = {
    env,
    target: TARGET,
    manifest: manifestOf(WORKING_BINARY),
    root: developmentRoot(t, WORKING_BINARY),
  };
  installPiTools(options);
  const first = statSync(join(bin, TOOL));
  installPiTools(options);
  const second = statSync(join(bin, TOOL));
  assert.equal(second.ino, first.ino);
  assert.equal(second.mtimeMs, first.mtimeMs);
  writeFileSync(join(bin, TOOL), FAILING_BINARY);
  installPiTools(options);
  assert.equal(readFileSync(join(bin, TOOL), "utf8"), WORKING_BINARY);
  assert.deepEqual(readdirSync(bin).sort(), [TOOL, "licenses"]);
});

test("installer refuses a host target outside the manifest", (t) => {
  const { env, bin } = state(t);
  assert.throws(
    () =>
      installPiTools({
        env,
        target: "freebsd-x64",
        manifest: manifestOf(WORKING_BINARY),
        root: developmentRoot(t, WORKING_BINARY),
      }),
    {
      code: "worker.start.tool_missing",
      message: "host target is not in the manifest.",
      fields: [
        ["tool", TOOL],
        ["target", "freebsd-x64"],
      ],
    },
  );
  assert.throws(() => readdirSync(bin), { code: "ENOENT" });
});

test("installer refuses an absent binary source and an absent license source", (t) => {
  const { env } = state(t);
  const options = {
    env,
    target: TARGET,
    manifest: manifestOf(WORKING_BINARY),
  };
  assert.throws(
    () =>
      installPiTools({ ...options, root: pathToFileURL(`${temporary(t)}/`) }),
    {
      code: "worker.start.tool_missing",
      message: "binary source is absent.",
      fields: [["tool", TOOL]],
    },
  );
  const root = developmentRoot(t, WORKING_BINARY);
  const embedded = embeddedAssets(WORKING_BINARY);
  assert.throws(
    () =>
      installPiTools({
        ...options,
        assets: { ...embedded, getAssetKeys: () => [`pi-tools/bin/${TOOL}`] },
        root,
      }),
    {
      code: "worker.start.tool_missing",
      message: "license source is absent.",
    },
  );
});

test("installer refuses a tool whose version command fails", (t) => {
  const { env } = state(t);
  assert.throws(
    () =>
      installPiTools({
        env,
        target: TARGET,
        manifest: manifestOf(FAILING_BINARY),
        root: developmentRoot(t, FAILING_BINARY),
      }),
    { code: "worker.start.tool_missing", message: "cannot run." },
  );
});

test("installer refuses a pi directory that cannot hold the tools", (t) => {
  const { env, bin } = state(t);
  mkdirSync(join(bin, ".."), { recursive: true });
  writeFileSync(bin, "");
  assert.throws(
    () =>
      installPiTools({
        env,
        target: TARGET,
        manifest: manifestOf(WORKING_BINARY),
        root: developmentRoot(t, WORKING_BINARY),
      }),
    { code: "worker.start.tool_missing", message: "cannot install." },
  );
});

test("the shipped manifest pins each tool for each release target", () => {
  const manifest = piToolsManifestSchema.parse(
    JSON.parse(shippedAsset(PI_TOOLS_MANIFEST)),
  );
  assert.ok(Object.keys(manifest.tools).length > NO_ITEMS);
  for (const definition of Object.values(manifest.tools)) {
    assert.deepEqual(Object.keys(definition.targets).sort(), RELEASE_TARGETS);
    for (const entry of Object.values(definition.targets)) {
      assert.equal(entry.binary_sha256.length, SHA256_HEX_LENGTH);
      assert.ok(entry.license_paths.length > NO_ITEMS);
    }
  }
});

test("the manifest tools equal the tools that the pi tool manager declares", async () => {
  const source = readFileSync(
    fileURLToPath(
      new URL(
        "./utils/tools-manager.js",
        import.meta.resolve("@earendil-works/pi-coding-agent"),
      ),
    ),
    "utf8",
  );
  const declared = [
    ...source.matchAll(/^ {4}(\w+): \{[\s\S]*?binaryName: "([^"]+)"/gm),
  ];
  assert.ok(declared.length > NO_ITEMS);
  for (const [, key, binaryName] of declared) assert.equal(binaryName, key);
  const manifest = piToolsManifestSchema.parse(
    JSON.parse(shippedAsset(PI_TOOLS_MANIFEST)),
  );
  assert.deepEqual(
    declared.map(([, key]) => key).sort(),
    Object.keys(manifest.tools).sort(),
  );
});
