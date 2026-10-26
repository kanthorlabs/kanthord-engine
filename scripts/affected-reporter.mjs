import { basename, relative, sep } from "node:path";

const START_EVENT = "test:start";
const FAIL_EVENT = "test:fail";
const ROOT_NESTING = 0;
const NAME_SEPARATOR = " > ";
const PATH_SEPARATOR = "/";

function relativePath(file) {
  return relative(process.cwd(), file).split(sep).join(PATH_SEPARATOR);
}

function isFileFailure({ file, name, nesting }) {
  return nesting === ROOT_NESTING && name === basename(file);
}

export default async function* reporter(source) {
  const openNames = new Map();
  for await (const { type, data } of source) {
    if (type === START_EVENT) {
      const names = openNames.get(data.file) ?? [];
      names.length = data.nesting;
      names.push(data.name);
      openNames.set(data.file, names);
    }
    if (type === FAIL_EVENT) {
      const file = relativePath(data.file);
      const names = (openNames.get(data.file) ?? []).slice(0, data.nesting + 1);
      const name = isFileFailure(data) ? file : names.join(NAME_SEPARATOR);
      yield `${JSON.stringify({ file, name })}\n`;
    }
  }
}
