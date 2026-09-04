import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { authoredEpics, shippedEpics } from "./epic-sequence-range.ts";

type EpicReference = Readonly<{
  epicId: string;
  diagramId: string;
}>;

type ParsedDiagram = Readonly<{
  id: string;
  baseline: boolean;
  story: string;
  tokens: readonly string[];
  source: string;
  supersedes: readonly EpicReference[];
  supersededBy: readonly EpicReference[];
  tailPins: readonly EpicReference[];
  unchangedTailEpics: readonly string[];
}>;

type Seam = Readonly<{
  sign: "+" | "-" | "~";
  token: string;
  citation: string | null;
}>;

type Story = Readonly<{
  epicId: string;
  path: string;
  stem: string;
  ordinal: number;
  source: string;
  kind: string;
  executor: string | null;
  paths: readonly string[];
  diagrams: readonly string[];
  baselines: ReadonlyMap<string, string>;
  seams: ReadonlyMap<string, readonly Seam[]>;
  diagramBlocks: readonly ParsedDiagram[];
  references: readonly EpicReference[];
}>;

type Epic = Readonly<{
  id: string;
  path: string;
  stem: string;
  epicSource: string;
  stories: readonly Story[];
}>;

type DiagramIndex = Readonly<{
  diagrams: readonly ParsedDiagram[];
  owners: ReadonlyMap<string, Story>;
  declaredOwners: ReadonlyMap<string, Story>;
}>;

