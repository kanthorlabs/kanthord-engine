import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { KANTHORD_VERSION } from "../src/domain/version.ts";
import {
  openApiFeatures,
  renderOpenApiYaml,
} from "../src/http/contract/openapi.ts";
import { registry } from "../src/http/contract/registry.ts";

export type PublishInput = Readonly<{
  outputDirectory: string;
  commit: string;
  dirty: boolean;
}>;

const exampleKeyOrder = ["query", "request", "success", "error"] as const;

function resolveExisting(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

export function publishContract(input: PublishInput): readonly string[] {
  const outputDirectory = resolveExisting(input.outputDirectory);
  const repositoryRoot = resolveExisting(
    fileURLToPath(new URL("../", import.meta.url)),
  );
  if (
    outputDirectory === repositoryRoot ||
    repositoryRoot.startsWith(`${outputDirectory}/`)
  ) {
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
  rmSync(join(outputDirectory, "openapi.yaml"), { force: true });
  rmSync(join(outputDirectory, "manifest.json"), { force: true });

  mkdirSync(outputDirectory, { recursive: true });
  mkdirSync(join(outputDirectory, "examples"), { recursive: true });
  mkdirSync(join(outputDirectory, "features"), { recursive: true });

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

  const manifest = {
    version: KANTHORD_VERSION,
    commit: input.commit,
    dirty: input.dirty,
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
  const outputDirectory = process.argv[2];
  if (outputDirectory === undefined || outputDirectory.length === 0) {
    process.stderr.write(
      "usage: node scripts/publish-contract.ts <output-directory>\n",
    );
    process.exit(2);
  }

  try {
    const commit = execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
    const dirty =
      execFileSync("git", ["status", "--porcelain"], {
        encoding: "utf8",
      }).trim().length > 0;

    publishContract({ outputDirectory, commit, dirty });
  } catch (error) {
    if (error instanceof PublishRefusal) {
      process.stderr.write(`${error.message}\n`);
      process.exit(2);
    }
    throw error;
  }
}
