import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const ENGINE = new URL("../", import.meta.url);
const MANIFEST_FILE = new URL("static/pi-tools.json", ENGINE);
const WORKSPACE_FILE = new URL("pnpm-workspace.yaml", ENGINE);
const OUTPUT_DIRECTORY = new URL(".pi-tools/", ENGINE);
const MILLISECONDS_PER_MINUTE = 60000;
const BINARY_MODE = 0o755;
const LICENSE_MODE = 0o644;
const JSON_INDENT = 2;
const GITHUB_API = "https://api.github.com";
const USER_AGENT = "kanthord-pi-tools";
const LICENSE_NAME = /^(LICENSE|COPYING|UNLICENSE|NOTICE)([-.].*)?$/i;
const REPOSITORIES = { fd: "sharkdp/fd", rg: "BurntSushi/ripgrep" };
const TRIPLES = {
  "darwin-arm64": ["aarch64-apple-darwin"],
  "linux-x64": ["x86_64-unknown-linux-musl", "x86_64-unknown-linux-gnu"],
  "linux-arm64": ["aarch64-unknown-linux-musl", "aarch64-unknown-linux-gnu"],
};

class PiToolsError extends Error {}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function minimumReleaseAgeMinutes() {
  const value = parse(readFileSync(WORKSPACE_FILE, "utf8"))?.minimumReleaseAge;
  if (!Number.isInteger(value) || value <= 0)
    throw new PiToolsError(
      "pnpm-workspace.yaml: minimumReleaseAge is absent or not a positive integer",
    );
  return value;
}

function readManifest() {
  return JSON.parse(readFileSync(MANIFEST_FILE, "utf8"));
}

function writeManifest(manifest) {
  writeFileSync(
    MANIFEST_FILE,
    `${JSON.stringify(manifest, null, JSON_INDENT)}\n`,
  );
}

