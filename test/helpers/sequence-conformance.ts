import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

type ProjectionContext = Readonly<{
  method: string;
  sets: Readonly<Record<string, readonly string[]>>;
}>;

type Projection = (
  input: unknown,
  context: ProjectionContext,
) => readonly string[];

function field(
  input: unknown,
  key: string,
  context: ProjectionContext,
): string {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error(`${context.method} takes no input object to project`);
  }
  const value = (input as Readonly<Record<string, unknown>>)[key];
  if (value === undefined || value === null) {
    throw new Error(`${context.method} input holds no ${key}`);
  }
  return String(value);
}

function setName(input: unknown, context: ProjectionContext): string {
  if (!Array.isArray(input)) {
    throw new Error(`${context.method} takes no id list to project`);
  }
  const wanted = [...(input as readonly string[])].sort().join(" ");
  const names = Object.entries(context.sets)
    .filter(([, members]) => [...members].sort().join(" ") === wanted)
    .map(([name]) => name);
  if (names.length === 0) {
    throw new Error(
      `${context.method} names no declared set: ${JSON.stringify(input)}`,
    );
  }
  if (names.length > 1) {
    throw new Error(
      `${context.method} matches two declared sets: ${names.join(", ")}`,
    );
  }
  return names[0] ?? "";
}

const projections: Readonly<Record<string, Projection>> = {
  "plan.setNodeState": (input, context) => [
    field(input, "id", context),
    field(input, "trigger", context),
  ],
  "plan.setNodeAssignment": (input, context) => [field(input, "id", context)],
  "execution.openRun": (input, context) => [field(input, "nodeId", context)],
  "execution.runById": (input) => [String(input)],
  "execution.renewRun": (input, context) => [field(input, "runId", context)],
  "execution.endRun": (input, context) => [field(input, "runId", context)],
  "execution.openAttempt": (input, context) => [field(input, "runId", context)],
  "execution.attemptsOfRun": (input) => [String(input)],
  "execution.closeAttempt": (input, context) => [
    field(input, "attemptId", context),
  ],
  "execution.activeRunsOfNodes": (input, context) => [setName(input, context)],
  "lease.read": (input, context) => [field(input, "subjectId", context)],
  "lease.acquire": (input, context) => [field(input, "subjectId", context)],
  "lease.renew": (input, context) => [field(input, "subjectId", context)],
  "lease.release": (input, context) => [field(input, "subjectId", context)],
  "events.append": (input, context) => {
    const labels = [
      field(input, "type", context),
      field(input, "subjectId", context),
    ];
    const payload = (input as Readonly<Record<string, unknown>>).payload;
    if (
      typeof payload === "object" &&
      payload !== null &&
      "reason" in payload &&
      (payload as Readonly<Record<string, unknown>>).reason !== null
    ) {
      labels.push(
        String((payload as Readonly<Record<string, unknown>>).reason),
      );
    }
    return labels;
  },
};

type RecordedTokens = readonly string[] & {
  readonly dependencyKeys?: readonly string[];
};

type RecorderWithKeys = Readonly<{
  tokens: RecordedTokens;
}>;

export function recordSeams<T extends object>(
  dependencies: T,
  aliases: Readonly<Record<string, string>>,
  sets: Readonly<Record<string, readonly string[]>> = {},
): Readonly<{ dependencies: T; tokens: readonly string[] }> {
  const tokens: string[] = [];
  const dependencyKeys = Object.entries(dependencies)
    .filter(([, value]) => typeof value === "object" && value !== null)
    .map(([key]) => key);
  const recordedTokens = tokens as RecordedTokens;
  Object.defineProperty(recordedTokens, "dependencyKeys", {
    value: dependencyKeys,
    enumerable: false,
  });

  const wrapCapability = (key: string, capability: unknown): unknown => {
    if (typeof capability !== "object" || capability === null) {
      return capability;
    }
    return new Proxy(capability, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== "function") return value;
        return (...args: readonly unknown[]) => {
          const input = args.at(-1);
          const method = `${key}.${String(property)}`;
          const projection = projections[method];
          const labels =
            projection === undefined
              ? []
              : projection(input, { method, sets }).map(
                  (label) => aliases[label] ?? label,
                );
          const token = `${method}${labels.length > 0 ? `:${labels.join(":")}` : ""}`;
          tokens.push(token);
          return Reflect.apply(value, target, args);
        };
      },
    });
  };

  const recordedDependencies = new Proxy(dependencies, {
    get(target, property, receiver) {
      return wrapCapability(
        String(property),
        Reflect.get(target, property, receiver),
      );
    },
  });

  return { dependencies: recordedDependencies, tokens: recordedTokens };
}

function diagramBlock(story: string, diagram: string): string {
  const source = readFileSync(story, "utf8");
  const heading = `### \`${diagram}\``;
  const headingIndex = source.indexOf(heading);
  if (headingIndex < 0) throw new Error(`unknown diagram id: ${diagram}`);
  const blockStart = source.indexOf("```mermaid", headingIndex);
  const blockEnd = source.indexOf("```", blockStart + 10);
  if (blockStart < 0 || blockEnd < 0) {
    throw new Error(`diagram ${diagram} has no mermaid block`);
  }
  return source.slice(blockStart + "```mermaid".length, blockEnd);
}

type ParsedDiagram = Readonly<{
  tokens: readonly string[];
  terminal: string | null;
}>;

const sequenceEnds: ReadonlySet<string> = new Set([
  "Command",
  "Client",
  "Caller",
]);

