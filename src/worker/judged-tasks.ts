import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { readPrivate, writePrivate } from "../kernel/files.ts";

const JUDGED_TASKS_FILE = "judged-tasks.json";
const judgedTasksSchema = z.record(z.string(), z.string());

export interface JudgedTask {
  readonly attempt: number;
  readonly revision: number;
  readonly taskId: string;
}

function keyOf(task: JudgedTask): string {
  return `${task.attempt}/${task.revision}/${task.taskId}`;
}

function read(objectiveDirectory: string): Record<string, string> {
  const path = join(objectiveDirectory, JUDGED_TASKS_FILE);
  if (!existsSync(path)) return {};
  const parsed = judgedTasksSchema.safeParse(
    JSON.parse(readPrivate(path) || "{}"),
  );
  return parsed.success ? parsed.data : {};
}

export function judgedAt(
  objectiveDirectory: string,
  task: JudgedTask,
): string | null {
  return read(objectiveDirectory)[keyOf(task)] ?? null;
}

export function recordJudged(
  objectiveDirectory: string,
  task: JudgedTask,
  commit: string,
): void {
  const judged = { ...read(objectiveDirectory), [keyOf(task)]: commit };
  writePrivate(
    join(objectiveDirectory, JUDGED_TASKS_FILE),
    JSON.stringify(judged),
    true,
  );
}
