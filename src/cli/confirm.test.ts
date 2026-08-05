import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  confirmValue,
  ConfirmationRequiredError,
  type ConfirmDependencies,
} from "./confirm.ts";

describe("src/cli/confirm.test", () => {
  const throwingPrompt = async (): Promise<string> => {
    throw new Error("the prompt must not be called");
  };

  it("a non-empty flagValue is returned and the prompt is never called", async () => {
    const dependencies: ConfirmDependencies = {
      isTty: true,
      prompt: throwingPrompt,
    };
    const value = await confirmValue(dependencies, {
      flagName: "--upstream",
      flagValue: "main",
      question: "upstream branch?",
      suggestion: "trunk",
    });
    assert.equal(value, "main");
  });

  it("an empty-string flagValue is treated as absent", async () => {
    let promptCalls = 0;
    const dependencies: ConfirmDependencies = {
      isTty: false,
      prompt: async () => {
        promptCalls += 1;
        return "";
      },
    };
    try {
      await confirmValue(dependencies, {
        flagName: "--upstream",
        flagValue: "",
        question: "upstream branch?",
        suggestion: "main",
      });
      assert.fail("expected ConfirmationRequiredError");
    } catch (error) {
      assert.ok(error instanceof ConfirmationRequiredError);
      assert.equal((error as ConfirmationRequiredError).flagName, "--upstream");
    }
    assert.equal(promptCalls, 0);
  });

  it("isTty false with no flagValue throws ConfirmationRequiredError with the flag name and never prompts", async () => {
    let promptCalls = 0;
    const dependencies: ConfirmDependencies = {
      isTty: false,
      prompt: async () => {
        promptCalls += 1;
        return "";
      },
    };
    try {
      await confirmValue(dependencies, {
        flagName: "--host-fingerprint",
        flagValue: undefined,
        question: "host key fingerprint?",
        suggestion: null,
      });
      assert.fail("expected ConfirmationRequiredError");
    } catch (error) {
      assert.ok(error instanceof ConfirmationRequiredError);
      assert.equal(error.flagName, "--host-fingerprint");
      assert.equal(
        error.message,
        "--host-fingerprint is required when there is no terminal to confirm on",
      );
    }
    assert.equal(promptCalls, 0);
  });

  it("isTty true with no flagValue prompts once and the question includes the suggestion in brackets", async () => {
    const questions: string[] = [];
    const dependencies: ConfirmDependencies = {
      isTty: true,
      prompt: async (question) => {
        questions.push(question);
        return "main";
      },
    };
    const value = await confirmValue(dependencies, {
      flagName: "--upstream",
      flagValue: undefined,
      question: "upstream branch?",
      suggestion: "trunk",
    });
    assert.equal(value, "main");
    assert.equal(questions.length, 1);
    assert.equal(questions[0], "upstream branch? [trunk]");
  });

  it("the question carries no bracket when the suggestion is null", async () => {
    const questions: string[] = [];
    const dependencies: ConfirmDependencies = {
      isTty: true,
      prompt: async (question) => {
        questions.push(question);
        return "ok";
      },
    };
    await confirmValue(dependencies, {
      flagName: "--host-fingerprint",
      flagValue: undefined,
      question: "host key fingerprint?",
      suggestion: null,
    });
    assert.equal(questions.length, 1);
    assert.equal(questions[0], "host key fingerprint?");
  });

  it("an empty answer with a suggestion returns the suggestion", async () => {
    let promptCalls = 0;
    const dependencies: ConfirmDependencies = {
      isTty: true,
      prompt: async () => {
        promptCalls += 1;
        return "";
      },
    };
    const value = await confirmValue(dependencies, {
      flagName: "--upstream",
      flagValue: undefined,
      question: "upstream branch?",
      suggestion: "trunk",
    });
    assert.equal(value, "trunk");
    assert.equal(promptCalls, 1);
  });

  it("an empty answer with a null suggestion re-asks until a non-empty answer resolves", async () => {
    const answers = ["", "", "main"];
    let promptCalls = 0;
    const dependencies: ConfirmDependencies = {
      isTty: true,
      prompt: async () => {
        promptCalls += 1;
        return answers[promptCalls - 1] ?? "";
      },
    };
    const value = await confirmValue(dependencies, {
      flagName: "--upstream",
      flagValue: undefined,
      question: "upstream branch?",
      suggestion: null,
    });
    assert.equal(value, "main");
    assert.equal(promptCalls, 3);
  });

  it("a whitespace-padded answer is returned trimmed", async () => {
    const dependencies: ConfirmDependencies = {
      isTty: true,
      prompt: async () => "  main  ",
    };
    const value = await confirmValue(dependencies, {
      flagName: "--upstream",
      flagValue: undefined,
      question: "upstream branch?",
      suggestion: null,
    });
    assert.equal(value, "main");
  });
});
