import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import {
  main,
  commitMessage,
  lex,
  repoPath,
  parsePaths,
  section,
  parseDiscussion,
  snapshotParse,
  delta,
  validateAppend,
  validateGroundwork,
  parseReview,
  groundworkPaths,
  findDiscussion,
  gateCommands,
  cleanEnv,
} from "./work-runtime.mjs";

const H =
  "---\nepic: .agents/plan/epics/001-demo.md\nopened: 2026-09-01\nopener: test-engineer\nbase-ref: " +
  "a".repeat(40) +
  "\n---\n";
const turn = (role, text = "") =>
  `## ${role.toUpperCase()} — example\n${text}\nEND: ${role.toUpperCase()}\n`;
const gate =
  "Gates: `pnpm run verify`\nProof: node scripts/proof.mjs\nSuccess: PROOF OK";
const epicRel = ".agents/plan/epics/001-demo.md";
const storyRel = ".agents/plan/stories/001-demo/01-core.md";
const story =
  "# Core\n\n## Change\nImplement the public seam in src/core.ts.\n\n## Constraints\nNo unrelated edits.\n\n## Verify\nCommand: pnpm test\n1. `works` asserts the public return value.\n";
const guard = `#!/usr/bin/env bash
role="$1"; p="$2"
case "$p" in
 .agents/plan/*|.claude/*|.opencode/*|scripts/lane-check.sh|scripts/turn-snapshot.sh|scripts/verify-handoff.mjs|scripts/memory-append-only.sh|scripts/*.test.sh) exit 1;;
esac
case "$role:$p" in
 test-engineer:src/*.test.ts|test-engineer:src/*.spec.ts|test-engineer:test/*) exit 0;;
 software-engineer:src/*.test.ts|software-engineer:src/*.spec.ts|software-engineer:test/*) exit 1;;
 software-engineer:src/*.ts|software-engineer:scripts/*|software-engineer:docs/proposal/*) exit 0;;
 groundwork-engineer:package.json|groundwork-engineer:package-lock.json|groundwork-engineer:settings*|groundwork-engineer:AGENTS.md) exit 0;;
 *:.agents/tdd/*) exit 0;;
esac
exit 1
`;
const snap = `#!/usr/bin/env bash
node scripts/fixture-snapshot.cjs "$1"
`;
const snapJS = `const fs=require('fs'),path=require('path'),cp=require('child_process'),crypto=require('crypto');
const root=process.argv[2];
const git=args=>cp.execFileSync('git',args,{cwd:root,encoding:'utf8',env:{...process.env,GIT_OPTIONAL_LOCKS:'0'}});
const files=[...new Set((git(['diff','--name-only','--no-renames','-z','HEAD','--'])+git(['ls-files','--others','--exclude-standard','-z'])).split('\\0').filter(Boolean))];
console.log(files.map(p=>{const f=path.join(root,p);const h=fs.existsSync(f)?crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'):'ABSENT';return h+'\\t'+p}).sort().join('\\n'));
`;
function cmd(root, ...args) {
  const p = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    env: cleanEnv({
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    }),
  });
  assert.equal(p.status, 0, p.stderr);
  return p.stdout.trim();
}
function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "work-test-")),
    extra = [];
  function write(p, x) {
    const q = path.join(root, p);
    fs.mkdirSync(path.dirname(q), { recursive: true });
    fs.writeFileSync(q, x);
  }
  write(
    epicRel,
    `# Demo\n\n## Stories\n- 01-core.md\n\n## Verification Gate\n${gate}\n`,
  );
  write(storyRel, story);
  write("src/core.ts", "export const value = 0;\n");
  write("package.json", "{}\n");
  write("package-lock.json", "{}\n");
  write("AGENTS.md", "# Architecture\n");
  write("scripts/lane-check.sh", guard);
  write("scripts/turn-snapshot.sh", snap);
  write("scripts/fixture-snapshot.cjs", snapJS);
  write("scripts/verify-handoff.mjs", "// fixture only\n");
  write("scripts/memory-append-only.sh", "# fixture only\n");
  for (const role of [
    "test-engineer",
    "software-engineer",
    "groundwork-engineer",
    "reviewer-engineer",
  ])
    write(`.claude/agents/${role}.md`, `# fixture ${role}\n`);
  cmd(root, "init", "-q");
  cmd(root, "add", ".");
  // -c keeps the identity on the invocation. `git config` would write it into
  // whatever repository an ambient GIT_DIR names, which is not this fixture.
  cmd(
    root,
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "user.name=Fixture",
    "commit",
    "-qm",
    "baseline",
  );
  cmd(root, "config", "user.email", "fixture@example.invalid");
  cmd(root, "config", "user.name", "Fixture");
  const base = cmd(root, "rev-parse", "HEAD");
  t.after(() => {
    for (const p of extra) fs.rmSync(p, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  });
  if (options.setup)
    options.setup({ root, write, base, cmd: (...a) => cmd(root, ...a) });
  const opened = main([
    "open",
    "--root",
    root,
    "--epic",
    epicRel,
    "--max-turns",
    String(options.maxTurns ?? 128),
    ...(options.adopt ? ["--adopt-legacy"] : []),
  ]);
  const sp = opened.session;
  if (sp) extra.push(path.dirname(sp));
  const exec = (command, ...args) => main([command, "--session", sp, ...args]);
  const scratch = (name, data) => {
    const p = path.join(path.dirname(sp), name);
    fs.writeFileSync(p, typeof data === "string" ? data : JSON.stringify(data));
    return p;
  };
  function begin(role, meta) {
    return exec(
      "begin",
      "--role",
      role,
      ...(meta ? ["--meta", scratch(`${cryptoName()}.json`, meta)] : []),
    );
  }
  function append(b, block, changes = {}) {
    for (const [p, v] of Object.entries(changes)) write(p, v);
    fs.writeFileSync(b.draft, block);
    fs.appendFileSync(b.discussion, block);
  }
  const assess = (b, block, cases = []) =>
    scratch(`${cryptoName()}.json`, {
      turn: b.turn,
      cases,
      evidence: block.split("\n")[0],
    });
  const finishWorker = (b, block, cases = []) =>
    exec("finish", "--assessment", assess(b, block, cases));
  function worker(role, text = "", changes = {}) {
    const b = begin(role),
      block = turn(role, text);
    append(b, block, changes);
    return { ...b, result: finishWorker(b, block) };
  }
  function closeStory(stem = "01-core", cases = ["01-core#V1"], changes) {
    const b = begin("test-engineer"),
      block = turn(
        "test-engineer",
        `**Story closed.** ${stem}\npnpm test\nexit 0\nTESTS OK\nSTORY-COMPLETE: ${stem} — cases: ${cases.join(", ")}`,
      );
    append(b, block, changes ?? { "src/core.test.ts": `// ${stem}\n` });
    finishWorker(b, block, cases);
    return { b, block };
  }
  function commitStory(stem = "01-core", overrides = {}) {
    const turnId =
      overrides.turn ??
      parseDiscussion(
        fs.readFileSync(path.join(root, opened.discussion), "utf8"),
      ).turns.at(-1).turn;
    return exec(
      "commit",
      "--story",
      stem,
      "--assessment",
      scratch(`${cryptoName()}.json`, {
        turn: turnId,
        story: stem,
        storyGateSource: section(story, "Verify"),
        required: ["pnpm test"],
        checks: [
          {
            command: "pnpm test",
            exit: 0,
            output: "TESTS OK",
            evidence: "pnpm test\nexit 0\nTESTS OK",
          },
        ],
        ...overrides,
      }),
    );
  }
  return {
    root,
    sp,
    base,
    write,
    opened,
    exec,
    scratch,
    begin,
    append,
    worker,
    assess,
    finishWorker,
    closeStory,
    commitStory,
    cmd: (...a) => cmd(root, ...a),
    extra,
  };
}
function cryptoName() {
  return String(Math.random()).slice(2);
}
function makeReady(f) {
  f.closeStory();
  f.commitStory();
  const b = f.begin("test-engineer");
  const block = turn(
    "test-engineer",
    "**Cases closed.** 01-core#V1\n**EPIC verification gate.**\npnpm run verify\nexit 0\nVERIFY OK\n**Proof.**\nnode scripts/proof.mjs\nexit 0\nPROOF OK\nIMPLEMENTATION_READY_FOR_REVIEW:\n- gates: PASS\n- proof: PASS\n- stories: 1/1 complete",
  );
  f.append(b, block);
  f.finishWorker(b, block, ["01-core#V1"]);
  const assessment = {
    turn: b.turn,
    obligationsReviewed: true,
    unresolved: [],
    sourceCoverageReviewed: true,
    storyGatesReviewed: true,
    gateSource: gate,
    cases: ["01-core#V1"],
    gates: [
      {
        command: "pnpm run verify",
        exit: 0,
        output: "VERIFY OK",
        evidence: "pnpm run verify\nexit 0\nVERIFY OK",
      },
    ],
    proof: {
      command: "node scripts/proof.mjs",
      exit: 0,
      output: "PROOF OK",
      evidence: "node scripts/proof.mjs\nexit 0\nPROOF OK",
      success: "PROOF OK",
    },
  };
  f.exec("ready", "--assessment", f.scratch("ready.json", assessment));
  return { b, assessment, block };
}
function report(blockers = [], suggestions = []) {
  const rows = (a) =>
    a
      .map(
        (x) =>
          `| ${x[0]} | action:${x[1]} | src/core.ts:1 | Safety | ${x[2]} | story:1 | ${x[3] ?? "Restore required behavior"} |`,
      )
      .join("\n");
  return `## Code Review — demo\n\n### Summary\nVerdict: ${blockers.length ? "FAIL" : "PASS"}\n\n### Verification evidence\n| Check | Command | Exit | Output |\n| Gates | pnpm run verify | 0 | OK |\n| Proof | node scripts/proof.mjs | 0 | PROOF OK |\n\n### Blockers\n| # | Action | File:Line | Dimension | Issue | Cited source | Fix |\n|---|---|---|---|---|---|---|\n${rows(blockers)}\n\n### Suggestions\n| # | Action | File:Line | Dimension | Issue | Cited source | Fix |\n|---|---|---|---|---|---|---|\n${rows(suggestions)}\n\n### Per-file verdicts\n| Path | Verdict | Evidence |\n| src/core.ts | PASS | inspected |\n\n### Acceptance criteria coverage\n| AC | Status | Evidence |\n| 01-core#V1 | COVERED | check |\n`;
}

