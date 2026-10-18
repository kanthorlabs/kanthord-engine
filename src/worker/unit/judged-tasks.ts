import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { readPrivate, writePrivate } from "../../kernel/files.ts";
import type { WorkspaceCheckout } from "./workspace.ts";

const JUDGED_TASKS_FILE = "judged-tasks.json";
const judgedTasksSchema = z.record(z.string(), z.string());
const SINGLE_CHECKOUT = 1;

export interface JudgedTask {
  readonly attempt: number;
  readonly revision: number;
  readonly taskId: string;
}

export function headSetOf(checkouts: readonly WorkspaceCheckout[]): string {
  assert.ok(checkouts.length >= SINGLE_CHECKOUT);
  if (checkouts.length === SINGLE_CHECKOUT) return checkouts[0]!.head;
  return checkouts
    .map((checkout) => `${checkout.name}=${checkout.head}`)
    .join(",");
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
  headSet: string,
): void {
  const judged = { ...read(nodeDirectory), [keyOf(task)]: headSet };
  writePrivate(
    join(nodeDirectory, JUDGED_TASKS_FILE),
    JSON.stringify(judged),
    true,
  );
}
