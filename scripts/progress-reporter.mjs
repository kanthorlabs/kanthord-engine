import { basename, relative, sep } from "node:path";

const DEQUEUE_EVENT = "test:dequeue";
const COMPLETE_EVENT = "test:complete";
const MS_PER_SECOND = 1000;
const ROOT_NESTING = 0;
const PATH_SEPARATOR = "/";

function relativePath(file) {
  return relative(process.cwd(), file).split(sep).join(PATH_SEPARATOR);
}

function isFileTest({ file, name, nesting }) {
  return (
    nesting === ROOT_NESTING &&
    (name === basename(file) || name === relativePath(file))
  );
}

export default async function* reporter(source) {
  for await (const { type, data } of source) {
    if (type === DEQUEUE_EVENT && isFileTest(data)) {
      yield `start: ${relativePath(data.file)}\n`;
    }
    if (type === COMPLETE_EVENT && isFileTest(data)) {
      const seconds = data.details.duration_ms / MS_PER_SECOND;
      yield `end: ${relativePath(data.file)} ${seconds} s\n`;
    }
  }
}