// These are deterministic parser/runtime tests. No model, actual project guards or TDD workload is exercised.
test("case IDs containing hyphens remain whole", () => {
  const st = parseDiscussion(
    H + turn("test-engineer", "ATTEMPT-FAILED: 01-create-user#V1 — no seam"),
  );
  assert.equal(st.attempts[0].caseId, "01-create-user#V1");
});
test("fenced log markers have no control authority", () => {
  const st = parseDiscussion(
    H +
      turn(
        "test-engineer",
        "```text\nHUMAN_REVIEW: PASS\nIMPLEMENTATION_READY_FOR_REVIEW:\nATTEMPT-FAILED: fake#V1 — log\n```",
      ),
  );
  assert.equal(st.human, "pending");
  assert.equal(st.readyTurn, null);
  assert.equal(st.attempts.length, 0);
});
test("longer nested Markdown fences preserve literal marker samples", () => {
  const a = lex(
    "````text\n```\nHUMAN_REVIEW: PASS\n```\n````\nHUMAN_REVIEW: FAIL\n",
  );
  assert.deepEqual(
    a.filter((l) => l.active && l.s.startsWith("HUMAN")).map((l) => l.s),
    ["HUMAN_REVIEW: FAIL"],
  );
});
test("groundwork is invisible to engineer alternation", () => {
  const st = parseDiscussion(
    H + turn("test-engineer") + turn("groundwork-engineer"),
  );
  assert.equal(st.next, "software-engineer");
});
test("TE always opens after a human review failure", () => {
  assert.equal(
    parseDiscussion(
      H +
        turn("test-engineer") +
        "HUMAN_REVIEW: FAIL\n" +
        turn("groundwork-engineer"),
    ).next,
    "test-engineer",
  );
});
test("TE always opens after automatic review failure", () => {
  assert.equal(
    parseDiscussion(H + turn("test-engineer") + "AUTO_REVIEW: FAIL\n").next,
    "test-engineer",
  );
});
test("ready before review failure is stale", () => {
  assert.equal(
    parseDiscussion(
      H +
        turn("test-engineer", "IMPLEMENTATION_READY_FOR_REVIEW:") +
        "AUTO_REVIEW: FAIL\n",
    ).readyTurn,
    null,
  );
});
test("worker activity after ready invalidates the old marker", () => {
  assert.equal(
    parseDiscussion(
      H +
        turn("test-engineer", "IMPLEMENTATION_READY_FOR_REVIEW:") +
        turn("software-engineer"),
    ).readyTurn,
    null,
  );
});
test("ordinary failures deduplicate repeated case markers in one turn", () => {
  const st = parseDiscussion(
    H +
      turn(
        "test-engineer",
        "ATTEMPT-FAILED: 01-core#V1 — one\nATTEMPT-FAILED: 01-core#V1 — two",
      ),
  );
  assert.equal(st.counts["01-core#V1"].count, 1);
});
test("a batch counts failures for every affected case, not just the last", () => {
  const st = parseDiscussion(
    H +
      turn(
        "test-engineer",
        "ATTEMPT-FAILED: 01-core#V1 — one\nATTEMPT-FAILED: 01-core#V2 — two",
      ),
  );
  assert.equal(st.counts["01-core#V1"].count, 1);
  assert.equal(st.counts["01-core#V2"].count, 1);
});
test("guideline resets only its own case budget", () => {
  const st = parseDiscussion(
    H +
      turn(
        "test-engineer",
        "ATTEMPT-FAILED: 01-core#V1 — a\nATTEMPT-FAILED: 01-core#V2 — b",
      ) +
      "DEBATE_GUIDELINE: 01-core#V1 — fix\nGUIDELINE: src/core.ts:1 change\n" +
      turn("software-engineer", "ATTEMPT-FAILED: 01-core#V1 — c"),
  );
  assert.equal(st.counts["01-core#V1"].count, 1);
  assert.equal(st.counts["01-core#V2"].count, 1);
});
test("new review failure resets old attempt and guideline scope", () => {
  const st = parseDiscussion(
    H +
      "DEBATE_GUIDELINE: 01-core#V1 — fix\nGUIDELINE: src/core.ts:1\n" +
      turn("software-engineer", "ATTEMPT-FAILED: 01-core#V1 — failed") +
      "HUMAN_REVIEW: FAIL\n" +
      turn("test-engineer", "ATTEMPT-FAILED: 01-core#V1 — again"),
  );
  assert.equal(st.counts["01-core#V1"].count, 1);
  assert.equal(st.counts["01-core#V1"].guide, null);
});
test("resume enumerates all outstanding OOL requests", () => {
  const st = parseDiscussion(
    H +
      turn(
        "test-engineer",
        "OPEN: OUT-OF-LANE — package.json — add entry\nOPEN: OUT-OF-LANE — settings.json — add setting",
      ),
  );
  assert.equal(st.requests.length, 2);
  assert.deepEqual(
    st.requests.map((r) => r.path),
    ["package.json", "settings.json"],
  );
});
test("consumption keys on request identity rather than path substrings", () => {
  const text =
    H + turn("test-engineer", "OPEN: OUT-OF-LANE — settings.json — first");
  const id = parseDiscussion(text).requests[0].id;
  const st = parseDiscussion(
    text +
      `GROUNDWORK-COMPLETE: ${id} — ["settings.json"]\n` +
      turn("software-engineer", "OPEN: OUT-OF-LANE — settings.json — second"),
  );
  assert.equal(st.requests.length, 1);
  assert.equal(st.requests[0].instruction, "second");
});
test("JSON paths preserve spaces and regex metacharacters", () => {
  assert.deepEqual(parsePaths('["settings [x].json","a b"]'), [
    "settings [x].json",
    "a b",
  ]);
});
test("legacy path lists and explicit quotes are accepted without shell execution", () => {
  assert.deepEqual(parsePaths('package.json "a b" c.json'), [
    "package.json",
    "a b",
    "c.json",
  ]);
});
for (const p of [
  "../outside",
  "/etc/file",
  "a/../b",
  "a//b",
  ".git/config",
  "bad\tpath",
  "bad\npath",
])
  test(`unsafe path rejected: ${JSON.stringify(p)}`, () =>
    assert.throws(() => repoPath(p)));
test("groundwork Paths supports JSON inline and one-path-per-line blocks", () => {
  assert.deepEqual(groundworkPaths('Paths: ["package.json","a b"]\n'), [
    "package.json",
    "a b",
  ]);
  assert.deepEqual(
    groundworkPaths("Paths:\n- `package.json`\n- `a b`\n\n## Change\n"),
    ["package.json", "a b"],
  );
});
test("empty groundwork Paths fails rather than silently skipping it", () =>
  assert.throws(() => groundworkPaths("Paths:\n\n## Change\n")));
