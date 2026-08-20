export type ReleaseFacts = Readonly<{
  commit: string;
  dirty: boolean;
  tags: readonly string[];
}>;

export type ReleaseRefusal = "dirty-tree" | "untagged-commit";

export type ReleaseVerdict =
  | Readonly<{ ok: true; tag: string | null }>
  | Readonly<{ ok: false; reason: ReleaseRefusal }>;

export type CliArguments =
  | Readonly<{ kind: "usage" }>
  | Readonly<{
      kind: "arguments";
      outputDirectory: string;
      unreleased: boolean;
    }>;

export type CliDecision =
  | Readonly<{ kind: "usage" }>
  | Readonly<{ kind: "refuse"; reason: ReleaseRefusal }>
  | Readonly<{
      kind: "publish";
      outputDirectory: string;
      tag: string | null;
      notice: string | null;
    }>;

export function releaseVerdict(
  facts: ReleaseFacts,
  version: string,
  unreleased: boolean,
): ReleaseVerdict {
  if (facts.dirty) {
    return { ok: false, reason: "dirty-tree" };
  }

  if (unreleased) {
    return { ok: true, tag: null };
  }

  const tag = `v${version}`;
  if (facts.tags.includes(tag)) {
    return { ok: true, tag };
  }

  return { ok: false, reason: "untagged-commit" };
}

export function parseArguments(argv: readonly string[]): CliArguments {
  const unreleased = argv.includes("--unreleased");
  if (
    argv.some(
      (argument) => argument.startsWith("--") && argument !== "--unreleased",
    )
  ) {
    return { kind: "usage" };
  }

  const outputArguments = argv.filter(
    (argument) => argument !== "--unreleased",
  );
  const [outputDirectory, secondOutputDirectory] = outputArguments;
  if (
    outputDirectory === undefined ||
    outputDirectory.length === 0 ||
    secondOutputDirectory !== undefined
  ) {
    return { kind: "usage" };
  }

  return { kind: "arguments", outputDirectory, unreleased };
}

export function cliDecision(
  argv: readonly string[],
  facts: ReleaseFacts,
  version: string,
): CliDecision {
  const parsed = parseArguments(argv);
  if (parsed.kind === "usage") {
    return { kind: "usage" };
  }

  const { outputDirectory, unreleased } = parsed;
  const verdict = releaseVerdict(facts, version, unreleased);
  if (!verdict.ok) {
    return { kind: "refuse", reason: verdict.reason };
  }

  return {
    kind: "publish",
    outputDirectory,
    tag: verdict.tag,
    notice: verdict.tag === null ? "publishing an unreleased artifact" : null,
  };
}
