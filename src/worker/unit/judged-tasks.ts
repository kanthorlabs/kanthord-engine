import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { readPrivate, writePrivate } from "../../kernel/files.ts";

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

function read(nodeDirectory: string): Record<string, string> {
  const path = join(nodeDirectory, JUDGED_TASKS_FILE);
  if (!existsSync(path)) return {};
  const parsed = judgedTasksSchema.safeParse(
    JSON.parse(readPrivate(path) || "{}"),
  );
  return parsed.success ? parsed.data : {};
}

export function judgedAt(
  nodeDirectory: string,
  task: JudgedTask,
): string | null {
  return read(nodeDirectory)[keyOf(task)] ?? null;
}

export function recordJudged(
  nodeDirectory: string,
  task: JudgedTask,
  commit: string,
): void {
  const judged = { ...read(nodeDirectory), [keyOf(task)]: commit };
  writePrivate(
    join(nodeDirectory, JUDGED_TASKS_FILE),
    JSON.stringify(judged),
    true,
  );
}
