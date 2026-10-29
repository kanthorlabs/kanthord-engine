import { basename, relative, sep } from "node:path";

const START_EVENT = "test:start";
const FAIL_EVENT = "test:fail";
const SUMMARY_EVENT = "test:summary";
const COMPLETE_EVENT = "test:complete";
const MS_PER_SECOND = 1000;
const ROOT_NESTING = 0;
const NAME_SEPARATOR = " > ";
const PATH_SEPARATOR = "/";

function relativePath(file) {
  return relative(process.cwd(), file).split(sep).join(PATH_SEPARATOR);
}

function isFileFailure({ file, name, nesting }) {
  return (
    nesting === ROOT_NESTING &&
    (name === basename(file) || name === relativePath(file))
  );
}

function secondsLine(file, durationMs) {
  const seconds = durationMs / MS_PER_SECOND;
  return `${JSON.stringify({ file: relativePath(file), seconds })}\n`;
}

export default async function* reporter(source) {
  const openNames = new Map();
  const summarized = new Set();
  const completed = new Map();
  for await (const { type, data } of source) {
    if (type === START_EVENT) {
      const names = openNames.get(data.file) ?? [];
      names.length = data.nesting;
      names.push(data.name);
      openNames.set(data.file, names);
    }
    if (type === SUMMARY_EVENT && data.file !== undefined) {
      summarized.add(data.file);
      yield secondsLine(data.file, data.duration_ms);
    }
    if (
      (type === COMPLETE_EVENT || type === FAIL_EVENT) &&
      isFileFailure(data)
    ) {
      completed.set(data.file, data.details.duration_ms);
    }
    if (type === FAIL_EVENT) {
      const file = relativePath(data.file);
      const names = (openNames.get(data.file) ?? []).slice(0, data.nesting + 1);
      const name = isFileFailure(data) ? file : names.join(NAME_SEPARATOR);
      yield `${JSON.stringify({ file, name })}\n`;
    }
  }
  for (const [file, durationMs] of completed) {
    if (!summarized.has(file)) yield secondsLine(file, durationMs);
  }
}