test("two-sided fingerprint delta catches dirty-to-dirty edits, deletions and reverts", () => {
  assert.deepEqual(
    delta(
      { "a b": "1", deleted: "2", reverted: "3" },
      { "a b": "4", deleted: "ABSENT", new: "5" },
    ),
    ["a b", "deleted", "new", "reverted"],
  );
});
test("snapshot path spaces are preserved", () =>
  assert.equal(
    snapshotParse("a".repeat(40) + "\ta b.ts\n")["a b.ts"],
    "a".repeat(40),
  ));
test("malformed or duplicate snapshot entries fail closed", () => {
  assert.throws(() => snapshotParse("broken"));
  assert.throws(() => snapshotParse(("a".repeat(40) + "\ta\n").repeat(2)));
});
test("same-role TE append is valid after a review failure", () => {
  const p = H + turn("test-engineer") + "HUMAN_REVIEW: FAIL\n",
    d = turn("test-engineer", "repair");
  assert.equal(validateAppend(p, p + d, d, "test-engineer"), d);
});
test("same-role groundwork retry append is valid", () => {
  const p = H + turn("groundwork-engineer"),
    d = turn("groundwork-engineer", "retry");
  assert.equal(validateAppend(p, p + d, d, "groundwork-engineer"), d);
});
for (const [label, mutate] of [
  ["prefix rewrite", (p, d) => p.replace("opened:", "changed:") + d],
  ["double append", (p, d) => p + d + d],
  ["missing append", (p) => p],
  ["extra trailing output", (p, d) => p + d + "extra\n"],
])
  test(`turn validation rejects ${label}`, () => {
    const d = turn("test-engineer");
    assert.throws(() => validateAppend(H, mutate(H, d), d, "test-engineer"));
  });
test("wrong END role and multiple END markers are rejected", () => {
  for (const d of [
    turn("software-engineer"),
    turn("test-engineer") + "END: TEST-ENGINEER\n",
  ])
    assert.throws(() => validateAppend(H, H + d, d, "test-engineer"));
});
test("workers cannot forge human verdicts, controller receipts or completion", () => {
  for (const marker of [
    "HUMAN_REVIEW: PASS",
    'GROUNDWORK-COMPLETE: x — ["a"]',
    "WORK-EVENT: {}",
    "AUTO_REVIEW: FAIL",
  ]) {
    const d = turn("test-engineer", marker);
    assert.throws(() => validateAppend(H, H + d, d, "test-engineer"));
  }
});
test("groundwork and SE cannot emit readiness", () => {
  for (const r of ["software-engineer", "groundwork-engineer"]) {
    const d = turn(r, "IMPLEMENTATION_READY_FOR_REVIEW:");
    assert.throws(() => validateAppend(H, H + d, d, r));
  }
});
test("absence of failure markers does not prove groundwork success", () =>
  assert.throws(() =>
    validateGroundwork(turn("groundwork-engineer", "done"), { id: "x" }, null),
  ));
test("positive groundwork requires every planned check and path evidence", () => {
  const req = { id: "x", paths: ["a b"], checks: ["pnpm run typecheck"] };
  const block = turn(
    "groundwork-engineer",
    "**Result.** PASS\nupdated a b\npnpm run typecheck\nexit 0\nTYPE OK",
  );
  const a = {
    request: "x",
    instructionSatisfied: true,
    applied: [{ path: "a b", evidence: "updated a b" }],
    checks: [
      {
        command: "pnpm run typecheck",
        exit: 0,
        output: "TYPE OK",
        evidence: "pnpm run typecheck\nexit 0\nTYPE OK",
      },
    ],
  };
  assert.equal(validateGroundwork(block, req, a), true);
  assert.throws(() => validateGroundwork(block, req, { ...a, checks: [] }));
});
test("groundwork success with OPEN remains invalid", () =>
  assert.throws(() =>
    validateGroundwork(
      turn("groundwork-engineer", "**Result.** PASS\nOPEN: pending"),
      { id: "x" },
      {},
    ),
  ));
test("explicit BLOCKED with a failure remains retryable, not completed", () =>
  assert.equal(
    validateGroundwork(
      turn(
        "groundwork-engineer",
        "**Result.** BLOCKED\nOPEN: fail\nATTEMPT-FAILED: OOL-1 — fail",
      ),
      { id: "OOL-1" },
      null,
    ),
    false,
  ));
test("review action:NO retains BLOCKER severity", () => {
  const x = parseReview(
    report([["B1", "NO", "NEEDS-HUMAN: choose architecture"]]),
  );
  assert.equal(x.findings[0].severity, "BLOCKER");
  assert.equal(x.findings[0].action, "NO");
});
test("review suggestions can be mechanical without becoming severity blockers", () => {
  const x = parseReview(
    report([], [["S1", "YES", "Simplify equivalent branch"]]),
  );
  assert.equal(x.findings[0].severity, "SUGGESTION");
  assert.equal(x.findings[0].action, "YES");
});
test("malformed verdict/action/citation/duplicate finding IDs fail closed", () => {
  const good = report([["B1", "YES", "bug"]]);
  assert.throws(() =>
    parseReview(good.replace("Verdict: FAIL", "Verdict: PASS")),
  );
  assert.throws(() => parseReview(good.replace("action:YES", "maybe")));
  assert.throws(() => parseReview(good.replace("story:1", "")));
  assert.throws(() =>
    parseReview(
      report([
        ["B1", "YES", "one"],
        ["B1", "NO", "two"],
      ]),
    ),
  );
});

