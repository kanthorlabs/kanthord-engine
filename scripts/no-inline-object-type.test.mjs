import { RuleTester } from "eslint";
import { test } from "node:test";
import tseslint from "typescript-eslint";
import { kanthordPlugin } from "../eslint.config.js";

const rule = kanthordPlugin.rules["no-inline-object-type"];
const tester = new RuleTester({
  languageOptions: { parser: tseslint.parser },
});
const refused = (code, errors) => ({ code, errors });

test("no-inline-object-type refuses the four inline forms", () => {
  tester.run("no-inline-object-type", rule, {
    valid: [
      "interface A { b: B; c: number; d: B | null }",
      "const Kind = { A: 'a' } as const; interface E { kind: typeof Kind.A }",
      "type U = A | B;",
      "function f(options: { a: number }) { return options; }",
      "type N = { a: number };",
      "interface A { size: 1 | 2; on: true }",
    ],
    invalid: [
      refused("type U = { a: number } | null;", 1),
      refused("interface A { b: { c: number } }", 1),
      refused("interface A { kind: 'a' }", 1),
      refused("interface A { kind: 'a' | 'b' | null }", 2),
    ],
  });
});
