import assert from "node:assert/strict";
import { test } from "node:test";
import { InstructionFileState } from "./contract.ts";
import { background } from "../kernel/context.ts";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import {
  type InstructionFile,
  InstructionFileReason,
  ProjectErrorCode,
} from "../project/contract.ts";
import { projectInstructionFileReader } from "./instruction-files.ts";

const BINDING_ID = "binding_01";
const COMMIT = "c".repeat(40);
const PATH = "AGENTS.md";
const TEXT = "Write every name in snake_case.\n";
const UNPROCESSABLE = 422;

function reader(answer: () => Promise<InstructionFile | null>) {
  return projectInstructionFileReader({ instructionFileOf: answer });
}

function file(fields: Partial<InstructionFile>): InstructionFile {
  return {
    path: PATH,
    commit: COMMIT,
    state: InstructionFileState.Present,
    reason: null,
    text: TEXT,
    ...fields,
  };
}

test("the instruction file reader maps the Project read to the resolver states", async () => {
  const read = (answer: () => Promise<InstructionFile | null>) =>
    reader(answer)(BINDING_ID, COMMIT, PATH, background);
  assert.deepEqual(await read(async () => file({})), {
    state: InstructionFileState.Present,
    text: TEXT,
  });
  assert.deepEqual(await read(async () => null), {
    state: InstructionFileState.Absent,
  });
  assert.deepEqual(
    await read(async () =>
      file({ state: InstructionFileState.Absent, text: null }),
    ),
    { state: InstructionFileState.Absent },
  );
  assert.deepEqual(
    await read(async () =>
      file({
        state: InstructionFileState.Invalid,
        reason: InstructionFileReason.NotUtf8,
        text: null,
      }),
    ),
    { state: InstructionFileState.Invalid },
  );
  for (const code of [
    ProjectErrorCode.RepositorySshUnreachable,
    ProjectErrorCode.RepositoryBaseBranchAbsent,
  ])
    assert.deepEqual(
      await read(async () => {
        throw new OperationError(UNPROCESSABLE, code, "Read failed.");
      }),
      { state: InstructionFileState.Unreachable },
    );
  const other = new OperationError(
    HttpStatus.NotFound,
    ProjectErrorCode.BindingNotFound,
    "Binding not found.",
  );
  await assert.rejects(
    read(async () => {
      throw other;
    }),
    other,
  );
  await assert.rejects(
    reader(async () => file({}))(BINDING_ID, COMMIT, "CLAUDE.md", background),
    assert.AssertionError,
  );
});
