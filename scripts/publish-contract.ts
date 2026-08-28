import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { KANTHORD_VERSION } from "../src/domain/version.ts";
import {
  openApiFeatures,
  renderOpenApiYaml,
} from "../src/http/contract/openapi.ts";
import { buildOpenApiSourceTree } from "../src/http/contract/openapi-source.ts";
import { registry } from "../src/http/contract/registry.ts";
import { readReleaseFacts } from "./release-facts.ts";
import { cliDecision, parseArguments } from "./release-gate.ts";

export type PublishInput = Readonly<{
  outputDirectory: string;
  commit: string;
  tag: string | null;
}>;

const exampleKeyOrder = ["query", "request", "success", "error"] as const;

function resolveExisting(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function containsOrEquals(parent: string, child: string): boolean {
  const distance = relative(parent, child);
  return (
    distance === "" ||
    (distance !== ".." &&
      !distance.startsWith(`..${sep}`) &&
      !isAbsolute(distance))
  );
}

export function refusesSelfPublish(resolvedOutputDirectory: string): boolean {
  const repositoryRoot = resolveExisting(
    fileURLToPath(new URL("../", import.meta.url)),
  );
  return (
    containsOrEquals(repositoryRoot, resolvedOutputDirectory) ||
    containsOrEquals(resolvedOutputDirectory, repositoryRoot)
  );
}

export function publishContract(input: PublishInput): readonly string[] {
  const outputDirectory = resolveExisting(input.outputDirectory);
  if (refusesSelfPublish(outputDirectory)) {
    throw new PublishRefusal(
      `refusing to publish into the repository: ${outputDirectory}`,
    );
  }

  rmSync(join(outputDirectory, "examples"), {
    recursive: true,
    force: true,
  });
  rmSync(join(outputDirectory, "features"), {
    recursive: true,
    force: true,
  });
  rmSync(join(outputDirectory, "source"), {
    recursive: true,
    force: true,
  });
  rmSync(join(outputDirectory, "openapi.yaml"), { force: true });
  rmSync(join(outputDirectory, "manifest.json"), { force: true });

  mkdirSync(outputDirectory, { recursive: true });
  mkdirSync(join(outputDirectory, "examples"), { recursive: true });
  mkdirSync(join(outputDirectory, "features"), { recursive: true });
  mkdirSync(join(outputDirectory, "source", "components"), {
    recursive: true,
  });
  mkdirSync(join(outputDirectory, "source", "features"), { recursive: true });

  const written: string[] = [];
  const features = openApiFeatures();

  writeFileSync(join(outputDirectory, "openapi.yaml"), renderOpenApiYaml(), {
    encoding: "utf8",
  });
  written.push("openapi.yaml");

  for (const feature of features) {
    const relative = join("features", `${feature.name}.yaml`);
    writeFileSync(
      join(outputDirectory, relative),
      renderOpenApiYaml(feature.operations),
      { encoding: "utf8" },
    );
    written.push(relative);
  }

  const publishedEntries = registry.filter(
    (entry) => entry.examples !== undefined,
  );

  for (const entry of publishedEntries) {
    const examples = entry.examples;
    if (examples === undefined) continue;
    const ordered: Record<string, unknown> = {};
    for (const key of exampleKeyOrder) {
      if (key in examples) {
        ordered[key] = examples[key];
      }
    }
    const relative = join("examples", `${entry.operationId}.json`);
    writeFileSync(
      join(outputDirectory, relative),
      `${JSON.stringify(ordered, null, 2)}\n`,
      { encoding: "utf8" },
    );
    written.push(relative);
  }

  for (const [relative, text] of buildOpenApiSourceTree()) {
    const target = join("source", relative);
    writeFileSync(join(outputDirectory, target), text, { encoding: "utf8" });
    written.push(target);
  }

  const manifest = {
    version: KANTHORD_VERSION,
    commit: input.commit,
    tag: input.tag,
    source: "source/openapi.yaml",
    features: features.map((feature) => feature.name),
    operations: publishedEntries.map((entry) => entry.operationId),
  };
  writeFileSync(
    join(outputDirectory, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { encoding: "utf8" },
  );
  written.push("manifest.json");

  return written.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
}

class PublishRefusal extends Error {}

if (import.meta.filename === process.argv[1]) {
  const usage =
    "usage: node scripts/publish-contract.ts [--unreleased] <output-directory>\n";
  const parsed = parseArguments(process.argv.slice(2));
  if (parsed.kind === "usage") {
    process.stderr.write(usage);
    process.exit(2);
  }

  const resolvedOutputDirectory = resolveExisting(parsed.outputDirectory);
  if (refusesSelfPublish(resolvedOutputDirectory)) {
    process.stderr.write(
      `refusing to publish into the repository: ${resolvedOutputDirectory}\n`,
    );
    process.exit(2);
  }

  const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
  const facts = readReleaseFacts(repositoryRoot);
  const decision = cliDecision(process.argv.slice(2), facts, KANTHORD_VERSION);

  try {
    switch (decision.kind) {
      case "usage":
        process.stderr.write(usage);
        process.exit(2);
        break;
      case "refuse":
        process.stderr.write(`${decision.reason}\n`);
        process.exit(2);
        break;
      case "publish":
        if (decision.notice !== null) {
          process.stderr.write(`${decision.notice}\n`);
        }
        publishContract({
          outputDirectory: decision.outputDirectory,
          commit: facts.commit,
          tag: decision.tag,
        });
        break;
    }
  } catch (error) {
    if (error instanceof PublishRefusal) {
      process.stderr.write(`${error.message}\n`);
      process.exit(2);
    }
    throw error;
  }
}