test("open discovers an unfinished discussion on an earlier date", (t) => {
  const f = fixture(t, {
    setup: ({ write, base }) =>
      write(
        ".agents/tdd/history/2026-01-01-001-demo.md",
        H.replace("a".repeat(40), base),
      ),
  });
  assert.equal(
    f.opened.discussion,
    ".agents/tdd/history/2026-01-01-001-demo.md",
  );
});
test("same EPIC cannot start a second concurrent session", (t) => {
  const f = fixture(t);
  assert.throws(
    () => main(["open", "--root", f.root, "--epic", epicRel]),
    /locked/,
  );
});
test("different EPICs sharing a worktree cannot overlap snapshots", (t) => {
  const f = fixture(t);
  f.write(
    ".agents/plan/epics/002-other.md",
    "# Other\n\n## Verification Gate\nGates: x\nProof: y\n",
  );
  assert.throws(
    () =>
      main([
        "open",
        "--root",
        f.root,
        "--epic",
        ".agents/plan/epics/002-other.md",
      ]),
    /locked/,
  );
});
test("ambiguous open histories require explicit selection", (t) => {
  const f = fixture(t);
  f.exec("close");
  const existing = fs.readFileSync(
    path.join(f.root, f.opened.discussion),
    "utf8",
  );
  f.write(".agents/tdd/history/2020-01-01-001-demo.md", existing);
  assert.throws(() => findDiscussion(f.root, epicRel), /multiple/);
});
test("closed lifecycle stops without dispatch or reseeding", (t) => {
  const f = fixture(t);
  fs.appendFileSync(
    path.join(f.root, f.opened.discussion),
    "HUMAN_REVIEW: PASS\n",
  );
  f.exec("close");
  assert.equal(
    main(["open", "--root", f.root, "--epic", epicRel]).status,
    "already-closed",
  );
});
test("legacy histories require explicit, recorded adoption", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-case-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // Discovery recognizes legacy turns; open-session consent is covered by the separate fixture below.
  fs.mkdirSync(path.join(root, ".agents/tdd/history"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".agents/tdd/history/old.md"),
    H + turn("test-engineer"),
  );
  assert.equal(findDiscussion(root, epicRel), ".agents/tdd/history/old.md");
});
test("explicit legacy adoption records the original prefix hash", (t) => {
  const f = fixture(t, {
    adopt: true,
    setup: ({ write, base }) =>
      write(
        ".agents/tdd/history/old.md",
        H.replace("a".repeat(40), base) + turn("test-engineer"),
      ),
  });
  const st = parseDiscussion(
    fs.readFileSync(path.join(f.root, f.opened.discussion), "utf8"),
  );
  assert.ok(st.events.some((e) => e.type === "legacy-adopted" && e.prefixHash));
  assert.equal(f.exec("state").nextRole, "software-engineer");
});
test("ordinary worker finish validates lane and exact append", (t) => {
  const f = fixture(t);
  const b = f.worker("test-engineer", "RED for 01-core#V1", {
    "src/core.test.ts": "test fixture\n",
  });
  assert.equal(b.result.status, "accepted");
  assert.equal(fs.existsSync(b.draft), false);
  assert.equal(f.exec("state").nextRole, "software-engineer");
});
test("max-turn cap is charged before dispatch and never reset by review failures", (t) => {
  const f = fixture(t, { maxTurns: 1 });
  f.worker("test-engineer");
  fs.appendFileSync(
    path.join(f.root, f.opened.discussion),
    "HUMAN_REVIEW: FAIL\nBLOCKER: fix\n",
  );
  assert.equal(f.exec("state").turns, 1);
  assert.throws(() => f.begin("test-engineer"), /max-turns/);
});
test("zero max-turns permits multiple dispatches", (t) => {
  const f = fixture(t, { maxTurns: 0 });
  f.worker("test-engineer");
  f.worker("software-engineer");
  assert.equal(f.exec("state").turns, 2);
});
test("actual same-role TE after review failure succeeds with no ready marker", (t) => {
  const f = fixture(t);
  f.worker("test-engineer");
  fs.appendFileSync(
    path.join(f.root, f.opened.discussion),
    "HUMAN_REVIEW: FAIL\nBLOCKER: regression\n",
  );
  assert.equal(
    f.worker("test-engineer", "new regression").result.status,
    "accepted",
  );
});
test("out-of-lane dirty-to-dirty edit is caught and evidence remains", (t) => {
  const f = fixture(t);
  f.write("src/core.ts", "already dirty\n");
  const b = f.begin("test-engineer");
  f.append(b, turn("test-engineer"), { "src/core.ts": "edited again\n" });
  assert.throws(() => f.exec("finish"), /lane violation/);
  assert.ok(fs.existsSync(b.draft));
  assert.equal(f.exec("state").pending.length, 1);
});
test("out-of-lane revert to HEAD is caught", (t) => {
  const f = fixture(t);
  f.write("src/core.ts", "dirty\n");
  const b = f.begin("test-engineer");
  f.append(b, turn("test-engineer"), {
    "src/core.ts": "export const value = 0;\n",
  });
  assert.throws(() => f.exec("finish"), /lane violation/);
});
test("another role draft is not a general .agents/tdd exception", (t) => {
  const f = fixture(t);
  const b = f.begin("test-engineer");
  f.append(b, turn("test-engineer"), {
    ".agents/tdd/.software-engineer-response-other.md": "forged\n",
  });
  assert.throws(() => f.exec("finish"), /non-owned protocol path/);
});
test("a plain worker turn is accepted", (t) => {
  const f = fixture(t);
  assert.equal(
    f.worker("test-engineer", "RED for 01-core#V1").result.status,
    "accepted",
  );
});
test("git staging is rejected even when file edits are in lane", (t) => {
  const f = fixture(t);
  const b = f.begin("test-engineer");
  f.append(b, turn("test-engineer"), { "src/core.test.ts": "x\n" });
  cmd(f.root, "add", "src/core.test.ts");
  assert.throws(() => f.exec("finish"), /git HEAD\/branch\/index/);
});
test("pending dispatch cannot be closed or bypassed", (t) => {
  const f = fixture(t);
  f.begin("test-engineer");
  assert.throws(() => f.exec("close"), /in-flight/);
  assert.throws(() => f.begin("test-engineer"), /in flight/);
});
test("restart before finish can validate the saved evidence without redispatch", (t) => {
  const f = fixture(t),
    b = f.begin("test-engineer"),
    block = turn("test-engineer", "interrupted after append");
  f.append(b, block);
  assert.equal(main(["state", "--session", f.sp]).pending.length, 1);
  assert.equal(
    main(["finish", "--session", f.sp, "--assessment", f.assess(b, block)])
      .status,
    "accepted",
  );
});
test("missing before-turn evidence fails closed", (t) => {
  const f = fixture(t);
  const b = f.begin("test-engineer");
  f.append(b, turn("test-engineer"));
  fs.unlinkSync(b.before);
  assert.throws(() => f.exec("finish"), /ENOENT/);
});
test("rejected/abandoned worker markers never become accepted state", (t) => {
  const f = fixture(t);
  const b = f.begin("test-engineer");
  f.append(b, turn("test-engineer", "IMPLEMENTATION_READY_FOR_REVIEW:"));
  assert.equal(f.exec("state").readyCandidate, null);
  f.exec(
    "abandon",
    "--confirm-idle",
    "--human-reason",
    "operator reviewed rejected changes",
  );
  assert.equal(f.exec("state").readyCandidate, null);
  assert.equal(f.exec("state").nextRole, "test-engineer");
});
test("accepted turn hash detects a later rewrite of its content", (t) => {
  const f = fixture(t);
  f.worker("test-engineer", "original wording");
  const p = path.join(f.root, f.opened.discussion);
  fs.writeFileSync(
    p,
    fs.readFileSync(p, "utf8").replace("original wording", "altered wording"),
  );
  assert.throws(() => f.exec("state"), /content changed/);
});
test("ready validation requires all exact case IDs and actual supplied transcript evidence", (t) => {
  const f = fixture(t);
  const r = makeReady(f);
  assert.equal(f.exec("state").validReady, true);
  assert.throws(
    () =>
      f.exec(
        "ready",
        "--assessment",
        f.scratch("bad-ready.json", { ...r.assessment, cases: [] }),
      ),
    /case set/,
  );
});
test("skipped/nonzero/missing-sentinel Proof cannot validate readiness", (t) => {
  const f = fixture(t);
  const r = makeReady(f);
  for (const proof of [
    { ...r.assessment.proof, exit: 1 },
    { ...r.assessment.proof, output: "" },
    { ...r.assessment.proof, success: "MISSING" },
  ]) {
    assert.throws(() =>
      f.exec(
        "ready",
        "--assessment",
        f.scratch(`${cryptoName()}.json`, { ...r.assessment, proof }),
      ),
    );
  }
});
test("working-tree changes invalidate accepted readiness", (t) => {
  const f = fixture(t);
  makeReady(f);
  f.write("src/core.ts", "changed after proof\n");
  assert.equal(f.exec("state").validReady, false);
  assert.throws(() => f.begin("reviewer-engineer"), /validated readiness/);
});
test("review scope includes tracked edits, deleted paths and untracked files", (t) => {
  const f = fixture(t);
  f.write("src/core.ts", "changed\n");
  f.write("src/new thing.ts", "new\n");
  fs.unlinkSync(path.join(f.root, "package-lock.json"));
  const scope = f.exec("scope").files;
  for (const p of ["src/core.ts", "src/new thing.ts", "package-lock.json"])
    assert.ok(scope.includes(p));
});
test("reviewer mutation is rejected before recording a verdict", (t) => {
  const f = fixture(t);
  makeReady(f);
  f.begin("reviewer-engineer");
  f.write("src/core.ts", "reviewer illegally changed\n");
  assert.throws(
    () => f.exec("finish", "--report", f.scratch("report.md", report())),
    /read-only/,
  );
});
test("no-action review is persisted and reused after reopen", (t) => {
  const f = fixture(t);
  makeReady(f);
  f.begin("reviewer-engineer");
  const done = f.exec("finish", "--report", f.scratch("report.md", report()));
  assert.equal(done.status, "awaiting-human-review");
  assert.ok(f.exec("state").currentReview);
  f.exec("close");
  const opened = main(["open", "--root", f.root, "--epic", epicRel]);
  f.extra.push(path.dirname(opened.session));
  assert.ok(main(["state", "--session", opened.session]).currentReview);
});
test("action:NO blockers remain mandatory and do not trigger automatic repair", (t) => {
  const f = fixture(t);
  makeReady(f);
  f.begin("reviewer-engineer");
  const result = f.exec(
    "finish",
    "--report",
    f.scratch(
      "report.md",
      report([["B1", "NO", "NEEDS-HUMAN: design decision"]]),
    ),
  );
  assert.equal(result.status, "awaiting-human-review");
  const st = f.exec("state");
  assert.equal(st.autoUsed, false);
  assert.equal(st.currentReview.findings[0].severity, "BLOCKER");
});
test("automatic findings route once, preserve severity and force TE first", (t) => {
  const f = fixture(t);
  makeReady(f);
  f.begin("reviewer-engineer");
  f.exec(
    "finish",
    "--report",
    f.scratch(
      "report.md",
      report(
        [
          ["B1", "YES", "fix bug"],
          ["B2", "NO", "NEEDS-HUMAN: choose policy"],
        ],
        [["S1", "YES", "simplify"]],
      ),
    ),
  );
  const st = f.exec("state");
  assert.equal(st.autoUsed, true);
  assert.equal(st.nextRole, "test-engineer");
  assert.equal(st.turns, 3);
  assert.equal(
    st.reviews[0].findings.find((x) => x.id === "S1").severity,
    "SUGGESTION",
  );
  assert.equal(st.validReady, false);
});
test("groundwork request grants package.json plus only the specified companion lockfile", (t) => {
  const f = fixture(t);
  f.worker(
    "test-engineer",
    "OPEN: OUT-OF-LANE — package.json — add exact script\nATTEMPT-FAILED: 01-core#V1 — blocked",
  );
  const req = f.exec("state").requests[0];
  assert.deepEqual(req.grant, ["package.json", "package-lock.json"]);
  assert.equal(f.exec("state").counts["01-core#V1"].count, 0);
  assert.throws(
    () =>
      f.begin("groundwork-engineer", {
        request: {
          id: req.id,
          sourceFile: storyRel,
          instruction: req.instruction,
          paths: ["package.json", "package-lock.json", "settings.json"],
          cases: [],
          checks: ["pnpm run typecheck"],
        },
      }),
    /grant differs/,
  );
});
test("a false out-of-lane claim still counts as an ordinary failed attempt", (t) => {
  const f = fixture(t);
  f.worker(
    "test-engineer",
    "OPEN: OUT-OF-LANE — src/core.ts — change\nATTEMPT-FAILED: 01-core#V1 — failed",
  );
  const st = f.exec("state");
  assert.equal(st.requests[0].route, "engineer-owned");
  assert.equal(st.counts["01-core#V1"].count, 1);
});
test("fully locked path is a human escalation without consuming debate attempts", (t) => {
  const f = fixture(t);
  f.worker(
    "test-engineer",
    "OPEN: OUT-OF-LANE — scripts/lane-check.sh — change guard\nATTEMPT-FAILED: 01-core#V1 — locked",
  );
  assert.equal(f.exec("state").requests[0].route, "human-locked");
  assert.equal(f.exec("state").counts["01-core#V1"].count, 0);
});
test("positive groundwork completion is recorded with its accepted turn, then request disappears", (t) => {
  const f = fixture(t);
  f.worker(
    "test-engineer",
    "OPEN: OUT-OF-LANE — settings with space.json — set exact value\nATTEMPT-FAILED: 01-core#V1 — blocked",
  );
  const req = f.exec("state").requests[0],
    b = f.begin("groundwork-engineer", {
      request: {
        id: req.id,
        sourceFile: storyRel,
        instruction: req.instruction,
        paths: req.grant,
        cases: [],
        checks: ["pnpm run typecheck"],
      },
    });
  f.append(
    b,
    turn(
      "groundwork-engineer",
      "**Result.** PASS\n**Applied.** set exact value\n**Checks.** pnpm run typecheck\nexit 0\nTYPE OK",
    ),
    { "settings with space.json": '{"value":1}\n' },
  );
  const a = {
    request: req.id,
    instructionSatisfied: true,
    applied: [{ path: req.path, evidence: "set exact value" }],
    checks: [
      {
        command: "pnpm run typecheck",
        exit: 0,
        output: "TYPE OK",
        evidence: "pnpm run typecheck\nexit 0\nTYPE OK",
      },
    ],
  };
  assert.equal(
    f.exec("finish", "--assessment", f.scratch("ground.json", a)).status,
    "groundwork-complete",
  );
  const st = f.exec("state");
  assert.equal(st.requests.length, 0);
  assert.equal(st.nextRole, "software-engineer");
  assert.deepEqual(st.completions[0].paths, [req.path]);
});
test("groundwork missing grant cannot write another protocol file", (t) => {
  const f = fixture(t);
  f.worker(
    "test-engineer",
    "OPEN: OUT-OF-LANE — settings.json — exact edit\nATTEMPT-FAILED: 01-core#V1 — blocked",
  );
  const req = f.exec("state").requests[0],
    b = f.begin("groundwork-engineer", {
      request: {
        id: req.id,
        sourceFile: storyRel,
        instruction: req.instruction,
        paths: req.grant,
        cases: [],
        checks: ["pnpm run typecheck"],
      },
    });
  f.append(
    b,
    turn(
      "groundwork-engineer",
      "**Result.** BLOCKED\nOPEN: blocked\nATTEMPT-FAILED: " +
        req.id +
        " — blocked",
    ),
    { ".agents/tdd/other.md": "illegal\n" },
  );
  assert.throws(() => f.exec("finish"), /non-owned protocol path/);
  assert.equal(f.exec("state").completions.length, 0);
});
test("three groundwork failures stop before a fourth retry, with no debate", (t) => {
  const f = fixture(t);
  f.worker(
    "test-engineer",
    "OPEN: OUT-OF-LANE — settings.json — exact edit\nATTEMPT-FAILED: 01-core#V1 — blocked",
  );
  const req = f.exec("state").requests[0],
    meta = {
      request: {
        id: req.id,
        sourceFile: storyRel,
        instruction: req.instruction,
        paths: req.grant,
        cases: [],
        checks: ["pnpm run typecheck"],
      },
    };
  for (let i = 0; i < 3; i++) {
    const b = f.begin("groundwork-engineer", meta);
    f.append(
      b,
      turn(
        "groundwork-engineer",
        "**Result.** BLOCKED\nOPEN: failed\nATTEMPT-FAILED: " +
          req.id +
          " — failed",
      ),
    );
    f.exec("finish");
  }
  assert.equal(f.exec("state").requests[0].failures, 3);
  assert.throws(() => f.begin("groundwork-engineer", meta), /exhausted/);
});
test("pre-loop groundwork consumes exact Paths and recognizes changed source revisions", (t) => {
  const f = fixture(t);
  const p = ".agents/plan/stories/001-demo/00-groundwork.md";
  const text =
    '# Ground\nExecutor: groundwork-engineer\nPaths: ["settings.json"]\n\n## Change\nSet exact value.\n\n## Verify\n1. `pnpm run typecheck` exits zero.\n';
  f.write(p, text);
  const initial = f.exec("state").groundwork;
  assert.deepEqual(initial.grant, ["settings.json"]);
  const meta = {
    request: {
      id: "00-groundwork",
      sourceFile: p,
      instruction: section(text, "Change"),
      paths: initial.grant,
      cases: ["00-groundwork#V1"],
      checks: ["pnpm run typecheck"],
    },
  };
  const b = f.begin("groundwork-engineer", meta);
  f.append(
    b,
    turn(
      "groundwork-engineer",
      "**Result.** PASS\n**Applied.** Set exact value.\npnpm run typecheck\nexit 0\nTYPE OK",
    ),
    { "settings.json": "{}\n" },
  );
  f.exec(
    "finish",
    "--assessment",
    f.scratch("assessment.json", {
      request: "00-groundwork",
      instructionSatisfied: true,
      applied: [{ path: "settings.json", evidence: "Set exact value." }],
      checks: [
        {
          command: "pnpm run typecheck",
          exit: 0,
          output: "TYPE OK",
          evidence: "pnpm run typecheck\nexit 0\nTYPE OK",
        },
      ],
    }),
  );
  assert.deepEqual(f.exec("state").groundwork.grant, []);
  f.write(p, text.replace("Set exact value.", "Set a different exact value."));
  assert.deepEqual(f.exec("state").groundwork.grant, ["settings.json"]);
});
test("symlink-mediated groundwork targets are rejected before dispatch", (t) => {
  const f = fixture(t);
  f.worker(
    "test-engineer",
    "OPEN: OUT-OF-LANE — settings.json — exact edit\nATTEMPT-FAILED: 01-core#V1 — blocked",
  );
  const req = f.exec("state").requests[0];
  fs.symlinkSync("package.json", path.join(f.root, "settings.json"));
  assert.throws(
    () =>
      f.begin("groundwork-engineer", {
        request: {
          id: req.id,
          sourceFile: storyRel,
          instruction: req.instruction,
          paths: req.grant,
          cases: [],
          checks: ["pnpm run typecheck"],
        },
      }),
    /symlink/,
  );
});
test("debate requires three ordinary failures and gets only one guideline per cycle", (t) => {
  const f = fixture(t);
  assert.throws(
    () => f.begin("debate", { caseId: "01-core#V1" }),
    /three failures/,
  );
  f.worker("test-engineer", "ATTEMPT-FAILED: 01-core#V1 — blocked");
  f.worker("software-engineer", "ATTEMPT-FAILED: 01-core#V1 — blocked");
  f.worker("test-engineer", "ATTEMPT-FAILED: 01-core#V1 — blocked");
  f.begin("debate", { caseId: "01-core#V1" });
  assert.equal(
    f.exec(
      "finish",
      "--assessment",
      f.scratch("guide.json", {
        caseId: "01-core#V1",
        summary: "existing seam fix",
        files: ["src/core.ts"],
        steps: ["src/core.ts:1 implement the specified return."],
      }),
    ).status,
    "guideline-issued",
  );
  assert.equal(f.exec("state").counts["01-core#V1"].count, 0);
  assert.equal(f.exec("state").nextRole, "software-engineer");
  assert.throws(
    () => f.begin("debate", { caseId: "01-core#V1" }),
    /no current-cycle guideline/,
  );
});
test("failed debate is durable and cannot be retried without a new review cycle", (t) => {
  const f = fixture(t);
  for (const role of ["test-engineer", "software-engineer", "test-engineer"])
    f.worker(role, "ATTEMPT-FAILED: 01-core#V1 — blocked");
  f.begin("debate", { caseId: "01-core#V1" });
  assert.equal(f.exec("finish").status, "human-escalation");
  assert.throws(
    () => f.begin("debate", { caseId: "01-core#V1" }),
    /already failed/,
  );
});