function parseDiagram(
  source: string,
  diagram: string,
  dependencyKeys: readonly string[],
): ParsedDiagram {
  if (/\b(?:loop|opt)\b/.test(source)) {
    throw new Error(`diagram ${diagram} uses loop or opt`);
  }

  for (const key of dependencyKeys) {
    if (sequenceEnds.has(capitalize(key))) {
      throw new Error(
        `dependency key ${key} collides with the sequence end ${capitalize(key)}`,
      );
    }
  }

  const allowed = new Set([...sequenceEnds, ...dependencyKeys.map(capitalize)]);

  const tokens: string[] = [];
  let terminal: string | null = null;
  let sawNote = false;
  for (const line of source.split("\n")) {
    const participant = line.match(/^\s*participant\s+(\w+)\s*$/i);
    if (participant !== null) {
      const name = participant[1] ?? "";
      if (!allowed.has(name)) {
        throw new Error(
          `participant outside recorded dependency keys: ${name}`,
        );
      }
      continue;
    }

    const note = line.match(/^\s*Note over Command:\s*(.*)$/i);
    if (note !== null) {
      const text = note[1] ?? "";
      if (
        !/^tail pinned by EPIC \d+\.?\d* [a-z0-9-]+$/.test(text) &&
        !/^tail unchanged by EPIC \d+\.?\d*$/.test(text)
      ) {
        throw new Error(`invalid Command note in diagram ${diagram}`);
      }
      sawNote = true;
      continue;
    }

    const arrow = line.match(
      /^\s*(\w+)\s*(-{1,3}>{1,2})\s*(\w+)\s*:\s*(.*?)\s*$/,
    );
    if (arrow === null) {
      if (/^\s*\w+\s*[-.]+>/.test(line)) {
        throw new Error(`invalid message in diagram ${diagram}`);
      }
      continue;
    }
    const from = arrow[1] ?? "";
    const to = arrow[3] ?? "";
    const message = arrow[4] ?? "";
    if (!allowed.has(from) || !allowed.has(to)) {
      throw new Error(
        `participant outside recorded dependency keys: ${!allowed.has(from) ? from : to}`,
      );
    }

    const ordinalMatch = message.match(/^(\d+)\s+(.+)$/);
    if (ordinalMatch === null) {
      if (
        from === "Command" &&
        (to === "Client" || to === "Caller") &&
        /^(?:ok|refuse:[^\s]+)$/.test(message)
      ) {
        if (terminal !== null)
          throw new Error(`two terminals in diagram ${diagram}`);
        terminal = message;
        continue;
      }
      if ((from === "Client" || from === "Caller") && to === "Command")
        continue;
      throw new Error(`invalid message in diagram ${diagram}`);
    }

    const ordinal = Number(ordinalMatch[1]);
    const call = ordinalMatch[2] ?? "";
    const callMatch = call.match(
      /^([a-z][a-z0-9-]*)\.([a-z][a-zA-Z0-9]*)(?::(.+))?$/,
    );
    if (callMatch === null)
      throw new Error(`invalid message in diagram ${diagram}`);
    const key = callMatch[1] ?? "";
    const method = callMatch[2] ?? "";
    const label = callMatch[3];
    if (!dependencyKeys.includes(key)) {
      throw new Error(`participant outside recorded dependency keys: ${key}`);
    }
    if (label !== undefined && label.split(":").some((part) => part === "")) {
      throw new Error(`invalid message in diagram ${diagram}`);
    }
    if (
      !diagram.startsWith("baseline-") &&
      (method === "call" || label?.startsWith("#"))
    ) {
      throw new Error(`baseline-only discriminator in diagram ${diagram}`);
    }
    if (ordinal !== tokens.length + 1) {
      throw new Error(`non-dense ordinals in diagram ${diagram}`);
    }
    const token = `${key}.${method}${label === undefined ? "" : `:${label}`}`;
    if (tokens.includes(token))
      throw new Error(`duplicate token in diagram ${diagram}: ${token}`);
    tokens.push(token);
  }

  if (terminal === null && !sawNote) {
    throw new Error(`diagram ${diagram} has no terminal or note`);
  }
  if (terminal !== null && sawNote) {
    throw new Error(`diagram ${diagram} has two terminals`);
  }
  return { tokens, terminal };
}

function capitalize(value: string): string {
  return value.length === 0
    ? value
    : `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}`;
}

function resultTerminal(result: unknown): string {
  if (result instanceof Error) {
    const code = (result as Error & { refusal?: unknown }).refusal;
    return typeof code === "string" ? `refuse:${code}` : "refuse:error";
  }
  if (typeof result === "object" && result !== null) {
    const value = result as Readonly<Record<string, unknown>>;
    if (value.ok === false) {
      const code = value.code ?? value.refusal;
      return typeof code === "string" ? `refuse:${code}` : "refuse:error";
    }
  }
  return "ok";
}

export function assertConformance(
  input: Readonly<{
    story: string;
    diagram: string;
    recorder: Readonly<{ tokens: readonly string[] }>;
    result: unknown;
  }>,
): void {
  const recorder = input.recorder as RecorderWithKeys;
  const dependencyKeys = recorder.tokens.dependencyKeys ?? [
    ...new Set(
      input.recorder.tokens.map((token) => token.split(".", 1)[0] ?? ""),
    ),
  ];
  const parsed = parseDiagram(
    diagramBlock(input.story, input.diagram),
    input.diagram,
    dependencyKeys,
  );
  if (
    parsed.terminal !== null &&
    parsed.terminal !== resultTerminal(input.result)
  ) {
    throw new Error(
      `terminal mismatch: expected ${parsed.terminal}, got ${resultTerminal(input.result)}`,
    );
  }
  const recordedTokens =
    parsed.terminal === null
      ? input.recorder.tokens.slice(0, parsed.tokens.length)
      : input.recorder.tokens;
  assert.deepStrictEqual(
    recordedTokens,
    parsed.tokens,
    `sequence mismatch for diagram ${input.diagram}`,
  );
}