function bytewise(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

function sortedEntries(root: string): readonly string[] {
  return readdirSync(root).sort(bytewise);
}

function capitalize(value: string): string {
  return value.length === 0
    ? value
    : `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}`;
}

function error(message: string): never {
  throw new Error(message);
}

function referencesIn(
  source: string,
  storyPath: string,
): readonly EpicReference[] {
  const references: EpicReference[] = [];
  for (const line of source.split(/\r?\n/)) {
    const candidate = line.match(
      /^\s*(?:Supersedes|Superseded by):\s+EPIC\s+(\S+)\s+(\S+)\s*$/,
    );
    if (candidate !== null) {
      references.push({
        epicId: candidate[1] ?? "",
        diagramId: candidate[2] ?? "",
      });
      continue;
    }
    if (/^\s*(?:Supersedes|Superseded by):/.test(line)) {
      error(`malformed supersession line in ${storyPath}`);
    }
  }
  return references;
}

function referencesInSection(source: string): Readonly<{
  supersedes: readonly EpicReference[];
  supersededBy: readonly EpicReference[];
}> {
  const supersedes: EpicReference[] = [];
  const supersededBy: EpicReference[] = [];
  for (const line of source.split(/\r?\n/)) {
    const supersedesMatch = line.match(
      /^\s*Supersedes:\s+EPIC\s+(\S+)\s+(\S+)\s*$/,
    );
    if (supersedesMatch !== null) {
      supersedes.push({
        epicId: supersedesMatch[1] ?? "",
        diagramId: supersedesMatch[2] ?? "",
      });
      continue;
    }
    const supersededByMatch = line.match(
      /^\s*Superseded by:\s+EPIC\s+(\S+)\s+(\S+)\s*$/,
    );
    if (supersededByMatch !== null) {
      supersededBy.push({
        epicId: supersededByMatch[1] ?? "",
        diagramId: supersededByMatch[2] ?? "",
      });
    }
  }
  return { supersedes, supersededBy };
}

function diagramSections(
  source: string,
  storyPath: string,
): readonly Readonly<{ id: string; source: string; block: string }>[] {
  const headings = [...source.matchAll(/^### `([^`]+)`\s*$/gm)].map(
    (match) => ({
      id: match[1] ?? "",
      start: match.index ?? 0,
    }),
  );
  const sections: Readonly<{ id: string; source: string; block: string }>[] =
    [];
  for (const [index, heading] of headings.entries()) {
    const nextStart = headings[index + 1]?.start ?? source.length;
    const section = source.slice(heading.start, nextStart);
    const blocks = [...section.matchAll(/```mermaid\s*\n?([\s\S]*?)```/g)];
    if (blocks.length !== 1) {
      error(`diagram ${heading.id} in ${storyPath} has no mermaid block`);
    }
    sections.push({
      id: heading.id,
      source: section,
      block: blocks[0]?.[1] ?? "",
    });
  }
  return sections;
}

function parseNote(
  line: string,
  diagramId: string,
): EpicReference | null | undefined {
  const note = line.match(/^\s*Note over Command:\s*(.*)$/i);
  if (note === null) return undefined;
  const text = note[1] ?? "";
  const pinned = text.match(
    /^tail pinned by EPIC (\d+(?:\.\d+)?) ([a-z0-9-]+)$/,
  );
  if (pinned !== null) {
    return {
      epicId: pinned[1] ?? "",
      diagramId: pinned[2] ?? "",
    };
  }
  if (/^tail unchanged by EPIC \d+(?:\.\d+)?$/i.test(text)) return null;
  error(`invalid Command note in diagram ${diagramId}`);
}

function parseDiagram(
  section: Readonly<{ id: string; source: string; block: string }>,
  storyPath: string,
): ParsedDiagram {
  const { id, source: sectionSource, block: source } = section;
  const baseline = id.startsWith("baseline-");
  if (/\b(?:loop|opt)\b/.test(source)) {
    error(`diagram ${id} in ${storyPath} uses loop or opt`);
  }

  const participants = new Set<string>();
  for (const line of source.split(/\r?\n/)) {
    const participant = line.match(/^\s*participant\s+(\w+)\s*$/i);
    if (participant !== null) participants.add(participant[1] ?? "");
  }

  const tokens: string[] = [];
  let terminal: string | null = null;
  let sawNote = false;
  const supersedes: EpicReference[] = [];
  const supersededBy: EpicReference[] = [];
  const tailPins: EpicReference[] = [];
  const unchangedTailEpics: string[] = [];

  for (const line of source.split(/\r?\n/)) {
    const unchangedTail = line.match(
      /^\s*Note over Command:\s*tail unchanged by EPIC (\d+(?:\.\d+)?)\s*$/i,
    );
    if (unchangedTail !== null) {
      unchangedTailEpics.push(unchangedTail[1] ?? "");
    }
    const note = parseNote(line, id);
    if (note !== undefined) {
      sawNote = true;
      if (note !== null) tailPins.push(note);
      continue;
    }

    const arrow = line.match(
      /^\s*(\w+)\s*(-{1,3}>{1,2})\s*(\w+)\s*:\s*(.*?)\s*$/,
    );
    if (arrow === null) {
      if (/^\s*\w+\s*[-.]+>/.test(line)) {
        error(`invalid message in diagram ${id}`);
      }
      continue;
    }

    const from = arrow[1] ?? "";
    const to = arrow[3] ?? "";
    const message = arrow[4] ?? "";
    if (!participants.has(from) || !participants.has(to)) {
      error(`participant outside recorded dependency keys in diagram ${id}`);
    }

    const ordinalMatch = message.match(/^(\d+)\s+(.+)$/);
    if (ordinalMatch === null) {
      const terminalMatch =
        from === "Command" &&
        (to === "Client" || to === "Caller") &&
        /^(?:ok|refuse:[^\s]+)$/.test(message);
      if (terminalMatch) {
        if (terminal !== null) error(`two terminals in diagram ${id}`);
        terminal = message;
        continue;
      }
      if ((from === "Client" || from === "Caller") && to === "Command") {
        continue;
      }
      error(`invalid message in diagram ${id}`);
    }

    const ordinal = Number(ordinalMatch[1]);
    const call = ordinalMatch[2] ?? "";
    const callMatch = call.match(
      /^([a-z][a-zA-Z0-9-]*)\.([a-z][a-zA-Z0-9]*)(?::(.+))?$/,
    );
    if (callMatch === null) error(`invalid message in diagram ${id}`);
    const key = callMatch[1] ?? "";
    const method = callMatch[2] ?? "";
    const label = callMatch[3];
    if (!participants.has(capitalize(key))) {
      error(`participant outside recorded dependency keys: ${key}`);
    }
    if (!baseline && (method === "call" || label?.startsWith("#"))) {
      error(`baseline-only discriminator in diagram ${id}`);
    }
    if (ordinal !== tokens.length + 1) {
      error(`non-dense ordinals in diagram ${id}`);
    }
    const token = `${key}.${method}${label === undefined ? "" : `:${label}`}`;
    if (tokens.includes(token))
      error(`duplicate token in diagram ${id}: ${token}`);
    tokens.push(token);
  }

  if (terminal === null && !sawNote) {
    error(`diagram ${id} has no terminal or note`);
  }
  if (terminal !== null && sawNote) {
    error(`diagram ${id} has two terminals`);
  }

  const sectionReferences = referencesInSection(sectionSource);
  supersedes.push(...sectionReferences.supersedes);
  supersededBy.push(...sectionReferences.supersededBy);
  return {
    id,
    baseline,
    story: storyPath,
    tokens,
    source,
    supersedes,
    supersededBy,
    tailPins,
    unchangedTailEpics,
  };
}

function parseSeams(
  source: string,
  storyPath: string,
): ReadonlyMap<string, readonly Seam[]> {
  const seams = new Map<string, Seam[]>();
  for (const line of source.split(/\r?\n/)) {
    const match = line.match(/^Seams:\s*(.*)$/);
    if (match === null) continue;
    const body = match[1]?.trim() ?? "";
    const separator = body.indexOf(":");
    if (separator <= 0) error(`Seams line names no diagram in ${storyPath}`);
    const diagramId = body.slice(0, separator);
    if (seams.has(diagramId)) {
      error(`two Seams lines name one diagram in ${storyPath}: ${diagramId}`);
    }
    const declarations = body.slice(separator + 1).split(",");
    const parsed: Seam[] = seams.get(diagramId) ?? [];
    for (const item of declarations) {
      const value = item.trim();
      if (value.length === 0) error(`empty seam token in ${storyPath}`);
      const token = value.match(
        /^([+~-])([a-z][a-zA-Z0-9-]*\.[a-z][a-zA-Z0-9]*(?::[^\s,@]+)*)(?:\s+@([^\s,]+))?$/,
      );
      if (token === null)
        error(`seam token carries no sign in ${storyPath}: ${value}`);
      const sign = token[1];
      if (sign !== "+" && sign !== "-" && sign !== "~") {
        error(`seam token carries no sign in ${storyPath}: ${value}`);
      }
      const declaration: Seam = {
        sign,
        token: token[2] ?? "",
        citation: token[3] ?? null,
      };
      if (
        declaration.citation !== null &&
        !/^[^\s:]+(?:\/[^\s:]+)*:\d+$/.test(declaration.citation)
      ) {
        error(`invalid seam citation in ${storyPath}: ${value}`);
      }
      if (parsed.some((entry) => entry.token === declaration.token)) {
        error(
          `two signs for one diagram in ${storyPath}: ${declaration.token}`,
        );
      }
      parsed.push(declaration);
    }
    seams.set(diagramId, parsed);
  }
  return seams;
}

function singleLine(source: string, key: string): string | null {
  const matches = [
    ...source.matchAll(new RegExp(`^${key}:\\s*(.*?)\\s*$`, "gm")),
  ];
  return matches.length === 0 ? null : (matches[0]?.[1] ?? "");
}

function parseStory(epicId: string, storyPath: string, ordinal: number): Story {
  const source = readFileSync(storyPath, "utf8");
  const kindLines = [...source.matchAll(/^Kind:\s*(.*?)\s*$/gm)];
  const kind = kindLines[0]?.[1] ?? "";
  if (
    kindLines.length !== 1 ||
    !["story-foundation", "story-implement"].includes(kind)
  ) {
    error(`story ${storyPath} has no valid kind`);
  }

  const verifyStart = source.search(/^## Verify\s*$/m);
  if (verifyStart < 0) error(`story ${storyPath} has no numbered case list`);
  const verifyBody = source.slice(verifyStart).replace(/^## Verify\s*$/m, "");
  const nextSection = verifyBody.search(/^##\s+/m);
  const verifySection =
    nextSection < 0 ? verifyBody : verifyBody.slice(0, nextSection);
  if (!/^\s*\d+[a-z]?\.\s+/m.test(verifySection)) {
    error(`story ${storyPath} has no numbered case list`);
  }

  const diagrams: string[] = [];
  for (const line of source.split(/\r?\n/)) {
    const match = line.match(/^Diagrams:\s*(.*)$/);
    if (match === null) continue;
    for (const id of match[1]?.trim().split(/\s+/) ?? []) {
      if (id.length > 0) diagrams.push(id);
    }
  }

  const baselines = new Map<string, string>();
  for (const line of source.split(/\r?\n/)) {
    const match = line.match(/^Baselines:\s*(.*)$/);
    if (match === null) continue;
    const body = match[1]?.trim() ?? "";
    const pairs = [...body.matchAll(/([^\s]+)\s+<-\s+([^\s]+)/g)];
    if (body.length > 0 && pairs.length === 0) {
      error(`malformed Baselines line in ${storyPath}`);
    }
    for (const pair of pairs) {
      const live = pair[1] ?? "";
      const baseline = pair[2] ?? "";
      if (baselines.has(live))
        error(`duplicate baseline pair in ${storyPath}: ${live}`);
      baselines.set(live, baseline);
    }
  }

  const diagramBlocks = diagramSections(source, storyPath).map((section) =>
    parseDiagram(section, storyPath),
  );
  const pathsLine = singleLine(source, "Paths");
  return {
    epicId,
    path: storyPath,
    stem: basename(storyPath, ".md"),
    ordinal,
    source,
    kind,
    executor: singleLine(source, "Executor"),
    paths:
      pathsLine === null
        ? []
        : pathsLine.split(/\s+/).filter((p) => p.length > 0),
    diagrams,
    baselines,
    seams: parseSeams(source, storyPath),
    diagramBlocks,
    references: referencesIn(source, storyPath),
  };
}

function readEpics(repositoryRoot: string): readonly Epic[] {
  const epicsRoot = resolve(repositoryRoot, ".agents/plan/epics");
  const storiesRoot = resolve(repositoryRoot, ".agents/plan/stories");
  if (!existsSync(epicsRoot) || !statSync(epicsRoot).isDirectory()) {
    error(`missing plan epics directory ${epicsRoot}`);
  }
  if (!existsSync(storiesRoot) || !statSync(storiesRoot).isDirectory()) {
    error(`missing plan stories directory ${storiesRoot}`);
  }

  const epics: Epic[] = [];
  for (const epicId of authoredEpics) {
    const matches = sortedEntries(epicsRoot).filter(
      (name) => name.startsWith(`${epicId}-`) && name.endsWith(".md"),
    );
    if (matches.length === 0) error(`missing epic file for ${epicId}`);
    if (matches.length > 1) error(`multiple epic files for ${epicId}`);
    const epicName = matches[0] ?? "";
    const epicPath = resolve(epicsRoot, epicName);
    const epicSource = readFileSync(epicPath, "utf8");
    if (/^\s*```mermaid\b/im.test(epicSource)) {
      error(`epic ${epicPath} holds a mermaid block`);
    }

    const stem = basename(epicName, ".md");
    const storyPath = resolve(storiesRoot, stem);
    if (!existsSync(storyPath) || !statSync(storyPath).isDirectory()) {
      error(`missing story directory for ${epicId}: ${storyPath}`);
    }
    const stories = sortedEntries(storyPath)
      .filter((name) => name.endsWith(".md") && name !== "index.md")
      .map((name, index) =>
        parseStory(epicId, resolve(storyPath, name), index + 1),
      );
    if (stories.length > 10)
      error(`epic ${epicPath} holds more than ten stories`);
    epics.push({ id: epicId, path: epicPath, stem, epicSource, stories });
  }
  return epics;
}

function allDiagrams(epics: readonly Epic[]): DiagramIndex {
  const diagrams: ParsedDiagram[] = [];
  const owners = new Map<string, Story>();
  const declaredOwners = new Map<string, Story>();
  for (const epic of epics) {
    for (const story of epic.stories) {
      const storyDiagrams = new Map(
        story.diagramBlocks.map((diagram) => [diagram.id, diagram]),
      );
      for (const diagram of story.diagramBlocks) {
        if (diagrams.some((candidate) => candidate.id === diagram.id)) {
          error(`diagram id repeats across diagrams: ${diagram.id}`);
        }
        diagrams.push(diagram);
        declaredOwners.set(diagram.id, story);
      }
      for (const id of story.diagrams) {
        const diagram = storyDiagrams.get(id);
        if (diagram === undefined)
          error(`Diagrams line names no diagram ${id} in ${story.path}`);
        if (diagram.baseline)
          error(`Diagrams line names a baseline ${id} in ${story.path}`);
        const previous = owners.get(id);
        if (previous !== undefined) error(`live diagram ${id} has two owners`);
        owners.set(id, story);
      }
      if (story.kind === "story-foundation") {
        if (
          story.diagrams.length > 0 ||
          story.baselines.size > 0 ||
          story.seams.size > 0
        ) {
          error(`story-foundation ${story.path} carries a path declaration`);
        }
      } else {
        if (story.diagrams.length === 0)
          error(`story-implement ${story.path} declares no Diagrams line`);
        if (story.diagrams.length > 1)
          error(`story ${story.path} owns two live diagrams`);
      }
      for (const diagram of story.diagramBlocks) {
        if (!diagram.baseline && !story.diagrams.includes(diagram.id)) {
          error(`live diagram ${diagram.id} is named by no Diagrams line`);
        }
      }
    }
  }
  return { diagrams, owners, declaredOwners };
}

function validateReferences(epics: readonly Epic[], index: DiagramIndex): void {
  const knownEpicIds = new Set<string>(authoredEpics);
  const byId = new Map(index.diagrams.map((diagram) => [diagram.id, diagram]));
  for (const epic of epics) {
    for (const story of epic.stories) {
      for (const reference of story.references) {
        if (!knownEpicIds.has(reference.epicId)) {
          error(
            `supersession names an epic outside the authored set: EPIC ${reference.epicId}`,
          );
        }
        const target = byId.get(reference.diagramId);
        if (target === undefined) {
          error(
            `supersession names no declared diagram ${reference.diagramId}`,
          );
        }
        const targetOwner = index.declaredOwners.get(reference.diagramId);
        if (
          targetOwner !== undefined &&
          targetOwner.epicId !== reference.epicId
        ) {
          error(
            `supersession names ${reference.diagramId} under the wrong epic`,
          );
        }
      }
      for (const diagram of story.diagramBlocks) {
        for (const reference of [
          ...diagram.supersedes,
          ...diagram.supersededBy,
          ...diagram.tailPins,
        ]) {
          if (!knownEpicIds.has(reference.epicId)) {
            error(
              `diagram ${diagram.id} names an epic outside the authored set`,
            );
          }
          const target = byId.get(reference.diagramId);
          if (target === undefined) {
            error(
              `diagram ${diagram.id} names no declared diagram ${reference.diagramId}`,
            );
          }
          const targetOwner = index.declaredOwners.get(reference.diagramId);
          if (
            targetOwner !== undefined &&
            targetOwner.epicId !== reference.epicId
          ) {
            error(
              `diagram ${diagram.id} names ${reference.diagramId} under the wrong epic`,
            );
          }
        }
        for (const epicId of diagram.unchangedTailEpics) {
          if (!knownEpicIds.has(epicId)) {
            error(
              `diagram ${diagram.id} names an epic outside the authored set`,
            );
          }
        }
        if (diagram.baseline && diagram.supersededBy.length === 0) {
          error(`baseline ${diagram.id} carries no Superseded by line`);
        }
      }
    }
  }
}

function validateBaselinePairs(
  epics: readonly Epic[],
  index: DiagramIndex,
): void {
  const byId = new Map(index.diagrams.map((diagram) => [diagram.id, diagram]));
  for (const epic of epics) {
    for (const story of epic.stories) {
      for (const [liveId, baselineId] of story.baselines) {
        if (!story.diagrams.includes(liveId)) {
          error(
            `Baselines pair names a diagram the story does not own: ${liveId}`,
          );
        }
        const baseline = byId.get(baselineId);
        if (baseline === undefined || !baseline.baseline) {
          error(`Baselines pair names no baseline diagram: ${baselineId}`);
        }
      }
    }
  }
}

function seamMatches(actual: string, declared: string): boolean {
  return actual === declared || actual.startsWith(`${declared}:`);
}

function diagramPrior(
  story: Story,
  diagram: ParsedDiagram,
  byId: ReadonlyMap<string, ParsedDiagram>,
): ParsedDiagram | null {
  const baselineId = story.baselines.get(diagram.id);
  if (baselineId !== undefined) return byId.get(baselineId) ?? null;
  const superseded = diagram.supersedes[0]?.diagramId;
  return superseded === undefined ? null : (byId.get(superseded) ?? null);
}

function validateSeams(epics: readonly Epic[], index: DiagramIndex): void {
  const byId = new Map(index.diagrams.map((diagram) => [diagram.id, diagram]));
  for (const epic of epics) {
    for (const story of epic.stories) {
      for (const [diagramId, seams] of story.seams) {
        if (!story.diagrams.includes(diagramId)) {
          error(
            `Seams line names a diagram the story does not own: ${diagramId}`,
          );
        }
        const diagram = byId.get(diagramId);
        if (diagram === undefined)
          error(`Seams line names no diagram: ${diagramId}`);
        for (const seam of seams) {
          const matchingCurrent = diagram.tokens.filter((token) =>
            seamMatches(token, seam.token),
          );
          const prior = diagramPrior(story, diagram, byId);
          const matchingPrior =
            prior?.tokens.filter((token) => seamMatches(token, seam.token)) ??
            [];
          if (
            (seam.sign === "+" || seam.sign === "~") &&
            matchingCurrent.length === 0
          ) {
            error(`${seam.sign} token appears in no diagram: ${seam.token}`);
          }
          if (seam.sign === "+" && matchingPrior.length > 0) {
            error(`+ token appears in its baseline: ${seam.token}`);
          }
          if (seam.sign === "-" && matchingCurrent.length > 0) {
            error(`- token appears in its diagram: ${seam.token}`);
          }
          if (
            seam.sign === "-" &&
            matchingPrior.length === 0 &&
            seam.citation === null
          ) {
            error(
              `- token appears in neither baseline nor citation: ${seam.token}`,
            );
          }
        }
      }

      for (const diagram of story.diagramBlocks) {
        if (diagram.baseline) continue;
        const priorTokens = new Set(
          diagramPrior(story, diagram, byId)?.tokens ?? [],
        );
        for (const token of diagram.tokens) {
          if (priorTokens.has(token)) continue;
          const localDeclarations = (story.seams.get(diagram.id) ?? []).filter(
            (seam) =>
              (seam.sign === "+" || seam.sign === "~") &&
              seamMatches(token, seam.token),
          );
          const declarations =
            localDeclarations.length > 0
              ? localDeclarations
              : epics.flatMap((candidateEpic) =>
                  candidateEpic.stories.flatMap((candidateStory) =>
                    [...candidateStory.seams.values()].flatMap(
                      (candidateSeams) =>
                        candidateSeams.filter(
                          (seam) =>
                            (seam.sign === "+" || seam.sign === "~") &&
                            seamMatches(token, seam.token),
                        ),
                    ),
                  ),
                );
          if (declarations.length !== 1) {
            error(
              `changed token ${token} in ${diagram.id} has ${declarations.length} sign owners`,
            );
          }
        }
      }
    }
  }
}

function validateScenarios(repositoryRoot: string, index: DiagramIndex): void {
  const scenariosRoot = resolve(repositoryRoot, "test/sequence/scenarios");
  const live = index.diagrams.filter((diagram) => !diagram.baseline);
  const baselineIds = new Set(
    index.diagrams
      .filter((diagram) => diagram.baseline)
      .map((diagram) => diagram.id),
  );
  const shipped = new Set<string>(shippedEpics);
  const scenarios =
    existsSync(scenariosRoot) && statSync(scenariosRoot).isDirectory()
      ? sortedEntries(scenariosRoot).filter((name) => name.endsWith(".ts"))
      : [];
  const scenarioIds = new Set(scenarios.map((name) => name.slice(0, -3)));
  const byId = new Map(live.map((diagram) => [diagram.id, diagram]));

  for (const scenario of scenarios) {
    const id = scenario.slice(0, -3);
    const scenarioPath = resolve(scenariosRoot, scenario);
    if (baselineIds.has(id))
      error(`scenario ${scenarioPath} is a baseline diagram`);
    const diagram = byId.get(id);
    if (diagram === undefined)
      error(`scenario ${scenarioPath} names no live diagram`);
    if (
      diagram.supersededBy.some((reference) => shipped.has(reference.epicId))
    ) {
      error(`scenario ${scenarioPath} names a superseded live diagram`);
    }
  }

  for (const diagram of live) {
    const owner = index.owners.get(diagram.id);
    if (owner === undefined)
      error(`live diagram ${diagram.id} has no story owner`);
    const due =
      shipped.has(owner.epicId) &&
      !diagram.supersededBy.some((reference) => shipped.has(reference.epicId));
    if (due) {
      const scenarioPath = join(
        "test",
        "sequence",
        "scenarios",
        `${diagram.id}.ts`,
      );
      if (!scenarioIds.has(diagram.id)) {
        error(`due live diagram ${diagram.id} lacks ${scenarioPath}`);
      }
      if (!owner.source.includes(scenarioPath)) {
        error(`story ${owner.path} does not name ${scenarioPath}`);
      }
    }
  }
}

const laneCache = new Map<string, boolean>();

function laneAllows(role: string, path: string): boolean {
  const key = `${role} ${path}`;
  const cached = laneCache.get(key);
  if (cached !== undefined) return cached;
  const guard = resolve(import.meta.dirname, "lane-check.sh");
  let allowed = true;
  try {
    execFileSync(guard, [role, path], { stdio: "ignore" });
  } catch {
    allowed = false;
  }
  laneCache.set(key, allowed);
  return allowed;
}

function sectionOf(source: string, heading: string): string | null {
  const start = source.search(new RegExp(`^## ${heading}\\s*$`, "m"));
  if (start < 0) return null;
  const rest = source.slice(start).replace(/^## .*\n/, "");
  const next = rest.search(/^## /m);
  return next < 0 ? rest : rest.slice(0, next);
}

const EDIT_VERB =
  /^(?:Create|Add|Delete|Remove|Move|Rename|Replace|Append|Extend|Edit|Update|Write|Register|Drop|Insert)\b/;

function validateLanes(epics: readonly Epic[]): void {
  for (const epic of epics) {
    const declared = new Map<string, Story>();
    for (const story of epic.stories) {
      const hasExecutor = story.executor !== null;
      const hasPaths = story.paths.length > 0;
      if (hasExecutor !== hasPaths) {
        error(
          `story ${story.path} declares ${hasExecutor ? "Executor" : "Paths"} and not the other`,
        );
      }
      if (story.kind === "story-implement" && (hasExecutor || hasPaths)) {
        error(`story-implement ${story.path} carries a lane declaration`);
      }
      for (const path of story.paths) {
        if (
          laneAllows("test-engineer", path) ||
          laneAllows("software-engineer", path)
        ) {
          error(`Paths path is allowed to an engineer lane: ${path}`);
        }
        if (!laneAllows("groundwork-engineer", path)) {
          error(`Paths path is denied to groundwork-engineer: ${path}`);
        }
        const previous = declared.get(path);
        if (previous !== undefined) {
          error(
            `path ${path} appears in the Paths line of two stories of ${epic.id}`,
          );
        }
        declared.set(path, story);
      }
    }
    for (const story of epic.stories) {
      const change = sectionOf(story.source, "Change");
      if (change === null) continue;
      for (const directive of change.matchAll(
        /\*\*([A-Z][a-z]+[^*]{0,200}?)\*\*/g,
      )) {
        const text = directive[1] ?? "";
        if (!EDIT_VERB.test(text)) continue;
        for (const span of text.matchAll(
          /`([A-Za-z0-9._/-]+\.(?:ts|js|mjs|json|sh|yaml|yml|md))`/g,
        )) {
          const path = span[1] ?? "";
          if (
            laneAllows("test-engineer", path) ||
            laneAllows("software-engineer", path)
          ) {
            continue;
          }
          if (!laneAllows("groundwork-engineer", path)) continue;
          if (declared.has(path)) continue;
          error(
            `story ${story.path} edits ${path}, which no Paths line of ${epic.id} declares`,
          );
        }
      }
    }
  }
}

function validateStoryReferences(epics: readonly Epic[]): void {
  // Two orderings are in use and both are legitimate: an epic holding
  // `00-groundwork.md` is cited by dispatch position in 48 places and by
  // filename prefix in 92. Accepting either still refuses an ordinal that is
  // neither, which is the defect worth catching.
  const byEpic = new Map(
    epics.map((epic) => [
      epic.id,
      new Map(
        epic.stories.map((story) => [
          story.stem,
          [story.ordinal, Number(story.stem.slice(0, 2))] as const,
        ]),
      ),
    ]),
  );
  for (const epic of epics) {
    for (const file of [
      { path: epic.path, source: epic.epicSource },
      ...epic.stories,
    ]) {
      const flat = file.source.replace(/\r?\n/g, " ");
      for (const match of flat.matchAll(
        /(?:EPIC\s+(\d+(?:\.\d+)?)\s+)?Story\s+(\d+)\s*\(\s*`(\d{2}[a-z0-9.-]*)`\s*\)/g,
      )) {
        const named = match[1];
        const stem = match[3] ?? "";
        const written = Number(match[2]);
        const stems = byEpic.get(named ?? epic.id);
        if (stems === undefined) continue;
        const ordinals = stems.get(stem);
        if (ordinals === undefined) {
          if (named === undefined) continue;
          error(
            `${file.path} names EPIC ${named} Story ${written} (${stem}), a stem that epic has no story for`,
          );
        }
        if (!ordinals.includes(written)) {
          error(
            `${file.path} names Story ${written} (${stem}), which is neither its dispatch position ${ordinals[0]} nor its file prefix ${ordinals[1]}`,
          );
        }
      }
    }
  }
}

function validateCitations(
  repositoryRoot: string,
  epics: readonly Epic[],
): readonly string[] {
  const relocated: string[] = [];
  const lineCache = new Map<string, readonly string[] | null>();
  const linesOf = (target: string): readonly string[] | null => {
    const cached = lineCache.get(target);
    if (cached !== undefined) return cached;
    const value =
      existsSync(target) && statSync(target).isFile()
        ? readFileSync(target, "utf8").split(/\r?\n/)
        : null;
    lineCache.set(target, value);
    return value;
  };
  for (const epic of epics) {
    for (const file of [
      { path: epic.path, source: epic.epicSource },
      ...epic.stories,
    ]) {
      const flat = file.source.replace(/\r?\n/g, " ");
      for (const match of flat.matchAll(
        /`([^`\s]+?):(\d+)`\s*(?:—|--)\s*`([^`]+)`/g,
      )) {
        const cited = match[1] ?? "";
        const line = Number(match[2]);
        const identifier = match[3] ?? "";
        if (!/\.[A-Za-z0-9]+$/.test(cited)) continue;
        const lines = linesOf(resolve(repositoryRoot, cited));
        if (lines === null) {
          error(`${file.path} cites ${cited}, which is not a file`);
        }
        if (line > lines.length) {
          error(
            `${file.path} cites ${cited}:${line}, beyond its ${lines.length} lines`,
          );
        }
        if ((lines[line - 1] ?? "").includes(identifier)) continue;
        if (!lines.some((candidate) => candidate.includes(identifier))) {
          error(
            `${file.path} cites ${cited}:${line} for ${identifier}, which the file does not hold`,
          );
        }
        relocated.push(`${file.path}: ${cited}:${line} — ${identifier}`);
      }
    }
  }
  return relocated;
}

function validateGateTables(epics: readonly Epic[]): void {
  for (const epic of epics) {
    const gate = sectionOf(epic.epicSource, "Verification Gate");
    if (gate === null) error(`epic ${epic.path} has no Verification Gate`);
    const rows = gate.split(/\r?\n/).filter((line) => /^\s*\|/.test(line));
    if (rows.length === 0) {
      error(`epic ${epic.path} hermetic-coverage list is not a table`);
    }
    const header = (rows[0] ?? "")
      .split("|")
      .map((cell) => cell.trim().toLowerCase());
    const storyColumn = header.findIndex((cell) => cell === "story");
    if (storyColumn < 0) {
      error(`epic ${epic.path} gate table has no story column`);
    }
    for (const row of rows.slice(2)) {
      const cells = row.split("|");
      const cell = (cells[storyColumn] ?? "").trim();
      const named = cell
        .split(/[,+&]| and /)
        .map((value) => value.trim())
        .filter((value) => value.length > 0);
      if (named.length !== 1) {
        error(
          `epic ${epic.path} gate row names ${named.length} stories: "${cell}"`,
        );
      }
    }
  }
}

export function verifyEpicSequence(repositoryRoot: string): readonly string[] {
  const epics = readEpics(resolve(repositoryRoot));
  const index = allDiagrams(epics);
  validateReferences(epics, index);
  validateBaselinePairs(epics, index);
  validateSeams(epics, index);
  validateScenarios(repositoryRoot, index);
  validateLanes(epics);
  validateStoryReferences(epics);
  validateGateTables(epics);
  return validateCitations(repositoryRoot, epics);
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const relocated = verifyEpicSequence(resolve(process.cwd()));
  for (const line of relocated) {
    process.stdout.write(`relocated citation: ${line}\n`);
  }
  if (relocated.length > 0) {
    process.stdout.write(
      `${relocated.length} citations name an identifier that moved. Not a refusal: see .agents/plan/authoring.md.\n`,
    );
  }
}