test("premature ready rejection sends TE, not an unassigned SE, to repair evidence", (t) => {
  const f = fixture(t);
  const r = makeReady(f);
  f.exec(
    "reject-ready",
    "--reason",
    "semantic review found an unproven obligation",
  );
  const st = f.exec("state");
  assert.equal(st.nextRole, "test-engineer");
  assert.equal(st.validReady, false);
  assert.throws(
    () =>
      f.exec("ready", "--assessment", f.scratch("again.json", r.assessment)),
    /fresh TE turn/,
  );
  assert.equal(
    f.worker("test-engineer", "repair the evidence gap").result.status,
    "accepted",
  );
});
test("cached no-action review cannot be redundantly dispatched", (t) => {
  const f = fixture(t);
  makeReady(f);
  f.begin("reviewer-engineer");
  f.exec("finish", "--report", f.scratch("r.md", report()));
  assert.throws(() => f.begin("reviewer-engineer"), /already recorded/);
});
test("review PASS cannot omit the required Proof row", (t) => {
  const f = fixture(t);
  makeReady(f);
  f.begin("reviewer-engineer");
  const r = report().replace(
    "| Proof | node scripts/proof.mjs | 0 | PROOF OK |\n",
    "",
  );
  assert.throws(
    () => f.exec("finish", "--report", f.scratch("r.md", r)),
    /independently account/,
  );
});
test("review PASS with missing Proof success output is rejected", (t) => {
  const f = fixture(t);
  makeReady(f);
  f.begin("reviewer-engineer");
  assert.throws(
    () =>
      f.exec(
        "finish",
        "--report",
        f.scratch(
          "r.md",
          report().replace("| 0 | PROOF OK |", "| 0 | not proved |"),
        ),
      ),
    /contradicts/,
  );
});
test("review NOT_RUN remains a mandatory human blocker rather than a passing result", (t) => {
  const f = fixture(t);
  makeReady(f);
  f.begin("reviewer-engineer");
  const r = report([
    ["B1", "NO", "NEEDS-HUMAN: command requires external credentials"],
  ]).replace("| 0 | PROOF OK |", "| NOT_RUN | credentials unavailable |");
  assert.equal(
    f.exec("finish", "--report", f.scratch("r.md", r)).status,
    "awaiting-human-review",
  );
  assert.equal(f.exec("state").currentReview.verdict, "FAIL");
});
test("reviewer and debate dispatches also spend the invocation cap", (t) => {
  const f = fixture(t, { maxTurns: 2 });
  makeReady(f);
  assert.throws(() => f.begin("reviewer-engineer"), /max-turns/);
});
test("a duplicate finish does not append a second completion or receipt", (t) => {
  const f = fixture(t);
  f.worker("test-engineer");
  const p = path.join(f.root, f.opened.discussion),
    before = fs.readFileSync(p, "utf8");
  assert.throws(() => f.exec("finish"), /in-flight/);
  assert.equal(fs.readFileSync(p, "utf8"), before);
});
test("a turn that crosses UTC midnight still finishes on its frozen paths", (t) => {
  const f = fixture(t),
    RealDate = Date;
  try {
    globalThis.Date = class extends RealDate {
      constructor(...a) {
        super(...(a.length ? a : ["2026-09-05T23:59:59Z"]));
      }
    };
    const b = f.begin("test-engineer");
    globalThis.Date = class extends RealDate {
      constructor(...a) {
        super(...(a.length ? a : ["2026-09-06T00:00:01Z"]));
      }
    };
    const block = turn("test-engineer");
    f.append(b, block);
    assert.equal(f.finishWorker(b, block).status, "accepted");
  } finally {
    globalThis.Date = RealDate;
  }
});
test("legacy adoption is refused without explicit permission", (t) => {
  const f = fixture(t);
  f.exec("close");
  f.write(
    f.opened.discussion,
    H.replace("a".repeat(40), f.base) + turn("test-engineer"),
  );
  assert.throws(
    () => main(["open", "--root", f.root, "--epic", epicRel]),
    /adopt-legacy/,
  );
});
test("three post-guideline failures lead to human state, never a second debate", (t) => {
  const f = fixture(t);
  for (const role of ["test-engineer", "software-engineer", "test-engineer"])
    f.worker(role, "ATTEMPT-FAILED: 01-core#V1 — blocked");
  f.begin("debate", { caseId: "01-core#V1" });
  f.exec(
    "finish",
    "--assessment",
    f.scratch("g.json", {
      caseId: "01-core#V1",
      summary: "fix existing seam",
      files: ["src/core.ts"],
      steps: ["src/core.ts:1 do the specified edit"],
    }),
  );
  for (const role of [
    "software-engineer",
    "test-engineer",
    "software-engineer",
  ])
    f.worker(role, "ATTEMPT-FAILED: 01-core#V1 — still blocked");
  const c = f.exec("state").counts["01-core#V1"];
  assert.equal(c.count, 3);
  assert.ok(c.guide);
  assert.throws(
    () => f.begin("debate", { caseId: "01-core#V1" }),
    /no current-cycle guideline/,
  );
});
function completedOOL(f, p) {
  f.worker(
    f.exec("state").nextRole,
    `OPEN: OUT-OF-LANE — ${p} — set required value\nATTEMPT-FAILED: 01-core#V1 — locked`,
  );
  const r = f.exec("state").requests.find((x) => x.path === p);
  const meta = {
    request: {
      id: r.id,
      sourceFile: storyRel,
      paths: r.grant,
      instruction: r.instruction,
      cases: [],
      checks: ["pnpm run typecheck"],
    },
  };
  const b = f.begin("groundwork-engineer", meta);
  f.append(
    b,
    turn(
      "groundwork-engineer",
      "**Result.** PASS\n**Applied.** set required value\npnpm run typecheck\nexit 0\nTYPE OK",
    ),
    { [p]: "{}\n" },
  );
  f.exec(
    "finish",
    "--assessment",
    f.scratch(`${cryptoName()}.json`, {
      request: r.id,
      instructionSatisfied: true,
      applied: [{ path: p, evidence: "set required value" }],
      checks: [
        {
          command: "pnpm run typecheck",
          exit: 0,
          output: "TYPE OK",
          evidence: "pnpm run typecheck\nexit 0\nTYPE OK",
        },
      ],
    }),
  );
}
test("third unforeseen request is stopped before its groundwork dispatch", (t) => {
  const f = fixture(t);
  completedOOL(f, "settings1.json");
  completedOOL(f, "settings2.json");
  f.worker(
    f.exec("state").nextRole,
    "OPEN: OUT-OF-LANE — settings3.json — set required value\nATTEMPT-FAILED: 01-core#V1 — locked",
  );
  const r = f.exec("state").requests[0];
  assert.equal(r.route, "human-threshold");
  assert.throws(
    () =>
      f.begin("groundwork-engineer", {
        request: {
          id: r.id,
          sourceFile: storyRel,
          paths: r.grant,
          instruction: r.instruction,
          cases: [],
          checks: ["pnpm run typecheck"],
        },
      }),
    /threshold/,
  );
});
test("same-path repeated request escalates within one failure epoch", (t) => {
  const f = fixture(t);
  completedOOL(f, "settings1.json");
  f.worker(
    f.exec("state").nextRole,
    "OPEN: OUT-OF-LANE — settings1.json — a different edit\nATTEMPT-FAILED: 01-core#V1 — locked",
  );
  const r = f.exec("state").requests[0];
  assert.equal(r.route, "human-repeat");
});
test("a human review failure resets unforeseen-request threshold and repeat policy", (t) => {
  const f = fixture(t);
  completedOOL(f, "settings1.json");
  completedOOL(f, "settings2.json");
  fs.appendFileSync(
    path.join(f.root, f.opened.discussion),
    "HUMAN_REVIEW: FAIL\nBLOCKER: author approved additional groundwork\n",
  );
  f.worker(
    "test-engineer",
    "OPEN: OUT-OF-LANE — settings1.json — approved new correction\nATTEMPT-FAILED: 01-core#V1 — locked",
  );
  const r = f.exec("state").requests[0];
  assert.equal(r.route, "groundwork");
});
test("command-local evidence cannot turn a reported exit 1 into a passing assessment", () => {
  const b = turn(
    "groundwork-engineer",
    "**Result.** PASS\nchanged\npnpm run typecheck\nexit 1\nTYPE OK",
  );
  assert.throws(
    () =>
      validateGroundwork(
        b,
        { id: "x", paths: ["a"], checks: ["pnpm run typecheck"] },
        {
          request: "x",
          instructionSatisfied: true,
          applied: [{ path: "a", evidence: "changed" }],
          checks: [
            {
              command: "pnpm run typecheck",
              exit: 0,
              output: "TYPE OK",
              evidence: "pnpm run typecheck\nexit 1\nTYPE OK",
            },
          ],
        },
      ),
    /exit evidence/,
  );
});
test("silent successful check accepts an explicit empty-output annotation", () => {
  const evidence = "pnpm run typecheck\nexit 0\nstdout/stderr: <empty>",
    b = turn("groundwork-engineer", "**Result.** PASS\nchanged\n" + evidence);
  assert.equal(
    validateGroundwork(
      b,
      { id: "x", paths: ["a"], checks: ["pnpm run typecheck"] },
      {
        request: "x",
        instructionSatisfied: true,
        applied: [{ path: "a", evidence: "changed" }],
        checks: [
          { command: "pnpm run typecheck", exit: 0, output: "", evidence },
        ],
      },
    ),
    true,
  );
});
test("file-mode-only change on an already-dirty out-of-lane file is detected", (t) => {
  const f = fixture(t);
  f.write("src/core.ts", "already dirty\n");
  const b = f.begin("test-engineer");
  f.append(b, turn("test-engineer"));
  fs.chmodSync(path.join(f.root, "src/core.ts"), 0o755);
  assert.throws(() => f.exec("finish"), /lane violation/);
});
test("groundwork cannot evade its request counter using a different failure ID", () => {
  const b = turn(
    "groundwork-engineer",
    "**Result.** BLOCKED\nOPEN: failed\nATTEMPT-FAILED: 01-wrong#V1 — failed",
  );
  assert.throws(
    () =>
      validateGroundwork(
        b,
        { id: "OOL-22", paths: ["a"], checks: ["check"], cases: [] },
        null,
      ),
    /failure ID/,
  );
});
test("three human failures in one invocation stop before another dispatch", (t) => {
  const f = fixture(t);
  fs.appendFileSync(
    path.join(f.root, f.opened.discussion),
    "HUMAN_REVIEW: FAIL\nBLOCKER: one\nHUMAN_REVIEW: FAIL\nBLOCKER: two\nHUMAN_REVIEW: FAIL\nBLOCKER: three\n",
  );
  assert.equal(f.exec("state").humanFailuresThisRun, 3);
  assert.throws(() => f.begin("test-engineer"), /review-loop-limit/);
});
test("ordinary proposed role cannot bypass next-role routing", (t) => {
  const f = fixture(t);
  assert.throws(
    () => f.begin("software-engineer"),
    /next engineer must be test-engineer/,
  );
});