async function download(url, headers = {}) {
  const response = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, ...headers },
  });
  if (!response.ok)
    throw new PiToolsError(`${url}: download failed with ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

function tar(args) {
  const result = spawnSync("tar", args, { encoding: "utf8" });
  if (result.error || result.status !== 0)
    throw new PiToolsError(
      `tar ${args.join(" ")}: ${result.error?.message ?? result.stderr}`,
    );
  return result.stdout;
}

function withScratch(action) {
  const scratch = mkdtempSync(join(tmpdir(), "kanthord-pi-tools-"));
  try {
    return action(scratch);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function archiveEntries(archive) {
  return withScratch((scratch) => {
    const file = join(scratch, "archive.tar.gz");
    writeFileSync(file, archive);
    return tar(["-tzf", file])
      .split("\n")
      .map((entry) => entry.replace(/^\.\//, ""))
      .filter((entry) => entry && !entry.endsWith("/"));
  });
}

function extract(archive, paths) {
  return withScratch((scratch) => {
    const file = join(scratch, "archive.tar.gz");
    const output = join(scratch, "output");
    mkdirSync(output);
    writeFileSync(file, archive);
    tar(["-xzf", file, "-C", output, ...paths]);
    return paths.map((path) => readFileSync(join(output, path)));
  });
}

function publish(path, bytes, mode) {
  mkdirSync(join(path, ".."), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, bytes);
  chmodSync(temporary, mode);
  renameSync(temporary, path);
}

function hostTarget() {
  const target = `${process.platform}-${process.arch}`;
  if (!Object.hasOwn(TRIPLES, target))
    throw new PiToolsError(`${target}: not a pi tool target`);
  return target;
}

async function fetchTool(tool, entry, target) {
  const root = fileURLToPath(new URL(`${target}/`, OUTPUT_DIRECTORY));
  const binary = join(root, "bin", tool);
  const licenses = entry.license_paths.map((path) =>
    join(root, "licenses", tool, basename(path)),
  );
  if (
    existsSync(binary) &&
    sha256(readFileSync(binary)) === entry.binary_sha256 &&
    licenses.every((path) => existsSync(path))
  ) {
    console.log(`${tool}: present`);
    return;
  }
  const archive = await download(entry.url);
  if (sha256(archive) !== entry.archive_sha256)
    throw new PiToolsError(`${tool}: archive digest mismatch for ${entry.url}`);
  const [binaryBytes, ...licenseBytes] = extract(archive, [
    entry.binary_path,
    ...entry.license_paths,
  ]);
  if (sha256(binaryBytes) !== entry.binary_sha256)
    throw new PiToolsError(`${tool}: binary digest mismatch`);
  publish(binary, binaryBytes, BINARY_MODE);
  licenses.forEach((path, index) =>
    publish(path, licenseBytes[index], LICENSE_MODE),
  );
  console.log(`${tool}: fetched ${entry.url}`);
}

async function fetchAll() {
  const target = hostTarget();
  const manifest = readManifest();
  for (const [tool, definition] of Object.entries(manifest.tools)) {
    const entry = definition.targets[target];
    if (!entry)
      throw new PiToolsError(`${tool}: no manifest entry for ${target}`);
    await fetchTool(tool, entry, target);
  }
}

async function release(repository, version) {
  for (const tag of [`v${version}`, version]) {
    const response = await fetch(
      `${GITHUB_API}/repos/${repository}/releases/tags/${tag}`,
      {
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "application/vnd.github+json",
        },
      },
    );
    if (response.ok) return response.json();
  }
  throw new PiToolsError(`${repository}: no release for version ${version}`);
}

function refuseYoungRelease(repository, published) {
  const minimum = minimumReleaseAgeMinutes();
  const minutes =
    (Date.now() - Date.parse(published)) / MILLISECONDS_PER_MINUTE;
  if (!(minutes >= minimum))
    throw new PiToolsError(
      `${repository}: release published ${published} is younger than ${minimum} minutes`,
    );
}

function selectAsset(assets, triples, target) {
  for (const triple of triples) {
    const matches = assets.filter((asset) =>
      asset.name.endsWith(`-${triple}.tar.gz`),
    );
    if (matches.length > 1)
      throw new PiToolsError(`${target}: several assets match ${triple}`);
    if (matches.length === 1) return matches[0];
  }
  throw new PiToolsError(`${target}: no asset for ${triples.join(", ")}`);
}

function archivePaths(tool, archive, name) {
  const entries = archiveEntries(archive);
  const binaries = entries.filter((entry) => basename(entry) === tool);
  if (binaries.length !== 1)
    throw new PiToolsError(`${name}: expected one ${tool} binary`);
  const licenses = entries
    .filter((entry) => LICENSE_NAME.test(basename(entry)))
    .sort();
  if (licenses.length === 0) throw new PiToolsError(`${name}: no license file`);
  return { binary_path: binaries[0], license_paths: licenses };
}

async function updateTool(tool, version) {
  const manifest = readManifest();
  const repository = manifest.tools[tool]?.repository ?? REPOSITORIES[tool];
  if (!repository) throw new PiToolsError(`${tool}: unknown tool`);
  const data = await release(repository, version);
  refuseYoungRelease(repository, data.published_at);
  const targets = {};
  for (const [target, triples] of Object.entries(TRIPLES)) {
    const asset = selectAsset(data.assets, triples, target);
    const archive = await download(asset.browser_download_url);
    const paths = archivePaths(tool, archive, asset.name);
    const [binary] = extract(archive, [paths.binary_path]);
    targets[target] = {
      url: asset.browser_download_url,
      archive_sha256: sha256(archive),
      binary_path: paths.binary_path,
      binary_sha256: sha256(binary),
      license_paths: paths.license_paths,
    };
    console.log(`${tool} ${target}: ${asset.name}`);
  }
  manifest.tools[tool] = { version, repository, targets };
  writeManifest(manifest);
}

async function main(argv) {
  const [command, tool, version] = argv;
  if (command === "fetch" && argv.length === 1) return fetchAll();
  if (command === "update" && tool && version && argv.length === 3)
    return updateTool(tool, version);
  throw new PiToolsError("usage: pi-tools.mjs fetch | update <tool> <version>");
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  console.error(`pi-tools: ${error.message}`);
  process.exitCode = 1;
}
