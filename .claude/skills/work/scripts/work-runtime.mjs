#!/usr/bin/env node
/** /work mechanical runtime. No model calls, installs, production edits, or guard changes. */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const WORKERS = ["test-engineer", "software-engineer", "groundwork-engineer"];
const ROLES = [...WORKERS, "reviewer-engineer", "debate"];
const UPPER = Object.fromEntries(WORKERS.map((r) => [r, r.toUpperCase()]));
const LAST = (a) => a.at(-1);
const fail = (m) => {
  throw new Error(m);
};
export const hash = (x) => crypto.createHash("sha256").update(x).digest("hex");
const read = (p) => fs.readFileSync(p, "utf8");
const json = (p) => JSON.parse(read(p));
const save = (p, data) =>
  fs.writeFileSync(p, JSON.stringify(data, null, 2) + "\n", {
    mode: 0o600,
    flag: "wx",
  });
const oneLine = (s, name) =>
  typeof s === "string" && s.trim() && !/[\r\n\0]/.test(s)
    ? s
    : fail(`${name}: expected one nonempty line`);
const distinct = (a) => [...new Set(a)];
// A git hook exports GIT_DIR and its companions. They would silently redirect
// every command here to the hook's repository, so cwd alone decides the target.
const GIT_LOCATION = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_NAMESPACE",
  "GIT_CEILING_DIRECTORIES",
  "GIT_PREFIX",
];
export function cleanEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  for (const k of GIT_LOCATION) delete env[k];
  return env;
}
function run(root, binary, args) {
  const p = spawnSync(binary, args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: cleanEnv({ GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" }),
  });
  if (p.error || p.status !== 0)
    fail(
      `${binary} ${args.join(" ")}: ${p.error?.message ?? p.stderr ?? "failed"} (exit ${p.status})`,
    );
  return p.stdout;
}
function git(root, args) {
  return run(root, "git", args);
}
export function repoPath(p) {
  oneLine(p, "path");
  if (
    /\t/.test(p) ||
    p.includes("\\") ||
    path.posix.isAbsolute(p) ||
    p.split("/").some((s) => !s || s === "." || s === "..") ||
    p === ".git" ||
    p.startsWith(".git/")
  )
    fail(`unsafe/unsupported repository path: ${p}`);
  return p;
}
function inside(root, p, { existing = false } = {}) {
  p = repoPath(p);
  const target = path.join(root, p);
  let walk = root;
  for (const part of p.split("/")) {
    walk = path.join(walk, part);
    let stat;
    try {
      stat = fs.lstatSync(walk);
    } catch (e) {
      if (e.code === "ENOENT") break;
      throw e;
    }
    if (stat.isSymbolicLink())
      fail(`symlink path is not an authorized target: ${p}`);
  }
  if (existing && !fs.existsSync(target)) fail(`missing path: ${p}`);
  return target;
}
function relative(root, p) {
  return repoPath(
    path.relative(root, path.resolve(root, p)).split(path.sep).join("/"),
  );
}
export function lex(text) {
  let fence = null,
    offset = 0;
  return text.split(/(?<=\n)/).map((raw, i) => {
    const s = raw.replace(/\r?\n$/, "");
    const f = s.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    const active = !fence && !f;
    if (f) {
      if (!fence) fence = { char: f[1][0], size: f[1].length };
      else if (
        f[1][0] === fence.char &&
        f[1].length >= fence.size &&
        !f[2].trim()
      )
        fence = null;
    }
    const line = { s, raw, line: i + 1, offset, active };
    offset += raw.length;
    return line;
  });
}
function header(text) {
  const lines = text.split(/\r?\n/);
  if (lines[0] !== "---") fail("missing discussion frontmatter");
  const end = lines.indexOf("---", 1);
  if (end < 0) fail("unterminated discussion frontmatter");
  const h = {};
  for (const line of lines.slice(1, end)) {
    const m = line.match(/^([\w-]+):\s*(.*)$/);
    if (!m) continue;
    if (Object.hasOwn(h, m[1])) fail(`duplicate discussion header: ${m[1]}`);
    let v = m[2].trim();
    if (v.startsWith('"')) {
      try {
        v = JSON.parse(v);
      } catch {
        fail(`unsupported header quoting: ${line}`);
      }
    } else if (v.startsWith("'") && v.endsWith("'"))
      v = v.slice(1, -1).replaceAll("''", "'");
    h[m[1]] = v;
  }
  return h;
}
export function parsePaths(text) {
  text = text.trim();
  if (!text) return [];
  if (text.startsWith("[")) {
    const a = JSON.parse(text);
    if (!Array.isArray(a) || a.some((x) => typeof x !== "string"))
      fail("paths must be a JSON array of strings");
    return distinct(a.map(repoPath));
  }
  // Legacy whitespace syntax, with an explicit quoted-path extension; never shell-evaluate it.
  const a = [],
    re = /\s*(?:"((?:\\.|[^"\\])*)"|'([^']*)'|([^\s"']+))/gy;
  let pos = 0,
    m;
  while (pos < text.length) {
    re.lastIndex = pos;
    m = re.exec(text);
    if (!m) fail("ambiguous legacy path list; use a JSON array");
    a.push(m[1] !== undefined ? JSON.parse(`"${m[1]}"`) : (m[2] ?? m[3]));
    pos = re.lastIndex;
  }
  return distinct(a.map(repoPath));
}
export function section(text, title) {
  const a = lex(text),
    start = a.findIndex((l) => l.active && l.s === `## ${title}`);
  if (start < 0) fail(`missing ## ${title}`);
  const stop = a.findIndex(
    (l, i) => i > start && l.active && /^#{1,2} /.test(l.s),
  );
  return a
    .slice(start + 1, stop < 0 ? undefined : stop)
    .map((l) => l.raw)
    .join("")
    .trim();
}
export function parseDiscussion(text) {
  const lines = lex(text),
    active = lines.filter((l) => l.active),
    h = header(text);
  const events = active
    .filter((l) => l.s.startsWith("WORK-EVENT: "))
    .map((l) => {
      const e = JSON.parse(l.s.slice(12));
      if (e.v !== 1 || typeof e.type !== "string")
        fail(`unsupported WORK-EVENT at line ${l.line}`);
      return { ...e, line: l.line };
    });
  const firstRun = events.find((e) => e.type === "run")?.line ?? Infinity;
  const accepted = events.filter(
    (e) => e.type === "accepted" && WORKERS.includes(e.role),
  );
  const turns = [];
  for (const l of active.filter((l) =>
    /^END: (TEST-ENGINEER|SOFTWARE-ENGINEER|GROUNDWORK-ENGINEER)\s*$/.test(l.s),
  )) {
    const role = l.s.slice(5).trim().toLowerCase();
    const receipt = accepted.find(
      (e) => e.endLine === l.line && e.role === role,
    );
    if (l.line >= firstRun && !receipt) continue; // Interrupted/rejected new turns have no authority.
    let start = receipt?.startLine;
    if (!start) {
      const heading = LAST(
        active.filter(
          (x) =>
            x.line < l.line &&
            /^## (TEST-ENGINEER|SOFTWARE-ENGINEER|GROUNDWORK(?:-ENGINEER)?)(?:\s|$)/.test(
              x.s,
            ),
        ),
      );
      if (!heading) fail(`legacy END without a role heading at line ${l.line}`);
      start = heading.line;
    }
    const block = lines
      .slice(start - 1, l.line)
      .map((x) => x.raw)
      .join("");
    if (receipt && hash(block) !== receipt.blockHash)
      fail(`accepted turn content changed: ${receipt.turn}`);
    turns.push({
      role,
      start,
      end: l.line,
      block,
      turn: receipt?.turn ?? `legacy-${l.line}`,
      legacy: !receipt,
      receipt,
    });
  }
  const authoritative = (l) =>
    !/^END:/.test(l.s) &&
    (!turns.some((t) => l.line >= t.start && l.line <= t.end) ||
      !/^(HUMAN_REVIEW:|AUTO_REVIEW:|GROUNDWORK-COMPLETE:|DEBATE_GUIDELINE:|GUIDELINE:|WORK-EVENT:)/.test(
        l.s,
      ));
  const control = active.filter(authoritative);
  // Discard all markers inside unaccepted worker blocks, including forged readiness/failures.
  const inFlightSpans = events
    .filter((e) => e.type === "begin")
    .filter(
      (e) => !events.some((x) => x.type === "accepted" && x.turn === e.turn),
    )
    .map((e) => ({
      start: e.line + 1,
      end:
        events.find(
          (x) => x.line > e.line && x.turn === e.turn && x.type === "abandoned",
        )?.line ?? Infinity,
    }));
  const markers = control.filter(
    (l) => !inFlightSpans.some((t) => l.line >= t.start && l.line < t.end),
  );
  const human = markers.filter((l) =>
    /^HUMAN_REVIEW: (PASS|FAIL)(?:\s|$)/.test(l.s),
  );
  const failures = markers.filter((l) =>
    /^(HUMAN_REVIEW|AUTO_REVIEW): FAIL(?:\s|$)/.test(l.s),
  );
  const boundary = LAST(failures)?.line ?? 0,
    humanBoundary = LAST(human)?.line ?? 0;
  const engineers = turns.filter((t) => t.role !== "groundwork-engineer");
  let next =
    boundary && !engineers.some((t) => t.end > boundary)
      ? "test-engineer"
      : LAST(engineers)?.role === "test-engineer"
        ? "software-engineer"
        : "test-engineer";
  const completions = markers
    .filter((l) => l.s.startsWith("GROUNDWORK-COMPLETE: "))
    .map((l) => {
      const m = l.s.match(/^GROUNDWORK-COMPLETE:\s+([^\s]+)\s+—\s+(.+)$/);
      if (!m) fail(`invalid completion at line ${l.line}`);
      const receipt = events.find(
        (e) =>
          e.type === "groundwork" &&
          e.line > l.line &&
          e.line <= l.line + 2 &&
          e.request === m[1],
      );
      return {
        id: m[1],
        paths: parsePaths(m[2]),
        line: l.line,
        sourceHash: receipt?.sourceHash ?? null,
      };
    });
  const ool = turns
    .filter((t) => t.role !== "groundwork-engineer")
    .flatMap((t) =>
      lex(t.block)
        .filter((l) => l.active && l.s.startsWith("OPEN: OUT-OF-LANE"))
        .map((l) => {
          const m = l.s.match(/^OPEN: OUT-OF-LANE\s+—\s+(.+?)\s+—\s+(.+)$/);
          if (!m) fail(`invalid out-of-lane marker in ${t.turn}`);
          const line = t.start + l.line - 1;
          return {
            id: `OOL-${line}`,
            line,
            path: repoPath(m[1]),
            instruction: m[2],
            turn: t.turn,
          };
        }),
    );
  const guides = markers
    .filter((l) => l.s.startsWith("DEBATE_GUIDELINE: "))
    .map((l) => {
      const m = l.s.match(/^DEBATE_GUIDELINE:\s+(.+?)\s+—\s+(.+)$/);
      if (!m) fail(`invalid guideline at line ${l.line}`);
      const steps = [];
      for (const n of lines.slice(l.line)) {
        if (!n.active || !n.s.startsWith("GUIDELINE: ")) break;
        steps.push(n.s.slice(11));
      }
      return { caseId: m[1], line: l.line, summary: m[2], steps };
    });
  const attempts = turns.flatMap((t) =>
    lex(t.block)
      .filter((l) => l.active && l.s.startsWith("ATTEMPT-FAILED:"))
      .map((l) => {
        const m = l.s.match(/^ATTEMPT-FAILED:\s+(.+?)\s+—\s+(.+)$/);
        if (!m) fail(`invalid failure marker in ${t.turn}`);
        return {
          caseId: m[1],
          reason: m[2],
          line: t.start + l.line - 1,
          turn: t.turn,
          role: t.role,
        };
      }),
  );
  const counts = {};
  for (const id of distinct(
    attempts
      .filter((a) => a.role !== "groundwork-engineer")
      .map((a) => a.caseId),
  )) {
    const guide = LAST(
      guides.filter((g) => g.caseId === id && g.line > boundary),
    );
    counts[id] = {
      count: distinct(
        attempts
          .filter(
            (a) =>
              a.caseId === id && a.line > Math.max(boundary, guide?.line ?? 0),
          )
          .map((a) => a.turn),
      ).length,
      guide: guide ?? null,
    };
  }
  const latest = LAST(turns),
    readyTurn =
      latest?.role === "test-engineer" &&
      latest.end > boundary &&
      lex(latest.block).some(
        (l) => l.active && /^IMPLEMENTATION_READY_FOR_REVIEW:/.test(l.s),
      )
        ? latest
        : null;
  if (
    readyTurn &&
    events.some((e) => e.type === "ready-rejected" && e.turn === readyTurn.turn)
  )
    next = "test-engineer";
  const pending = events.filter(
    (e) =>
      e.type === "begin" &&
      !events.some(
        (x) => ["accepted", "abandoned"].includes(x.type) && x.turn === e.turn,
      ),
  );
  const autoUsed = markers.some(
    (l) => l.line > humanBoundary && l.s.startsWith("AUTO_REVIEW: FAIL"),
  );
  return {
    header: h,
    events,
    turns,
    boundary,
    humanBoundary,
    human: LAST(human)?.s.slice(14).split(/\s/)[0] ?? "pending",
    next,
    completions,
    allRequests: ool,
    requests: ool.filter((r) => !completions.some((c) => c.id === r.id)),
    guides,
    attempts,
    counts,
    readyTurn,
    pending,
    autoUsed,
    reviews: events.filter(
      (e) => e.type === "review" && e.line > humanBoundary,
    ),
    readyChecks: events.filter((e) => e.type === "ready"),
    markers,
  };
}
export function snapshotParse(text) {
  const m = {};
  for (const s of text.split(/\r?\n/).filter(Boolean)) {
    const ix = s.indexOf("\t");
    if (ix < 1) fail("snapshot must contain hash<TAB>path");
    const h = s.slice(0, ix),
      p = repoPath(s.slice(ix + 1));
    if (!/^(ABSENT|[a-fA-F0-9]{40,64})$/.test(h) || Object.hasOwn(m, p))
      fail(`invalid/duplicate snapshot entry: ${s}`);
    m[p] = h;
  }
  return m;
}
export function delta(a, b) {
  return distinct([...Object.keys(a), ...Object.keys(b)])
    .filter((p) => a[p] !== b[p])
    .sort();
}
function snapshot(root) {
  // Reject dirty symlinks before asking a content guard to read them. Preserve spaces with -z.
  const dirty = distinct(
    [
      ...git(root, [
        "diff",
        "--name-only",
        "--no-renames",
        "-z",
        "HEAD",
        "--",
      ]).split("\0"),
      ...git(root, ["ls-files", "--others", "--exclude-standard", "-z"]).split(
        "\0",
      ),
    ].filter(Boolean),
  );
  for (const p of dirty) inside(root, p);
  const raw = snapshotParse(
    run(root, "bash", ["scripts/turn-snapshot.sh", root]),
  );
  return Object.fromEntries(
    Object.entries(raw).map(([p, h]) => {
      const file = inside(root, p);
      if (!fs.existsSync(file)) return [p, h];
      const stat = fs.lstatSync(file);
      if (!stat.isFile()) fail(`non-regular snapshot target: ${p}`);
      return [p, `${h}:mode=${stat.mode & 0o7777}`];
    }),
  );
}
function gitState(root) {
  return {
    head: git(root, ["rev-parse", "HEAD"]).trim(),
    ref: git(root, ["rev-parse", "--abbrev-ref", "HEAD"]).trim(),
    staged: hash(
      git(root, [
        "diff",
        "--cached",
        "--raw",
        "--no-abbrev",
        "--no-renames",
        "-z",
        "--",
      ]),
    ),
  };
}
function lane(root, role, p) {
  const r = spawnSync("bash", ["scripts/lane-check.sh", role, repoPath(p)], {
    cwd: root,
    encoding: "utf8",
    env: cleanEnv({ LC_ALL: "C" }),
  });
  if (r.error || r.signal || r.status === null || [126, 127].includes(r.status))
    fail(`lane guard failed operationally: ${r.error?.message ?? r.stderr}`);
  return {
    allowed: r.status === 0,
    reason: r.stderr.trim() || r.stdout.trim(),
  };
}
function fingerprint(s, snap = snapshot(s.root)) {
  const body = Object.fromEntries(
    Object.entries(snap).filter(
      ([p]) =>
        p !== s.discussion &&
        !/^\.agents\/tdd\/\.(test|software|groundwork)-engineer-response-/.test(
          p,
        ),
    ),
  );
  return hash(
    JSON.stringify({
      git: gitState(s.root),
      files: Object.entries(body).sort(([a], [b]) => a.localeCompare(b)),
    }),
  );
}
function emit(p, lines) {
  const before = read(p);
  if (before && !before.endsWith("\n"))
    fail(
      "discussion has no trailing newline; operator must repair the incomplete append",
    );
  fs.appendFileSync(p, lines.join("\n") + "\n");
}
const event = (e) => `WORK-EVENT: ${JSON.stringify({ v: 1, ...e })}`;
function session(p) {
  const s = json(p),
    owner = json(path.join(s.lock, "owner.json"));
  if (owner.token !== s.token || owner.session !== p)
    fail("session does not own the worktree lock");
  if (fs.realpathSync(s.root) !== s.root) fail("repository root changed");
  return s;
}
function stateOf(s) {
  return parseDiscussion(
    read(inside(s.root, s.discussion, { existing: true })),
  );
}
export function findDiscussion(root, epic, explicit) {
  const dir = path.join(root, ".agents/tdd/history");
  if (explicit) {
    const p = relative(root, explicit);
    if (!p.startsWith(".agents/tdd/history/") || !p.endsWith(".md"))
      fail("discussion must be under .agents/tdd/history/");
    if (header(read(inside(root, p, { existing: true }))).epic !== epic)
      fail("explicit discussion belongs to a different EPIC");
    return p;
  }
  if (!fs.existsSync(dir)) return null;
  const matches = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .flatMap((f) => {
      const p = `.agents/tdd/history/${f}`;
      const t = read(inside(root, p, { existing: true }));
      let h;
      try {
        h = header(t);
      } catch {
        return [];
      }
      return h.epic === epic
        ? [{ p, done: parseDiscussion(t).human === "PASS" }]
        : [];
    });
  const open = matches.filter((m) => !m.done);
  if (open.length > 1)
    fail(
      "multiple open discussions for this EPIC; select --discussion explicitly",
    );
  return (
    open[0]?.p ??
    LAST(matches.sort((a, b) => a.p.localeCompare(b.p)))?.p ??
    null
  );
}
function openSession(o) {
  const root = fs.realpathSync(
    git(o.root ?? process.cwd(), ["rev-parse", "--show-toplevel"]).trim(),
  );
  const epic = relative(root, o.epic ?? fail("--epic is required"));
  if (!epic.startsWith(".agents/plan/epics/") || !epic.endsWith(".md"))
    fail("EPIC must be a Markdown file under .agents/plan/epics/");
  inside(root, epic, { existing: true });
  const maxTurns = Number(o["max-turns"] ?? "128");
  if (
    !Number.isSafeInteger(maxTurns) ||
    maxTurns < 0 ||
    !/^\d+$/.test(String(o["max-turns"] ?? "128"))
  )
    fail("--max-turns must be a nonnegative integer");
  for (const r of WORKERS.concat("reviewer-engineer")) {
    if (
      ![".claude", ".opencode"].some((d) =>
        fs.existsSync(path.join(root, d, "agents", `${r}.md`)),
      )
    )
      fail(`missing persona: ${r}`);
  }
  for (const p of [
    "scripts/lane-check.sh",
    "scripts/turn-snapshot.sh",
    "scripts/verify-handoff.mjs",
    "scripts/memory-append-only.sh",
  ])
    inside(root, p, { existing: true });
  let discussion = findDiscussion(root, epic, o.discussion);
  if (
    discussion &&
    parseDiscussion(read(path.join(root, discussion))).human === "PASS"
  )
    return { status: "already-closed", discussion };
  const gd = git(root, ["rev-parse", "--absolute-git-dir"]).trim(),
    lock = path.join(gd, "kanthor-work.lock");
  try {
    fs.mkdirSync(lock, { mode: 0o700 });
  } catch (e) {
    if (e.code === "EEXIST")
      fail(
        `worktree already locked; do not steal it. Inspect ${path.join(lock, "owner.json")}`,
      );
    throw e;
  }
  let dir,
    seeded = false;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "kanthor-work-"));
    fs.chmodSync(dir, 0o700);
    const date = new Date().toISOString().slice(0, 10),
      runId = crypto.randomUUID();
    if (!discussion) {
      discussion = `.agents/tdd/history/${date}-${path.basename(epic, ".md")}.md`;
      fs.mkdirSync(path.dirname(path.join(root, discussion)), {
        recursive: true,
      });
      const gate = section(read(path.join(root, epic)), "Verification Gate");
      fs.writeFileSync(
        inside(root, discussion),
        `---\nepic: ${JSON.stringify(epic)}\nopened: ${date}\nopener: test-engineer\nbase-ref: ${git(root, ["rev-parse", "HEAD"]).trim()}\n---\n\n# Implementation cycle — ${path.basename(epic, ".md")}\n\nVerification Gate (binding; source remains the EPIC):\n${gate
          .split("\n")
          .map((l) => "> " + l)
          .join("\n")}\n`,
        { flag: "wx" },
      );
      seeded = true;
    }
    const old = stateOf({ root, discussion });
    if (old.pending.length)
      fail(
        "unfinished recorded turn; recover its original session/evidence, never start a new baseline",
      );
    if (
      old.turns.some((t) => t.legacy) &&
      !old.events.some((e) => e.type === "legacy-adopted") &&
      o["adopt-legacy"] !== true
    )
      fail(
        "legacy history needs an operator-authorized --adopt-legacy; prior lane checks cannot be reconstructed",
      );
    const base = old.header["base-ref"];
    if (!/^[a-f0-9]{40,64}$/i.test(base ?? ""))
      fail("invalid/missing base-ref");
    git(root, ["rev-parse", "--verify", `${base}^{commit}`]);
    const s = {
      root,
      epic,
      discussion,
      maxTurns,
      run: runId,
      lock,
      token: crypto.randomUUID(),
      dir,
      opened: date,
    };
    const sp = path.join(dir, "session.json");
    save(sp, s);
    save(path.join(lock, "owner.json"), { token: s.token, session: sp });
    const entries = [];
    if (
      old.turns.some((t) => t.legacy) &&
      !old.events.some((e) => e.type === "legacy-adopted")
    )
      entries.push(
        event({
          type: "legacy-adopted",
          prefixHash: hash(read(path.join(root, discussion))),
          note: "operator trusts old history; not retroactive guard verification",
        }),
      );
    entries.push(
      event({ type: "run", run: runId, maxTurns, session: sp, date }),
    );
    emit(path.join(root, discussion), entries);
    return {
      status: seeded ? "opened" : "resumed",
      session: sp,
      root,
      epic,
      discussion,
      baseRef: base,
      maxTurns,
    };
  } catch (e) {
    fs.rmSync(lock, { recursive: true, force: true });
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    throw e;
  }
}
function begin(sp, role, meta = {}) {
  const s = session(sp),
    st = stateOf(s);
  if (!ROLES.includes(role)) fail("unknown dispatch role");
  if (st.human === "PASS") fail("cycle is closed");
  if (st.pending.length) fail("a dispatch is already in flight");
  const abandonedLine =
    st.events.filter((e) => e.type === "abandoned").at(-1)?.line ?? 0;
  const recoveryLine =
    st.markers.filter((l) => /^HUMAN_REVIEW: FAIL/.test(l.s)).at(-1)?.line ?? 0;
  if (abandonedLine > recoveryLine)
    fail(
      "abandoned turn requires operator repair and a newer HUMAN_REVIEW: FAIL before dispatch",
    );
  const runLine =
    st.events.find((e) => e.type === "run" && e.run === s.run)?.line ?? 0;
  if (
    st.markers.filter(
      (l) => l.line > runLine && /^HUMAN_REVIEW: FAIL/.test(l.s),
    ).length >= 3
  )
    fail("review-loop-limit: three human review failures this invocation");
  const count = st.events.filter(
    (e) => e.type === "begin" && e.run === s.run,
  ).length;
  if (s.maxTurns && count >= s.maxTurns)
    fail(`max-turns reached (${s.maxTurns})`);
  const turn = `${path.basename(s.epic, ".md")}-${s.run}-t${count + 1}`;
  const draft = WORKERS.includes(role)
    ? `.agents/tdd/.${role}-response-${turn}.md`
    : null;
  if (draft && fs.existsSync(path.join(s.root, draft))) fail("draft collision");
  if (["test-engineer", "software-engineer"].includes(role) && role !== st.next)
    fail(`next engineer must be ${st.next}`);
  if (role === "reviewer-engineer") {
    const fp = fingerprint(s);
    if (
      !st.readyTurn ||
      st.autoUsed ||
      st.events.some(
        (e) => e.type === "ready-rejected" && e.turn === st.readyTurn.turn,
      ) ||
      !st.readyChecks.some(
        (e) => e.turn === st.readyTurn.turn && e.fingerprint === fp,
      )
    )
      fail(
        "review dispatch requires current validated readiness and unused auto-review pass",
      );
    if (
      st.reviews.some(
        (r) => r.readyTurn === st.readyTurn.turn && r.fingerprint === fp,
      )
    )
      fail("review already recorded for this readiness; reuse it");
  }
  if (role === "groundwork-engineer") {
    const req = meta.request ?? fail("groundwork needs request metadata");
    oneLine(req.id, "request id");
    oneLine(req.sourceFile, "sourceFile");
    if (
      !Array.isArray(req.paths) ||
      !req.paths.length ||
      !Array.isArray(req.checks) ||
      !req.checks.length ||
      distinct(req.checks).length !== req.checks.length ||
      !Array.isArray(req.cases)
    )
      fail("request needs nonempty exact paths/checks and case IDs");
    if (distinct(req.paths).length !== req.paths.length)
      fail("duplicate grant");
    for (const p of req.paths) {
      inside(s.root, p);
      if (!lane(s.root, role, p).allowed) fail(`groundwork grant denied: ${p}`);
    }
    for (const c of req.checks) oneLine(c, "required check");
    if (!req.instruction?.trim()) fail("groundwork instruction is empty");
    if (
      !req.sourceFile.startsWith(
        `.agents/plan/stories/${path.basename(s.epic, ".md")}/`,
      )
    )
      fail("groundwork context must be a story of this EPIC");
    const source = read(inside(s.root, req.sourceFile, { existing: true }));
    if (req.id === "00-groundwork") {
      if (
        !req.cases.length ||
        req.cases.some((c) => !/^00-groundwork#V[1-9]\d*$/.test(c))
      )
        fail("pre-loop request must carry its real 00-groundwork case IDs");
      const expected = `.agents/plan/stories/${path.basename(s.epic, ".md")}/00-groundwork.md`;
      if (
        req.sourceFile !== expected ||
        !/^Executor:\s*groundwork-engineer\s*$/m.test(source)
      )
        fail("pre-loop groundwork source mismatch");
      if (req.instruction !== section(source, "Change"))
        fail("pre-loop instruction must be the entire verbatim Change section");
      const wanted = groundworkPaths(source),
        sourceHash = hash(source);
      const have = st.completions
        .filter((c) => c.id === req.id && c.sourceHash === sourceHash)
        .flatMap((c) => c.paths);
      const remaining = wanted.filter((p) => !have.includes(p));
      if (
        JSON.stringify([...req.paths].sort()) !==
          JSON.stringify(remaining.sort()) ||
        !remaining.length
      )
        fail(
          "pre-loop grant must equal unproven paths for this source revision",
        );
      const count = distinct(
        st.attempts
          .filter(
            (a) =>
              a.role === role &&
              a.caseId.startsWith("00-groundwork#") &&
              a.line > st.boundary,
          )
          .map((a) => a.turn),
      ).length;
      if (count >= 3)
        fail(
          "groundwork request exhausted three attempts; human intervention required",
        );
    } else {
      const r =
        st.requests.find((r) => r.id === req.id) ??
        fail("unknown or already-consumed OOL request");
      if (
        ["test-engineer", "software-engineer"].some(
          (role) => lane(s.root, role, r.path).allowed,
        )
      )
        fail("OOL claim rejected: an engineer owns the path");
      if (req.instruction !== r.instruction)
        fail("mid-loop instruction must equal the exact marker change clause");
      const expected =
        r.path === "package.json"
          ? ["package.json", "package-lock.json"]
          : [r.path];
      if (
        JSON.stringify([...req.paths].sort()) !==
        JSON.stringify(expected.sort())
      )
        fail("mid-loop grant differs from its exact request");
      const done = st.completions.filter(
        (c) => c.line > st.boundary && c.id.startsWith("OOL-"),
      );
      if (done.some((c) => c.paths.includes(r.path)))
        fail("human-escalation-groundwork-repeat");
      if (distinct(done.map((c) => c.id)).length >= 2)
        fail("human-escalation-groundwork-threshold");
      if (
        distinct(
          st.attempts
            .filter((a) => a.role === role && a.caseId === r.id)
            .map((a) => a.turn),
        ).length >= 3
      )
        fail("groundwork request exhausted three attempts");
    }
    meta = structuredClone(meta);
    meta.request.sourceHash = hash(source);
  }
  if (role === "debate") {
    const id = oneLine(meta.caseId, "caseId"),
      c = ordinaryCounts(s, st)[id];
    if (!c || c.count < 3 || c.guide)
      fail("debate requires three failures and no current-cycle guideline");
    if (
      st.events.some(
        (e) =>
          e.type === "debate-failed" && e.caseId === id && e.line > st.boundary,
      )
    )
      fail("a debate already failed; human intervention is required");
  }
  const beforePath = path.join(s.dir, `${turn}.before.json`);
  emit(path.join(s.root, s.discussion), [
    event({
      type: "begin",
      run: s.run,
      turn,
      role,
      before: beforePath,
      request: meta.request?.id,
      caseId: meta.caseId,
      metaHash: hash(JSON.stringify(meta)),
    }),
  ]);
  const prefix = read(path.join(s.root, s.discussion));
  const snap = snapshot(s.root);
  const before = {
    turn,
    role,
    run: s.run,
    root: s.root,
    discussion: s.discussion,
    draft,
    meta,
    prefixLength: prefix.length,
    prefixHash: hash(prefix),
    snapshot: snap,
    git: gitState(s.root),
    fingerprint: fingerprint(s, snap),
  };
  save(beforePath, before);
  return {
    turn,
    role,
    draft: draft ? path.join(s.root, draft) : null,
    discussion: path.join(s.root, s.discussion),
    resource: "n/a",
    before: beforePath,
    turns: count + 1,
    meta,
  };
}
export function validateAppend(prefix, current, draft, role) {
  if (!current.startsWith(prefix))
    fail("discussion prefix was rewritten or truncated");
  const block = current.slice(prefix.length);
  if (!block || block !== draft || !block.endsWith("\n"))
    fail("discussion suffix is not exactly this complete draft once");
  const active = lex(block).filter((l) => l.active);
  const endings = active.filter((l) => /^END:/.test(l.s));
  if (
    endings.length !== 1 ||
    endings[0].s.trim() !== `END: ${UPPER[role]}` ||
    block.trimEnd().split(/\r?\n/).at(-1) !== `END: ${UPPER[role]}`
  )
    fail("expected exactly one final END for the dispatched role");
  const reserved =
    /^(WORK-EVENT:|HUMAN_REVIEW:|AUTO_REVIEW:|GROUNDWORK-COMPLETE:|DEBATE_GUIDELINE:|GUIDELINE:|BLOCKER:|INFO:)/;
  if (active.some((l) => reserved.test(l.s)))
    fail("worker forged an orchestrator/human record");
  if (
    role !== "test-engineer" &&
    active.some((l) => l.s.startsWith("IMPLEMENTATION_READY_FOR_REVIEW:"))
  )
    fail("readiness belongs only to test-engineer");
  if (
    active.filter((l) => l.s.startsWith("IMPLEMENTATION_READY_FOR_REVIEW:"))
      .length > 1
  )
    fail("duplicate ready marker");
  return block;
}
function validateEffects(s, b) {
  const after = snapshot(s.root),
    changed = delta(b.snapshot, after),
    violations = [];
  if (JSON.stringify(gitState(s.root)) !== JSON.stringify(b.git))
    violations.push("git HEAD/branch/index content changed");
  for (const p of changed) {
    try {
      inside(s.root, p);
    } catch (e) {
      violations.push(e.message);
      continue;
    }
    if (!WORKERS.includes(b.role)) {
      violations.push(`read-only role changed ${p}`);
      continue;
    }
    const result = lane(s.root, b.role, p);
    if (!result.allowed)
      violations.push(
        `lane violation: ${b.role} changed ${p}: ${result.reason}`,
      );
    const protocol = [b.draft, b.discussion].includes(p);
    if (p.startsWith(".agents/tdd/") && !protocol)
      violations.push(`non-owned protocol path: ${p}`);
    if (
      b.role === "groundwork-engineer" &&
      !protocol &&
      !b.meta.request.paths.includes(p)
    )
      violations.push(`permission violation: ungranted ${p}`);
  }
  if (violations.length) fail(violations.join("\n"));
  return { after, changed, fingerprint: fingerprint(s, after) };
}
function evidenceChecks(required, checks, block) {
  if (!Array.isArray(checks) || !checks.length)
    fail("positive check evidence required");
  if (
    checks.length !== required.length ||
    distinct(checks.map((c) => c.command)).length !== checks.length ||
    required.some((c) => !checks.some((x) => x.command === c))
  )
    fail("check evidence does not match the required command set");
  for (const c of checks) {
    if (
      c.exit !== 0 ||
      typeof c.output !== "string" ||
      typeof c.evidence !== "string" ||
      !c.evidence.trim() ||
      !block.includes(c.evidence) ||
      !c.evidence.includes(c.command) ||
      !c.evidence.includes(c.output)
    )
      fail(`missing/nonpassing transcript evidence: ${c.command}`);
    const exits = [
      ...c.evidence.matchAll(
        /(?:^|\n)\s*(?:[-*]\s*)?exit(?: code)?\s*(?::|=)?\s*(\d+)\s*(?=\n|$)/gi,
      ),
    ].map((m) => Number(m[1]));
    if (
      exits.length !== 1 ||
      exits[0] !== 0 ||
      required.some(
        (other) => other !== c.command && c.evidence.includes(other),
      )
    )
      fail(`ambiguous/missing command-local exit evidence: ${c.command}`);
    if (!c.output && !c.evidence.includes("stdout/stderr: <empty>"))
      fail(
        "silent command needs an explicit empty-output annotation, not invented output",
      );
  }
}
export function validateGroundwork(block, request, assessment) {
  const active = lex(block)
    .filter((l) => l.active)
    .map((l) => l.s);
  const failureIds = active
    .filter((s) => s.startsWith("ATTEMPT-FAILED:"))
    .map(
      (s) =>
        s.match(/^ATTEMPT-FAILED:\s+(.+?)\s+—\s+.+$/)?.[1] ??
        fail("malformed groundwork failure marker"),
    );
  const allowedIds =
    request.id === "00-groundwork" ? request.cases : [request.id];
  if (failureIds.some((id) => !allowedIds?.includes(id)))
    fail("groundwork failure ID does not match the dispatched request/cases");
  const blocked = active.some((s) => /^(OPEN:|ATTEMPT-FAILED:)/.test(s));
  const positive = active.includes("**Result.** PASS");
  if (!positive || blocked) {
    if (
      !active.includes("**Result.** BLOCKED") ||
      !blocked ||
      !active.some((s) => s.startsWith("ATTEMPT-FAILED:"))
    )
      fail(
        "groundwork needs an explicit PASS with proof or BLOCKED with failure markers",
      );
    return false;
  }
  if (
    assessment?.request !== request.id ||
    assessment?.instructionSatisfied !== true
  )
    fail("groundwork semantic assessment is missing/mismatched");
  if (
    !Array.isArray(assessment.applied) ||
    request.paths.some(
      (p) =>
        !assessment.applied.some(
          (a) =>
            a.path === p && a.evidence?.trim() && block.includes(a.evidence),
        ),
    )
  )
    fail("every granted path needs applied/already-satisfied evidence");
  evidenceChecks(request.checks, assessment.checks, block);
  return true;
}
function splitRow(line) {
  // Markdown tables must escape literal pipes; reject malformed rows instead of dropping fields.
  const cells = line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split(/(?<!\\)\|/)
    .map((s) => s.trim().replaceAll("\\|", "|"));
  return cells;
}
export function parseReview(report) {
  const a = lex(report).filter((l) => l.active),
    findings = [];
  let mode = null;
  const checks = [];
  let checkMode = false;
  for (const l of a) {
    if (/^### /.test(l.s)) checkMode = l.s === "### Verification evidence";
    if (!checkMode || !l.s.startsWith("|")) continue;
    const c = splitRow(l.s);
    if (c[0] === "Check" || c.every((x) => /^:?-+:?$/.test(x))) continue;
    if (c.length !== 4 || c.some((x) => !x))
      fail("review verification needs four nonempty columns");
    checks.push({
      check: c[0],
      command: c[1].replace(/^`(.*)`$/, "$1"),
      exit: c[2],
      output: c[3],
    });
  }
  for (const l of a) {
    if (/^### /.test(l.s))
      mode =
        l.s === "### Blockers"
          ? "BLOCKER"
          : l.s === "### Suggestions"
            ? "SUGGESTION"
            : null;
    if (!mode || !l.s.startsWith("|")) continue;
    const c = splitRow(l.s);
    if (c[0] === "#" || c.every((x) => /^:?-+:?$/.test(x))) continue;
    if (c.length !== 7 || c.some((x) => !x))
      fail("review findings require all seven columns including cited source");
    if (!/^action:(YES|NO)$/.test(c[1]))
      fail("missing/ambiguous finding action tag");
    findings.push({
      id: c[0],
      action: c[1].slice(7),
      severity: mode,
      location: c[2],
      dimension: c[3],
      issue: c[4],
      source: c[5],
      fix: c[6],
    });
  }
  if (distinct(findings.map((f) => f.id)).length !== findings.length)
    fail("duplicate review finding IDs");
  const verdict = a
    .map((l) => l.s)
    .join("\n")
    .match(/(?:^|\n)(?:- )?Verdict:\s*(?:\*\*)?(PASS|FAIL)\b/);
  if (!verdict) fail("missing explicit reviewer verdict");
  if (verdict[1] === "PASS" && findings.some((f) => f.severity === "BLOCKER"))
    fail("PASS contradicts blockers");
  if (verdict[1] === "FAIL" && !findings.some((f) => f.severity === "BLOCKER"))
    fail("FAIL without a cited blocker");
  for (const heading of [
    "Verification evidence",
    "Blockers",
    "Suggestions",
    "Per-file verdicts",
    "Acceptance criteria coverage",
  ])
    if (!a.some((l) => l.s === `### ${heading}`))
      fail(`missing review section: ${heading}`);
  return { verdict: verdict[1], findings, checks };
}
function finish(sp, opts) {
  const s = session(sp),
    st = stateOf(s);
  if (st.pending.length !== 1) fail("expected one in-flight dispatch");
  const pending = st.pending[0],
    b = json(pending.before);
  if (
    b.turn !== pending.turn ||
    b.run !== pending.run ||
    b.root !== s.root ||
    hash(JSON.stringify(b.meta)) !== pending.metaHash
  )
    fail("before-turn evidence mismatch");
  const current = read(path.join(s.root, s.discussion));
  const prefix = current.slice(0, b.prefixLength);
  if (!Number.isSafeInteger(b.prefixLength) || hash(prefix) !== b.prefixHash)
    fail("discussion prefix was rewritten or truncated");
  const effects = validateEffects(s, b),
    entries = [];
  let block,
    result = "accepted";
  if (WORKERS.includes(b.role)) {
    block = validateAppend(
      prefix,
      current,
      read(inside(s.root, b.draft, { existing: true })),
      b.role,
    );
    const startLine = lex(prefix).filter((l) => l.raw).length + 1,
      endLine = lex(current).filter((l) => l.raw).length;
    entries.push(
      event({
        type: "accepted",
        run: s.run,
        turn: b.turn,
        role: b.role,
        startLine,
        endLine,
        blockHash: hash(block),
        fingerprint: effects.fingerprint,
      }),
    );
    if (["test-engineer", "software-engineer"].includes(b.role)) {
      const a = opts.assessment
        ? json(opts.assessment)
        : fail(
            "an ordinary turn needs --assessment carrying the orchestrator semantic review",
          );
      if (a.turn !== b.turn || !Array.isArray(a.cases))
        fail("assessment must name this turn and its case array");
      for (const id of a.cases)
        if (!block.includes(oneLine(id, "assessed case")))
          fail(`assessed case is absent from the turn: ${id}`);
      if (
        typeof a.evidence !== "string" ||
        !a.evidence.trim() ||
        !block.includes(a.evidence)
      )
        fail(
          "assessment evidence must be an exact contiguous excerpt of this turn",
        );
      entries.push(
        event({ type: "assessed", turn: b.turn, role: b.role, cases: a.cases }),
      );
    }
    if (
      b.role === "groundwork-engineer" &&
      validateGroundwork(
        block,
        b.meta.request,
        opts.assessment ? json(opts.assessment) : null,
      )
    ) {
      const r = b.meta.request;
      entries.push(
        `GROUNDWORK-COMPLETE: ${r.id} — ${JSON.stringify(r.paths)}`,
        event({
          type: "groundwork",
          turn: b.turn,
          request: r.id,
          paths: r.paths,
          sourceHash: r.sourceHash,
          sourceFile: r.sourceFile,
        }),
      );
      result = "groundwork-complete";
    }
  } else {
    if (current !== prefix) fail("read-only dispatch changed discussion");
    entries.push(
      event({
        type: "accepted",
        run: s.run,
        turn: b.turn,
        role: b.role,
        fingerprint: effects.fingerprint,
      }),
    );
    if (b.role === "reviewer-engineer") {
      const report = read(opts.report ?? fail("--report required")),
        parsed = parseReview(report);
      if (
        !st.readyTurn ||
        st.events.some(
          (e) => e.type === "ready-rejected" && e.turn === st.readyTurn.turn,
        ) ||
        !st.readyChecks.some(
          (e) =>
            e.turn === st.readyTurn.turn && e.fingerprint === b.fingerprint,
        )
      )
        fail("review has no matching validated readiness");
      if (st.autoUsed)
        fail(
          "reviewer is not dispatched again after the single automatic repair pass",
        );
      const readyReceipt = LAST(
        st.readyChecks.filter(
          (e) =>
            e.turn === st.readyTurn.turn && e.fingerprint === b.fingerprint,
        ),
      );
      const required =
        readyReceipt.requirements ??
        fail("readiness receipt has no verification command manifest");
      const gateSource = section(
        read(inside(s.root, s.epic, { existing: true })),
        "Verification Gate",
      );
      const sourceGates = gateCommands(gateSource);
      if (
        !gateSource.includes(required.proof) ||
        !gateSource.includes(required.success)
      )
        fail(
          "the EPIC Proof changed since readiness; require a fresh test-engineer readiness turn",
        );
      const nonPassing = [];
      for (const command of distinct([...sourceGates, required.proof])) {
        const rows = parsed.checks.filter((c) => c.command === command);
        if (rows.length !== 1)
          fail(
            `review must independently account for required command: ${command}`,
          );
        const row = rows[0],
          pass = /^(?:exit[: ]*)?0$/.test(row.exit);
        if (
          parsed.verdict === "PASS" &&
          (!pass ||
            (command === required.proof &&
              !row.output.includes(required.success)))
        )
          fail("review PASS contradicts its mandatory verification evidence");
        if (!pass && !/^(?:exit[: ]*)?\d+$|^NOT_RUN(?:\b.*)?$/.test(row.exit))
          fail("ambiguous review verification result");
        if (!pass) nonPassing.push(command);
      }
      if (
        nonPassing.length &&
        !parsed.findings.some(
          (f) => f.action === "NO" && f.severity === "BLOCKER",
        )
      )
        fail(
          `a mandatory check that did not pass needs an action:NO blocker for the human: ${nonPassing.join(", ")}`,
        );
      entries.push(
        event({
          type: "review",
          turn: b.turn,
          readyTurn: st.readyTurn.turn,
          fingerprint: effects.fingerprint,
          ...parsed,
          report,
        }),
      );
      const yes = parsed.findings.filter((f) => f.action === "YES"),
        no = parsed.findings.filter((f) => f.action === "NO");
      if (yes.length)
        entries.push(
          `AUTO_REVIEW: FAIL — routing ${yes.length} action:YES finding(s); ${no.length} action:NO finding(s) retained for human decision.`,
          ...yes.map(
            (f) =>
              `BLOCKER: [${f.id}] [${f.severity}] ${f.location} — ${f.issue} — source: ${f.source} — required: ${f.fix}`,
          ),
        );
      for (const f of no)
        entries.push(
          `${f.severity === "BLOCKER" ? "NEEDS-HUMAN: BLOCKER" : "INFO"}: [${f.id}] ${f.location} — ${f.issue} — source: ${f.source} — required: ${f.fix}`,
        );
      result = yes.length ? "auto-repair" : "awaiting-human-review";
    } else {
      const g = opts.assessment ? json(opts.assessment) : null;
      const caseId = b.meta.caseId;
      if (!g || g.outcome === "FAILED") {
        entries.push(
          event({
            type: "debate-failed",
            caseId,
            reason: g?.reason ?? "no usable guideline",
            turn: b.turn,
          }),
        );
        result = "human-escalation";
      } else {
        if (
          g.caseId !== caseId ||
          !Array.isArray(g.files) ||
          !g.files.length ||
          !Array.isArray(g.steps) ||
          !g.steps.length
        )
          fail("invalid guideline assessment");
        oneLine(g.summary, "guideline summary");
        for (const p of g.files)
          if (
            !["test-engineer", "software-engineer"].some(
              (r) => lane(s.root, r, p).allowed,
            )
          )
            fail(`unusable guideline path: ${p}`);
        for (const step of g.steps) oneLine(step, "guideline step");
        entries.push(
          `DEBATE_GUIDELINE: ${caseId} — ${g.summary}`,
          ...g.steps.map((x) => `GUIDELINE: ${x}`),
        );
        result = "guideline-issued";
      }
    }
  }
  emit(path.join(s.root, s.discussion), entries);
  // Cleanup after accepted receipt/groundwork completion; never global-sweep another turn's files.
  if (b.draft) fs.rmSync(inside(s.root, b.draft), { force: true });
  return {
    status: result,
    turn: b.turn,
    changed: effects.changed,
    fingerprint: effects.fingerprint,
  };
}
function rejectReady(sp, reason) {
  const s = session(sp),
    st = stateOf(s),
    t = st.readyTurn;
  if (!t || st.pending.length) fail("no accepted ready candidate to reject");
  oneLine(reason, "rejection reason");
  if (!st.events.some((e) => e.type === "ready-rejected" && e.turn === t.turn))
    emit(path.join(s.root, s.discussion), [
      event({ type: "ready-rejected", turn: t.turn, reason }),
    ]);
  return {
    status: "premature-ready-rejected",
    nextRole: "test-engineer",
    reason,
  };
}
function planCases(root, epic) {
  const dir = `.agents/plan/stories/${path.basename(epic, ".md")}`;
  inside(root, dir, { existing: true });
  return fs
    .readdirSync(path.join(root, dir))
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((file) => {
      const p = `${dir}/${file}`,
        text = read(inside(root, p, { existing: true }));
      const verify = section(text, "Verify");
      const numbers = lex(verify)
        .filter((l) => l.active)
        .flatMap((l) => {
          const m = l.s.match(/^(\d+)[.)]\s+\S/);
          return m ? [Number(m[1])] : [];
        });
      if (
        !numbers.length ||
        (!numbers.every((n) => n === 1) && numbers.some((n, i) => n !== i + 1))
      )
        fail(
          `unsupported/unexpanded/nonsequential Verify cases: ${p}; use the author's numbered list, do not invent cases`,
        );
      return {
        path: p,
        cases: numbers.map((_, i) => `${path.basename(file, ".md")}#V${i + 1}`),
        groundwork: /^Executor:\s*groundwork-engineer\s*$/m.test(text),
        sourceHash: hash(text),
      };
    });
}
function ready(sp, assessmentPath) {
  const s = session(sp),
    st = stateOf(s),
    t = st.readyTurn,
    a = json(assessmentPath);
  if (!t || st.pending.length) fail("no latest accepted TE readiness turn");
  if (st.events.some((e) => e.type === "ready-rejected" && e.turn === t.turn))
    fail("rejected readiness requires a fresh TE turn");
  if (
    a.turn !== t.turn ||
    a.obligationsReviewed !== true ||
    a.unresolved?.length !== 0
  )
    fail(
      "readiness requires a current semantic review with no unresolved obligations",
    );
  const stories = planCases(s.root, s.epic),
    actual = stories.flatMap((x) => x.cases).sort();
  if (
    !stories.length ||
    !Array.isArray(a.cases) ||
    JSON.stringify([...a.cases].sort()) !== JSON.stringify(actual)
  )
    fail("readiness case set does not exactly match all story Verify cases");
  if (a.sourceCoverageReviewed !== true || a.storyGatesReviewed !== true)
    fail(
      "check EPIC Stories references, order, unexpanded/missing stories, and Change coverage against source",
    );
  const unevidenced = actual.filter((id) => !t.block.includes(id));
  if (unevidenced.length)
    fail(
      `the readiness turn does not name every case: ${unevidenced.join(", ")}`,
    );
  for (const x of stories.filter((x) => x.groundwork)) {
    const c = st.completions.filter(
      (c) =>
        c.id === path.basename(x.path, ".md") && c.sourceHash === x.sourceHash,
    );
    const want = groundworkPaths(read(path.join(s.root, x.path)));
    if (!want.length || want.some((p) => !c.some((y) => y.paths.includes(p))))
      fail(`unproven groundwork story: ${x.path}`);
  }
  if (!Array.isArray(a.gates) || !a.proof?.command || !a.proof.success?.trim())
    fail("full Gates and Proof evidence required");
  const gateSource = section(
    read(path.join(s.root, s.epic)),
    "Verification Gate",
  );
  if (a.gateSource !== gateSource)
    fail("assessment must quote the complete binding Verification Gate");
  evidenceChecks(gateCommands(gateSource), a.gates, t.block);
  evidenceChecks([a.proof.command], [a.proof], t.block);
  if (
    !a.proof.output.includes(a.proof.success) ||
    /^FAIL:/m.test(a.proof.output)
  )
    fail("Proof is missing its success string or reports FAIL");
  if (
    !gateSource.includes(a.proof.command) ||
    !gateSource.includes(a.proof.success)
  )
    fail("Proof evidence does not match binding source");
  const fp = fingerprint(s);
  if (!t.receipt || fp !== t.receipt.fingerprint)
    fail("working tree changed since TE verification; readiness is stale");
  if (!st.readyChecks.some((e) => e.turn === t.turn && e.fingerprint === fp))
    emit(path.join(s.root, s.discussion), [
      event({
        type: "ready",
        turn: t.turn,
        fingerprint: fp,
        cases: a.cases,
        requirements: {
          gates: a.gates.map((c) => c.command),
          proof: a.proof.command,
          success: a.proof.success,
        },
        sourceHashes: stories.map((x) => [x.path, x.sourceHash]),
      }),
    ]);
  return {
    status: "implementation-ready",
    turn: t.turn,
    cases: actual.length,
    stories: stories.length,
  };
}
export function gateCommands(gateSource) {
  const lines = lex(gateSource).filter((l) => l.active && /^Gates:/.test(l.s));
  if (!lines.length) fail("the Verification Gate declares no Gates: line");
  const commands = lines
    .flatMap((l) => [...l.s.matchAll(/`([^`]+)`/g)].map((m) => m[1].trim()))
    .filter(Boolean);
  if (!commands.length) fail("every Gates: command must be named in backticks");
  if (distinct(commands).length !== commands.length)
    fail("duplicate Gates: command");
  return commands;
}
export function groundworkPaths(text) {
  const a = lex(text),
    i = a.findIndex((l) => l.active && /^Paths:/.test(l.s));
  if (i < 0) fail("groundwork story has no Paths:");
  const inline = a[i].s.slice(6).trim();
  if (inline) return parsePaths(inline);
  const paths = [];
  for (const l of a.slice(i + 1)) {
    if (!l.s.trim() && !paths.length) continue;
    const m = l.active && l.s.match(/^\s*-\s+(.+)$/);
    if (!m) break;
    const p = m[1].replace(/^`(.*)`$/, "$1");
    paths.push(...parsePaths(p.startsWith("[") ? p : JSON.stringify([p])));
  }
  if (!paths.length) fail("groundwork Paths: is empty");
  return distinct(paths);
}
function ordinaryCounts(s, st) {
  // A genuine locked-path handoff does not consume an engineer/debate attempt.
  // False claims still count; every affected case is counted at most once per turn.
  const routed = new Set(
    st.allRequests
      .filter(
        (r) =>
          !["test-engineer", "software-engineer"].some(
            (role) => lane(s.root, role, r.path).allowed,
          ),
      )
      .map((r) => r.turn),
  );
  const counts = {};
  for (const id of distinct(
    st.attempts
      .filter((a) => a.role !== "groundwork-engineer")
      .map((a) => a.caseId),
  )) {
    const guide = LAST(
      st.guides.filter((g) => g.caseId === id && g.line > st.boundary),
    );
    const matching = st.attempts.filter(
      (a) =>
        a.caseId === id &&
        a.role !== "groundwork-engineer" &&
        !routed.has(a.turn) &&
        a.line > Math.max(st.boundary, guide?.line ?? 0),
    );
    counts[id] = {
      count: distinct(matching.map((a) => a.turn)).length,
      guide: guide ?? null,
    };
  }
  return counts;
}
function inspect(sp) {
  const s = session(sp),
    st = stateOf(s);
  const count = st.events.filter(
    (e) => e.type === "begin" && e.run === s.run,
  ).length;
  const routes = st.requests.map((r) => {
    const te = lane(s.root, "test-engineer", r.path).allowed,
      se = lane(s.root, "software-engineer", r.path).allowed,
      gw = lane(s.root, "groundwork-engineer", r.path).allowed;
    const done = st.completions.filter(
      (c) => c.line > st.boundary && c.id.startsWith("OOL-"),
    );
    return {
      ...r,
      route:
        te || se
          ? "engineer-owned"
          : !gw
            ? "human-locked"
            : done.some((c) => c.paths.includes(r.path))
              ? "human-repeat"
              : distinct(done.map((c) => c.id)).length >= 2
                ? "human-threshold"
                : "groundwork",
      grant:
        r.path === "package.json"
          ? ["package.json", "package-lock.json"]
          : [r.path],
      failures: distinct(
        st.attempts
          .filter((a) => a.role === "groundwork-engineer" && a.caseId === r.id)
          .map((a) => a.turn),
      ).length,
    };
  });
  const gpath = `.agents/plan/stories/${path.basename(s.epic, ".md")}/00-groundwork.md`;
  let groundwork = null;
  if (fs.existsSync(path.join(s.root, gpath))) {
    const text = read(inside(s.root, gpath, { existing: true }));
    if (/^Executor:\s*groundwork-engineer\s*$/m.test(text)) {
      const sourceHash = hash(text),
        wanted = groundworkPaths(text);
      const have = st.completions
        .filter((c) => c.id === "00-groundwork" && c.sourceHash === sourceHash)
        .flatMap((c) => c.paths);
      groundwork = {
        story: gpath,
        request: "00-groundwork",
        sourceHash,
        grant: wanted.filter((p) => !have.includes(p)),
        failures: distinct(
          st.attempts
            .filter(
              (a) =>
                a.role === "groundwork-engineer" &&
                a.caseId.startsWith("00-groundwork#") &&
                a.line > st.boundary,
            )
            .map((a) => a.turn),
        ).length,
      };
    }
  }
  const fp = st.readyTurn && !st.pending.length ? fingerprint(s) : null;
  const validReady = Boolean(
    st.readyTurn &&
    !st.events.some(
      (e) => e.type === "ready-rejected" && e.turn === st.readyTurn.turn,
    ) &&
    st.readyChecks.some(
      (e) => e.turn === st.readyTurn.turn && e.fingerprint === fp,
    ),
  );
  const currentReview = LAST(
    st.reviews.filter(
      (r) => r.readyTurn === st.readyTurn?.turn && r.fingerprint === fp,
    ),
  );
  const reviewView = (r) =>
    r
      ? {
          line: r.line,
          turn: r.turn,
          readyTurn: r.readyTurn,
          verdict: r.verdict,
          findings: r.findings,
        }
      : null;
  return {
    root: s.root,
    epic: s.epic,
    discussion: s.discussion,
    human: st.human,
    boundary: st.boundary,
    humanBoundary: st.humanBoundary,
    humanFailuresThisRun: st.markers.filter(
      (l) =>
        l.line >
          (st.events.find((e) => e.type === "run" && e.run === s.run)?.line ??
            0) && /^HUMAN_REVIEW: FAIL/.test(l.s),
    ).length,
    turns: count,
    maxTurns: s.maxTurns,
    capReached: !!s.maxTurns && count >= s.maxTurns,
    nextRole: st.next,
    pending: st.pending,
    groundwork,
    requests: routes,
    counts: ordinaryCounts(s, st),
    debateFailures: st.events.filter(
      (e) => e.type === "debate-failed" && e.line > st.boundary,
    ),
    readyCandidate: st.readyTurn && {
      turn: st.readyTurn.turn,
      start: st.readyTurn.start,
      end: st.readyTurn.end,
      rejected: st.events.some(
        (e) => e.type === "ready-rejected" && e.turn === st.readyTurn.turn,
      ),
    },
    validReady,
    autoUsed: st.autoUsed,
    currentReview: reviewView(currentReview),
    reviews: st.reviews.map(reviewView),
    lastTurns: ["test-engineer", "software-engineer"]
      .map((role) => LAST(st.turns.filter((t) => t.role === role)))
      .filter(Boolean)
      .map((t) => ({ role: t.role, turn: t.turn, start: t.start, end: t.end })),
    completions: st.completions,
    guides: st.guides.filter((g) => g.line > st.boundary),
  };
}
function scope(sp) {
  const s = session(sp),
    base = stateOf(s).header["base-ref"];
  const files = distinct(
    [
      ...git(s.root, [
        "diff",
        "--name-only",
        "--no-renames",
        "-z",
        base,
        "--",
      ]).split("\0"),
      ...git(s.root, [
        "ls-files",
        "--others",
        "--exclude-standard",
        "-z",
      ]).split("\0"),
    ].filter(Boolean),
  )
    .map(repoPath)
    .sort();
  return {
    root: s.root,
    epic: s.epic,
    discussion: s.discussion,
    base,
    files,
    fingerprint: fingerprint(s),
  };
}
function close(sp) {
  const s = session(sp),
    st = stateOf(s);
  if (st.pending.length)
    fail(
      "in-flight dispatch: preserve lock and evidence; finish or obtain operator-authorized abandonment",
    );
  emit(path.join(s.root, s.discussion), [
    event({ type: "run-end", run: s.run }),
  ]);
  fs.rmSync(s.lock, { recursive: true });
  return {
    status: "released",
    discussion: s.discussion,
    evidenceDirectory: s.dir,
    human: st.human,
  };
}
function abandon(sp, opts) {
  const s = session(sp),
    st = stateOf(s);
  if (opts["confirm-idle"] !== true || !opts["human-reason"])
    fail(
      "abandon requires explicit operator approval: --confirm-idle --human-reason",
    );
  if (st.pending.length !== 1) fail("expected one interrupted/rejected turn");
  emit(path.join(s.root, s.discussion), [
    event({
      type: "abandoned",
      turn: st.pending[0].turn,
      reason: oneLine(opts["human-reason"], "human reason"),
      run: s.run,
    }),
  ]);
  return {
    status: "abandoned-not-accepted",
    preserved: st.pending[0].before,
    next: "operator must inspect/repair tree and append HUMAN_REVIEW: FAIL with blockers before resuming",
  };
}
function args(argv) {
  const [command, ...a] = argv,
    opts = {};
  for (let i = 0; i < a.length; i++) {
    if (!a[i].startsWith("--")) fail(`unexpected argument: ${a[i]}`);
    const key = a[i].slice(2);
    if (Object.hasOwn(opts, key)) fail(`duplicate option: ${key}`);
    opts[key] = !a[i + 1] || a[i + 1].startsWith("--") ? true : a[++i];
  }
  return { command, opts };
}
export function main(argv) {
  const { command, opts: o } = args(argv);
  const options = {
    open: ["root", "epic", "max-turns", "discussion", "adopt-legacy"],
    state: ["session"],
    begin: ["session", "role", "meta"],
    finish: ["session", "assessment", "report"],
    ready: ["session", "assessment"],
    "reject-ready": ["session", "reason"],
    scope: ["session"],
    plan: ["session"],
    close: ["session"],
    abandon: ["session", "confirm-idle", "human-reason"],
  };
  if (!Object.hasOwn(options, command))
    fail("commands: " + Object.keys(options).join(", "));
  for (const [key, value] of Object.entries(o)) {
    if (!options[command].includes(key))
      fail(`unknown option for ${command}: --${key}`);
    if (["adopt-legacy", "confirm-idle"].includes(key)) {
      if (value !== true) fail(`--${key} is a flag and takes no value`);
    } else if (value === true) fail(`--${key} requires a value`);
  }
  if (command === "open") return openSession(o);
  const sp = o.session ?? fail("--session is required");
  switch (command) {
    case "state":
      return inspect(sp);
    case "begin":
      return begin(sp, o.role, o.meta ? json(o.meta) : {});
    case "finish":
      return finish(sp, o);
    case "ready":
      return ready(sp, o.assessment ?? fail("--assessment required"));
    case "reject-ready":
      return rejectReady(sp, o.reason ?? fail("--reason required"));
    case "scope":
      return scope(sp);
    case "plan": {
      const s = session(sp);
      return planCases(s.root, s.epic);
    }
    case "close":
      return close(sp);
    case "abandon":
      return abandon(sp, o);
    default:
      fail(
        "commands: open, state, begin, finish, ready, reject-ready, scope, plan, close, abandon",
      );
  }
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    console.log(JSON.stringify(main(process.argv.slice(2)), null, 2));
  } catch (e) {
    console.error(JSON.stringify({ status: "STOP", error: e.message }));
    process.exitCode = 1;
  }
}
