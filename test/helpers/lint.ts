import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { ESLint } from "eslint";

export type LintCase = Readonly<{ filePath: string; code: string }>;

export async function lintCase(input: LintCase): Promise<readonly string[]> {
  const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
  const eslint = new ESLint({ cwd: repositoryRoot });
  const results = await eslint.lintText(input.code, {
    filePath: join(repositoryRoot, input.filePath),
  });

  const ruleIds = new Set<string>();
  for (const result of results) {
    for (const message of result.messages) {
      if (message.ruleId) {
        ruleIds.add(message.ruleId);
      }
    }
  }

  return [...ruleIds].sort((a, b) =>
    Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8")),
  );
}
