import assert from "node:assert/strict";
import { test } from "node:test";
import { agentOperations, PromptTemplate } from "../../agent/contract.ts";
import {
  renderTemplate,
  SHIPPED_TEMPLATES,
} from "../../agent/prompt-templates.ts";
import { gatewayOperations } from "../../gateway/contract.ts";
import type { Operation } from "../../kernel/operation.ts";
import { llmOperations } from "../../llm/contract.ts";
import { missionOperations } from "../../mission/contract.ts";
import { projectOperations } from "../../project/contract.ts";
import { schedulerOperations } from "../../scheduler/contract.ts";
import { workerOperations } from "../../worker/contract.ts";
import { workbenchOperations } from "../../workbench/contract.ts";
import { planMutations } from "../../workbench/index.ts";

const REQUEST = "Add a node to the mission.";
const RELAY = "Ulrich asked Yumi for the status.";
const DRAFT = "## Conclusion\nAdd the node.";
const EXPECTED_CLASSES: Record<string, string> = {
  "mission.node.pause": "reversible",
  "mission.node.resume": "reversible",
  "mission.node.check": "reversible",
  "mission.node.priority.set": "reversible",
  "mission.dependency.add": "reversible",
  "mission.dependency.remove": "reversible",
  "project.pause": "reversible",
  "project.resume": "reversible",
  "agent.cooldown.clear": "reversible",
  "mission.node.unblock": "judged",
  "mission.node.block": "judged",
  "mission.node.create": "judged",
  "mission.node.update": "judged",
  "mission.proposal.decide": "judged",
  "mission.criterion.set": "judged",
  "mission.import.apply": "card",
};

const OPERATIONS = [
  gatewayOperations,
  llmOperations,
  workerOperations,
  agentOperations,
  schedulerOperations,
  projectOperations,
  missionOperations,
  workbenchOperations,
].flatMap((operations) => Object.values(operations) as Operation[]);

function mutationLines(): string[] {
  return Object.entries(EXPECTED_CLASSES).map(
    ([id, guardClass]) => `- ${id} - guard:${guardClass}`,
  );
}

test("the plan-draft text holds the request, the relay and each mutation with its class", () => {
  const text = renderTemplate(SHIPPED_TEMPLATES, PromptTemplate.PlanDraft, {
    request: REQUEST,
    relay: RELAY,
    mutations: planMutations(OPERATIONS),
  });
  for (const part of [REQUEST, RELAY, ...mutationLines()])
    assert.ok(text.includes(part), part);
});

test("the plan-review text holds the request, the draft and each mutation with its class", () => {
  const text = renderTemplate(SHIPPED_TEMPLATES, PromptTemplate.PlanReview, {
    request: REQUEST,
    draft: DRAFT,
    mutations: planMutations(OPERATIONS),
  });
  for (const part of [REQUEST, DRAFT, ...mutationLines()])
    assert.ok(text.includes(part), part);
});