test("abandonment cannot bypass operator repair and a newer human FAIL", (t) => {
  const f = fixture(t);
  const b = f.begin("test-engineer");
  f.append(b, turn("test-engineer"));
  f.exec(
    "abandon",
    "--confirm-idle",
    "--human-reason",
    "operator rejected partial work",
  );
  assert.throws(() => f.begin("test-engineer"), /newer HUMAN_REVIEW: FAIL/);
  fs.appendFileSync(
    b.discussion,
    "HUMAN_REVIEW: FAIL\nBLOCKER: operator inspected tree; resume verified work\n",
  );
  assert.equal(f.begin("test-engineer").role, "test-engineer");
});
test("unknown command options and missing option values fail before executing", (t) => {
  const f = fixture(t);
  assert.throws(() => f.exec("state", "--unrecognized", "x"), /unknown option/);
  assert.throws(() => f.exec("begin", "--role"), /requires a value/);
  assert.throws(
    () =>
      main([
        "open",
        "--root",
        f.root,
        "--epic",
        epicRel,
        "--adopt-legacy",
        "false",
      ]),
    /takes no value/,
  );
  assert.throws(() => main(["not-a-command"]), /commands:/);
});

test("an ordinary turn without an orchestrator assessment is not accepted", (t) => {
  const f = fixture(t),
    b = f.begin("test-engineer"),
    block = turn("test-engineer");
  f.append(b, block);
  assert.throws(() => f.exec("finish"), /needs --assessment/);
  assert.equal(f.exec("state").pending.length, 1);
});
test("an assessment naming a case the turn does not carry is rejected", (t) => {
  const f = fixture(t),
    b = f.begin("test-engineer"),
    block = turn("test-engineer", "RED for 01-core#V1");
  f.append(b, block);
  assert.throws(
    () => f.finishWorker(b, block, ["01-core#V9"]),
    /absent from the turn/,
  );
});
test("an assessment whose evidence is not an excerpt of the turn is rejected", (t) => {
  const f = fixture(t),
    b = f.begin("test-engineer"),
    block = turn("test-engineer");
  f.append(b, block);
  assert.throws(
    () =>
      f.exec(
        "finish",
        "--assessment",
        f.scratch("a.json", {
          turn: b.turn,
          cases: [],
          evidence: "never appeared",
        }),
      ),
    /contiguous excerpt/,
  );
});
test("readiness gates come from the EPIC, not from the submitted assessment", (t) => {
  const f = fixture(t),
    { b, assessment } = makeReady(f);
  const short = { ...assessment, gates: [] };
  assert.throws(
    () => f.exec("ready", "--assessment", f.scratch("short.json", short)),
    /positive check evidence required/,
  );
  const wrong = {
    ...assessment,
    gates: [
      {
        command: "pnpm run typecheck",
        exit: 0,
        output: "OK",
        evidence: "pnpm run typecheck\nexit 0\nOK",
      },
    ],
  };
  assert.throws(
    () => f.exec("ready", "--assessment", f.scratch("wrong.json", wrong)),
    /does not match the required command set/,
  );
  assert.ok(b.turn);
});
test("readiness requires the cited turn to name every case", (t) => {
  const f = fixture(t);
  f.closeStory();
  f.commitStory();
  const b = f.begin("test-engineer");
  const block = turn(
    "test-engineer",
    "**Cases closed.** all of them\nIMPLEMENTATION_READY_FOR_REVIEW:\n- gates: PASS",
  );
  f.append(b, block);
  f.finishWorker(b, block);
  const assessment = {
    turn: b.turn,
    obligationsReviewed: true,
    unresolved: [],
    sourceCoverageReviewed: true,
    storyGatesReviewed: true,
    gateSource: gate,
    cases: ["01-core#V1"],
    gates: [
      {
        command: "pnpm run verify",
        exit: 0,
        output: "VERIFY OK",
        evidence: "pnpm run verify\nexit 0\nVERIFY OK",
      },
    ],
    proof: {
      command: "node scripts/proof.mjs",
      exit: 0,
      output: "PROOF OK",
      evidence: "node scripts/proof.mjs\nexit 0\nPROOF OK",
      success: "PROOF OK",
    },
  };
  assert.throws(
    () => f.exec("ready", "--assessment", f.scratch("r.json", assessment)),
    /does not name every case/,
  );
});
test("a mandatory check that did not pass must reach the human", (t) => {
  const f = fixture(t);
  makeReady(f);
  f.begin("reviewer-engineer");
  const r = report([["B1", "YES", "fix bug"]]).replace(
    "| Proof | node scripts/proof.mjs | 0 | PROOF OK |",
    "| Proof | node scripts/proof.mjs | NOT_RUN | unavailable |",
  );
  assert.throws(
    () => f.exec("finish", "--report", f.scratch("r.md", r)),
    /needs an action:NO blocker/,
  );
});
test("a NOT_RUN mandatory check with an action:NO blocker is recorded", (t) => {
  const f = fixture(t);
  makeReady(f);
  f.begin("reviewer-engineer");
  const r = report([
    ["B1", "NO", "NEEDS-HUMAN: proof cannot run here"],
  ]).replace(
    "| Proof | node scripts/proof.mjs | 0 | PROOF OK |",
    "| Proof | node scripts/proof.mjs | NOT_RUN | unavailable |",
  );
  assert.equal(
    f.exec("finish", "--report", f.scratch("r.md", r)).status,
    "awaiting-human-review",
  );
});
test("gateCommands reads every backticked command the Gates: line declares", () => {
  assert.deepEqual(gateCommands("Gates: `npm run verify`\nProof: x"), [
    "npm run verify",
  ]);
  assert.deepEqual(gateCommands("Gates: `npm run verify` and `npm run lint`"), [
    "npm run verify",
    "npm run lint",
  ]);
});
test("gateCommands refuses a Gates: line a command cannot be read from", () => {
  assert.throws(
    () => gateCommands("Gates: npm run verify"),
    /named in backticks/,
  );
  assert.throws(() => gateCommands("Proof: only"), /no Gates: line/);
  assert.throws(
    () => gateCommands("Gates: `npm run verify` `npm run verify`"),
    /duplicate/,
  );
});
test("a fenced Gates: sample declares no command", () => {
  assert.throws(
    () => gateCommands("```text\nGates: `npm run verify`\n```"),
    /no Gates: line/,
  );
});

