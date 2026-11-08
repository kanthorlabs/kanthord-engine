import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const SCRIPT = fileURLToPath(new URL("./pi-tools.mjs", import.meta.url));
const ENGINE_MODULES = fileURLToPath(
  new URL("../node_modules", import.meta.url),
);
const WORKSPACE_FILE = fileURLToPath(
  new URL("../pnpm-workspace.yaml", import.meta.url),
);
const RUN_TIMEOUT_MS = 30000;
const TARGET = `${process.platform}-${process.arch}`;
const TOOL = "faketool";
const LICENSE_NAME = "LICENSE-MIT";
const BINARY_BYTES = Buffer.from("fake tool bytes");
const LICENSE_BYTES = Buffer.from("fake license text");
const BINARY_MODE = 0o755;
const MODE_MASK = 0o777;
const SUCCESS = 0;
const FAILED = 1;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function manifest() {
  return {
    tools: {
      [TOOL]: {
        version: "1.0.0",
        repository: "example/faketool",
        targets: {
          [TARGET]: {
            url: "http://127.0.0.1:9/absent.tar.gz",
            archive_sha256: sha256("archive"),
            binary_path: `archive/${TOOL}`,
            binary_sha256: sha256(BINARY_BYTES),
            license_paths: [`archive/${LICENSE_NAME}`],
          },
        },
      },
    },
  };
}

function writeFileIn(path, bytes) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
}

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "kanthord-pi-tools-test-"));
  const engine = join(root, "engine");
  mkdirSync(join(engine, "scripts"), { recursive: true });
  copyFileSync(SCRIPT, join(engine, "scripts", "pi-tools.mjs"));
  copyFileSync(WORKSPACE_FILE, join(engine, "pnpm-workspace.yaml"));
  writeFileIn(
    join(engine, "static", "pi-tools.json"),
    JSON.stringify(manifest()),
  );
  symlinkSync(ENGINE_MODULES, join(engine, "node_modules"));
  const home = join(root, "home");
  mkdirSync(home);
  return { root, engine, home, absoluteCache: join(root, "cache") };
}

function writeCache(cacheRoot, binaryBytes) {
  const target = join(cacheRoot, "kanthord", "pi-tools", TARGET);
  writeFileIn(join(target, "bin", TOOL), binaryBytes);
  writeFileIn(join(target, "licenses", TOOL, LICENSE_NAME), LICENSE_BYTES);
}

function runFetch(fixture, cacheHome) {
  return spawnSync(
    process.execPath,
    [join(fixture.engine, "scripts", "pi-tools.mjs"), "fetch"],
    {
      cwd: fixture.engine,
      encoding: "utf8",
      timeout: RUN_TIMEOUT_MS,
      env: {
        PATH: process.env.PATH,
        HOME: fixture.home,
        XDG_CACHE_HOME: cacheHome,
      },
    },
  );
}

function withFixture(body) {
  return () => {
    const fixture = createFixture();
    try {
      body(fixture);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  };
}

test(
  "a host cache hit publishes the cached tool without a download",
  withFixture((fixture) => {
    writeCache(fixture.absoluteCache, BINARY_BYTES);
    const result = runFetch(fixture, fixture.absoluteCache);
    assert.equal(result.status, SUCCESS, result.stderr);
    assert.match(result.stdout, new RegExp(`${TOOL}: cached`));
    const binary = join(fixture.engine, ".pi-tools", TARGET, "bin", TOOL);
    assert.deepEqual(readFileSync(binary), BINARY_BYTES);
    assert.equal(statSync(binary).mode & MODE_MASK, BINARY_MODE);
    const license = join(
      fixture.engine,
      ".pi-tools",
      TARGET,
      "licenses",
      TOOL,
      LICENSE_NAME,
    );
    assert.deepEqual(readFileSync(license), LICENSE_BYTES);
  }),
);

test(
  "a cached binary that does not match the manifest digest is not copied",
  withFixture((fixture) => {
    writeCache(fixture.absoluteCache, Buffer.from("tampered bytes"));
    const result = runFetch(fixture, fixture.absoluteCache);
    assert.equal(result.status, FAILED);
    assert.match(result.stderr, /download failed/);
    assert.equal(existsSync(join(fixture.engine, ".pi-tools")), false);
  }),
);

test(
  "an empty host cache falls back to the download",
  withFixture((fixture) => {
    mkdirSync(fixture.absoluteCache);
    const result = runFetch(fixture, fixture.absoluteCache);
    assert.equal(result.status, FAILED);
    assert.match(result.stderr, /download failed/);
    assert.equal(existsSync(join(fixture.engine, ".pi-tools")), false);
  }),
);

test(
  "a relative XDG_CACHE_HOME reads the cache under HOME",
  withFixture((fixture) => {
    writeCache(join(fixture.home, ".cache"), BINARY_BYTES);
    const result = runFetch(fixture, "relative-cache");
    assert.equal(result.status, SUCCESS, result.stderr);
    assert.match(result.stdout, new RegExp(`${TOOL}: cached`));
    const binary = join(fixture.engine, ".pi-tools", TARGET, "bin", TOOL);
    assert.deepEqual(readFileSync(binary), BINARY_BYTES);
  }),
);
