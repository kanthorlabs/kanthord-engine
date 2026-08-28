import { basename } from "node:path";

import { comparePaths } from "../../domain/plan-path.ts";

export type HarnessPlanSource = Readonly<{
  epic: Readonly<{ path: string; content: string }>;
  stories: readonly Readonly<{ path: string; content: string }>[];
  repository: string;
}>;

export type ConvertedPlanDocument = Readonly<{
  path: string;
  content: string;
}>;

type ParsedEpic = Readonly<{
  slug: string;
  number: string;
  title: string;
  goal: string;
  storyCount: number;
}>;

type ParsedStory = Readonly<{
  file: string;
  stem: string;
  number: number;
  title: string;
  change: string;
  constraints: string;
  verify: string;
}>;

const normalize = (content: string): string => content.replace(/\r\n?/g, "\n");

const isBlank = (line: string): boolean => line.trim() === "";

const section = (content: string, name: string): string | null => {
  const lines = content.split("\n");
  const start = lines.findIndex((line) => line === `## ${name}`);
  if (start === -1) return null;

  let end = start + 1;
  while (end < lines.length && !lines[end]!.startsWith("## ")) {
    end += 1;
  }

  let first = start + 1;
  while (first < end && isBlank(lines[first]!)) first += 1;

  let last = end;
  while (last > first && isBlank(lines[last - 1]!)) last -= 1;

  if (first === last) return null;
  return `${lines.slice(first, last).join("\n")}\n`;
};

const parseEpic = (input: HarnessPlanSource): ParsedEpic => {
  const file = basename(input.epic.path);
  if (!file.endsWith(".md")) {
    throw new Error("the EPIC path must end in .md");
  }

  const content = normalize(input.epic.content);
  const heading = /^# EPIC ([0-9]+) — (.+)$/.exec(content.split("\n")[0] ?? "");
  if (heading === null) {
    throw new Error("the EPIC heading is invalid");
  }

  if (input.repository.length === 0) {
    throw new Error("the repository name is empty");
  }

  const goal = section(content, "Goal");
  if (goal === null) {
    throw new Error("the EPIC Goal is missing");
  }

  const stories = section(content, "Stories");
  const numbers: string[] = [];
  if (stories !== null) {
    for (const line of stories.split("\n")) {
      const match = /^([1-9][0-9]*)\. /.exec(line);
      if (match !== null) numbers.push(match[1]!);
    }
  }

  if (numbers.length === 0) {
    throw new Error("the EPIC Stories list is empty");
  }
  for (let index = 0; index < numbers.length; index += 1) {
    if (numbers[index] !== String(index + 1)) {
      throw new Error("the EPIC Stories list is not contiguous");
    }
  }

  return {
    slug: file.slice(0, -3),
    number: heading[1]!,
    title: heading[2]!,
    goal,
    storyCount: numbers.length,
  };
};

const parseStories = (
  input: HarnessPlanSource,
  epic: ParsedEpic,
): readonly ParsedStory[] => {
  const considered = input.stories
    .filter((story) => /^[0-9]{2}-.*\.md$/.test(basename(story.path)))
    .slice()
    .sort((left, right) => comparePaths(left.path, right.path));

  if (considered.length !== epic.storyCount) {
    throw new Error(
      `expected ${epic.storyCount} expanded Story files; found ${considered.length}`,
    );
  }

  const stories: ParsedStory[] = [];
  for (let index = 0; index < considered.length; index += 1) {
    const record = considered[index]!;
    const file = basename(record.path);
    const number = index + 1;
    const expectedPrefix = String(number).padStart(2, "0");
    if (!file.startsWith(`${expectedPrefix}-`)) {
      throw new Error(`expected Story file ${expectedPrefix}; found ${file}`);
    }

    const content = normalize(record.content);
    const heading = new RegExp(`^# Story ${number} — (.+)$`).exec(
      content.split("\n")[0] ?? "",
    );
    if (heading === null) {
      throw new Error(`${record.path} heading does not name Story ${number}`);
    }

    const change = section(content, "Change");
    if (change === null) {
      throw new Error(`${record.path} has no non-empty ## Change section`);
    }
    const constraints = section(content, "Constraints");
    if (constraints === null) {
      throw new Error(`${record.path} has no non-empty ## Constraints section`);
    }
    const verify = section(content, "Verify");
    if (verify === null) {
      throw new Error(`${record.path} has no non-empty ## Verify section`);
    }

    stories.push({
      file,
      stem: file.slice(0, -3),
      number,
      title: heading[1]!,
      change,
      constraints,
      verify,
    });
  }
  return stories;
};

const scalar = (value: string): string => JSON.stringify(value);

const frontmatter = (fields: readonly string[]): string =>
  `---\n${fields.join("\n")}\n---\n`;

const renderInitiative = (epic: ParsedEpic): ConvertedPlanDocument => ({
  path: `plan/${epic.slug}/initiative.md`,
  content:
    frontmatter([
      `kind: ${scalar("initiative")}`,
      `title: ${scalar(`EPIC ${epic.number} — ${epic.title}`)}`,
    ]) + epic.goal,
});

const renderObjective = (
  epic: ParsedEpic,
  story: ParsedStory,
  previous: ParsedStory | undefined,
  repository: string,
): ConvertedPlanDocument => {
  const fields = [
    `kind: ${scalar("objective")}`,
    `title: ${scalar(story.title)}`,
  ];
  if (previous !== undefined) {
    fields.push("depends_on:");
    fields.push(`  - ${scalar(`../${previous.stem}/objective.md`)}`);
  }
  fields.push(`repo: ${scalar(repository)}`);

  return {
    path: `plan/${epic.slug}/${story.stem}/objective.md`,
    content:
      frontmatter(fields) +
      `Source story: .agents/plan/stories/${epic.slug}/${story.file}.\n`,
  };
};

const renderTask = (
  epic: ParsedEpic,
  story: ParsedStory,
): ConvertedPlanDocument => ({
  path: `plan/${epic.slug}/${story.stem}/01-implement.md`,
  content:
    frontmatter([
      `kind: ${scalar("task")}`,
      `title: ${scalar(`Implement Story ${story.number} — ${story.title}`)}`,
      `worker: ${scalar("tdd@1")}`,
    ]) +
    `## Change\n\n${story.change}## Constraints\n\n${story.constraints}## Acceptance criteria\n\n${story.verify}`,
});

export function convertHarnessPlan(
  input: HarnessPlanSource,
): readonly ConvertedPlanDocument[] {
  const epic = parseEpic(input);
  const stories = parseStories(input, epic);
  const documents: ConvertedPlanDocument[] = [renderInitiative(epic)];

  for (let index = 0; index < stories.length; index += 1) {
    const story = stories[index]!;
    documents.push(
      renderObjective(epic, story, stories[index - 1], input.repository),
      renderTask(epic, story),
    );
  }

  documents.sort((left, right) => comparePaths(left.path, right.path));
  return Object.freeze(
    documents.map((document) => Object.freeze({ ...document })),
  );
}