test("an ambient git environment cannot redirect a turn to another repository", (t) => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "work-outside-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const f = fixture(t);
  const saved = {
    GIT_DIR: process.env.GIT_DIR,
    GIT_WORK_TREE: process.env.GIT_WORK_TREE,
  };
  try {
    process.env.GIT_DIR = path.join(outside, ".git");
    process.env.GIT_WORK_TREE = outside;
    const done = f.worker("test-engineer", "RED for 01-core#V1", {
      "src/core.test.ts": "x\n",
    });
    assert.equal(done.result.status, "accepted");
    assert.equal(fs.existsSync(path.join(outside, ".git")), false);
  } finally {
    for (const [k, v] of Object.entries(saved))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  }
});
test("cleanEnv strips every git location variable", () => {
  const env = cleanEnv({
    GIT_DIR: "/elsewhere",
    GIT_WORK_TREE: "/elsewhere",
    LC_ALL: "C",
  });
  assert.equal(env.GIT_DIR, undefined);
  assert.equal(env.GIT_WORK_TREE, undefined);
  assert.equal(env.LC_ALL, "C");
});

// --- one commit per completed story ---
test("a closed story commits once, with a deterministic message", (t) => {
  const f = fixture(t);
  f.closeStory();
  const r = f.commitStory();
  assert.equal(r.status, "committed");
  assert.deepEqual(r.hookModified, []);
  assert.equal(
    f.cmd("log", "-1", "--format=%B").trim(),
    commitMessage("001-demo", { groundwork: false, path: storyRel }, "Core", [
      "01-core#V1",
    ]).trim(),
  );
  assert.equal(
    f.cmd("show", "--name-only", "--format=", "HEAD"),
    "src/core.test.ts",
  );
  assert.equal(f.exec("state").commits.done[0].sha, r.sha);
});
test("the ledger stays out of every story commit", (t) => {
  const f = fixture(t);
  f.closeStory();
  f.commitStory();
  assert.equal(
    f.cmd("ls-files", "--", ".agents/tdd/history"),
    "",
    "the discussion must remain untracked",
  );
  // Control: the story's own change did land, so the assertion is not vacuous.
  assert.equal(f.cmd("ls-files", "--", "src/core.test.ts"), "src/core.test.ts");
});
test("a second commit for the same story is refused as already committed", (t) => {
  const f = fixture(t);
  f.closeStory();
  const first = f.commitStory();
  f.worker("test-engineer", "", { "src/core.test.ts": "// more\n" });
  const again = f.commitStory();
  assert.equal(again.status, "already-committed");
  assert.equal(again.sha, first.sha);
  assert.equal(f.cmd("rev-parse", "HEAD"), first.sha);
});
test("a blocked closing turn cannot be committed", (t) => {
  const f = fixture(t);
  const b = f.begin("test-engineer"),
    block = turn(
      "test-engineer",
      "pnpm test\nexit 0\nTESTS OK\nATTEMPT-FAILED: 01-core#V1 — still red\nSTORY-COMPLETE: 01-core — cases: 01-core#V1",
    );
  f.append(b, block, { "src/core.test.ts": "// blocked\n" });
  f.finishWorker(b, block, ["01-core#V1"]);
  assert.throws(() => f.commitStory(), /blocked/);
  assert.equal(f.cmd("rev-parse", "HEAD"), f.base);
});
test("a tree edited after the closing turn is not committable", (t) => {
  const f = fixture(t);
  f.closeStory();
  f.write("src/core.ts", "export const value = 99;\n");
  assert.throws(() => f.commitStory(), /no turn validation/);
  assert.equal(f.cmd("rev-parse", "HEAD"), f.base);
});
test("STORY-COMPLETE must name exactly the story's cases", (t) => {
  const f = fixture(t);
  f.closeStory("01-core", ["01-core#V2"]);
  assert.throws(() => f.commitStory(), /exactly this story's cases/);
});
test("only the test-engineer may close a story", () => {
  assert.throws(
    () =>
      validateAppend(
        "",
        turn(
          "software-engineer",
          "STORY-COMPLETE: 01-core — cases: 01-core#V1",
        ),
        turn(
          "software-engineer",
          "STORY-COMPLETE: 01-core — cases: 01-core#V1",
        ),
        "software-engineer",
      ),
    /belongs only to test-engineer/,
  );
  // Control: the same block from the test-engineer is accepted.
  const block = turn(
    "test-engineer",
    "STORY-COMPLETE: 01-core — cases: 01-core#V1",
  );
  assert.ok(validateAppend("", block, block, "test-engineer"));
});
test("readiness refuses a story that never committed", (t) => {
  const f = fixture(t);
  const b = f.begin("test-engineer"),
    block = turn(
      "test-engineer",
      "**Cases closed.** 01-core#V1\nIMPLEMENTATION_READY_FOR_REVIEW:\n- gates: PASS",
    );
  f.append(b, block);
  f.finishWorker(b, block, ["01-core#V1"]);
  assert.throws(
    () =>
      f.exec("ready", "--assessment", f.scratch("r.json", { turn: b.turn })),
    /every story commits before readiness/,
  );
});
test("a hook that rewrites staged content is recorded, never silently certified", (t) => {
  const f = fixture(t, {
    setup: ({ root }) => {
      const h = path.join(root, ".git", "hooks", "pre-commit");
      fs.writeFileSync(
        h,
        "#!/bin/sh\nprintf '// reformatted\\n' >> src/core.test.ts\ngit add src/core.test.ts\n",
      );
      fs.chmodSync(h, 0o755);
    },
  });
  f.closeStory();
  const r = f.commitStory();
  assert.equal(r.status, "committed-with-hook-changes");
  assert.deepEqual(r.hookModified, ["src/core.test.ts"]);
  assert.equal(f.exec("state").commits.done[0].hookModified.length, 1);
});
test("a commit intent with no commit behind it settles as discarded", (t) => {
  const f = fixture(t);
  f.closeStory();
  fs.appendFileSync(
    path.join(f.root, f.opened.discussion),
    `WORK-EVENT: ${JSON.stringify({
      v: 1,
      type: "commit-intent",
      op: "op-1",
      story: "01-core",
      turn: "t-1",
      parent: f.cmd("rev-parse", "HEAD"),
      tree: f.cmd("rev-parse", "HEAD^{tree}"),
      message: "unused",
    })}\n`,
  );
  assert.equal(f.commitStory().status, "commit-discarded");
  assert.equal(f.cmd("rev-parse", "HEAD"), f.base);
  // The discarded intent releases the story, so the real commit still lands.
  assert.equal(f.commitStory().status, "committed");
});
test("a new cycle refuses to open on a tree it does not own", (t) => {
  assert.throws(
    () =>
      fixture(t, {
        setup: ({ write }) =>
          write("src/stray.ts", "export const stray = 1;\n"),
      }),
    /needs a clean tree/,
  );
  // Control: the same fixture without the stray file opens.
  assert.equal(fixture(t).opened.status, "opened");
});
test("stories commit in their planned order", (t) => {
  const f = fixture(t, {
    setup: ({ write, cmd }) => {
      write(".agents/plan/stories/001-demo/02-next.md", story);
      cmd("add", ".");
      cmd("commit", "-qm", "second story");
    },
  });
  f.closeStory("02-next", ["02-next#V1"]);
  assert.throws(
    () => f.commitStory("02-next"),
    /commit the earlier stories first/,
  );
});
