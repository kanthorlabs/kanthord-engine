import { createHash, randomBytes } from "node:crypto";
import type { CredentialStore } from "@earendil-works/pi-ai";
import type {
  InlineExtension,
  ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import { SecretShape } from "../../custody/contract.ts";
import { isObject, isString } from "../../kernel/values.ts";
import {
  findKnownText,
  findPatternText,
  KNOWN_VALUE_MIN_CHARACTERS,
  knownMatcher,
  mapSensitiveStrings,
  markerIndex,
  markerTag,
  mergeSpans,
  promotes,
  replaceSpans,
  SCAN_FAILED,
  SENSITIVE_VALUE_MAX_CHARACTERS,
  SensitiveRule,
  type SensitiveSpan,
  SESSION_MARKER_PATTERN,
  sessionMarker,
} from "../sensitive-text.ts";

export type KnownSecrets = () => Promise<readonly string[]>;

export interface RedactionCounts {
  redacted: Partial<Record<SensitiveRule, number>>;
  scan_failed: number;
  unkept: number;
  restore_blocked: number;
  compaction_residual: number;
  thinking_kept: number;
}

export interface SensitiveTextRedaction {
  restore: InlineExtension;
  hook: InlineExtension;
  text(value: string): Promise<string>;
  counts(): RedactionCounts;
}

export const REDACTION_TABLE_MAX = 4096;
export const REDACTION_LOG_MESSAGE = "sensitive text redacted";

export interface RedactionSummary {
  redaction_count: number;
  redaction_rules: SensitiveRule[];
  redaction_failed: number;
  unkept: number;
  restore_blocked: number;
  compaction_residual: number;
  thinking_kept: number;
}

export function redactionSummary(counts: RedactionCounts): RedactionSummary {
  const rules = (Object.keys(counts.redacted) as SensitiveRule[])
    .filter((rule) => counts.redacted[rule])
    .sort();
  return {
    redaction_count: rules.reduce(
      (sum, rule) => sum + (counts.redacted[rule] ?? 0),
      0,
    ),
    redaction_rules: rules,
    redaction_failed: counts.scan_failed,
    unkept: counts.unkept,
    restore_blocked: counts.restore_blocked,
    compaction_residual: counts.compaction_residual,
    thinking_kept: counts.thinking_kept,
  };
}

export function redactionObserved(summary: RedactionSummary): boolean {
  return Object.values(summary).some((value) =>
    Array.isArray(value) ? value.length : value,
  );
}

export const RestoreReason = {
  Unkept:
    "The input holds a value that this session could not keep. Read the source of the value again, then repeat the call.",
  Resume:
    "The input holds a marker of an earlier run of this session. Read the source of the value again, then repeat the call.",
  Credential:
    "The input holds a marker of the LLM credential. No tool receives this value.",
  Shell:
    "A command cannot hold a masked value. To write the value into a file, use the write or edit tool. Otherwise read the value through the shell from its source, for example with $(sed -n ...), then repeat the call.",
} as const;
export type RestoreReason = (typeof RestoreReason)[keyof typeof RestoreReason];

const TAG_PART_CHARACTERS = 8;
const HEX_CHARACTERS_PER_BYTE = 2;
const TAG_PART_BYTES = TAG_PART_CHARACTERS / HEX_CHARACTERS_PER_BYTE;
const UNKEPT_INDEX = 0;
const NOT_FOUND = -1;
const NESTED_CALL_SEPARATOR = "/";
const RESTORE_TOOLS: ReadonlySet<string> = new Set(["write", "edit"]);
const SHELL_TOOL = "bash";
const REDACTED_ROLES: ReadonlySet<string> = new Set([
  "system",
  "user",
  "assistant",
  "toolResult",
  "custom",
]);
const ASSISTANT_ROLE = "assistant";
const TOOL_RESULT_ROLE = "toolResult";
const CUSTOM_ROLE = "custom";
const COMPACTION_SUMMARY_ROLE = "compactionSummary";
const THINKING_TYPE = "thinking";
const TEXT_TYPE = "text";
const REASONING_FIELD_API = "openai-completions";
const REASONING_FIELDS: ReadonlySet<string> = new Set([
  "reasoning",
  "reasoning_content",
  "reasoning_text",
]);
const CONTENT_KEY = "content";

export function credentialSecrets(
  store: CredentialStore,
  providerId: string,
): KnownSecrets {
  return async () => {
    const stored = await store.read(providerId);
    if (stored === undefined) return [];
    if (stored.type === SecretShape.OAuth)
      return [stored.access, stored.refresh];
    return stored.key === undefined ? [] : [stored.key];
  };
}

export function mergedSecrets(sources: readonly KnownSecrets[]): KnownSecrets {
  const seen = new Set<string>();
  return async () => {
    for (const secrets of await Promise.all(sources.map((source) => source())))
      for (const secret of secrets) seen.add(secret);
    return [...seen];
  };
}

interface TableEntry {
  index: number;
  rule: SensitiveRule;
  value: string;
}

type Message = Record<string, unknown>;

function sessionPartOf(sessionId: string): string {
  return createHash("sha256")
    .update(sessionId)
    .digest("hex")
    .slice(0, TAG_PART_CHARACTERS);
}

function outermostCall(event: ToolCallEvent): string {
  return (event.parentToolCallId ?? event.toolCallId).split(
    NESTED_CALL_SEPARATOR,
  )[0]!;
}

function keptThinking(message: Message, block: unknown): boolean {
  if (!isObject(block)) return false;
  const record = block as Record<string, unknown>;
  if (record.type !== THINKING_TYPE) return false;
  const signature = record.thinkingSignature;
  if (
    message.api === REASONING_FIELD_API &&
    isString(signature) &&
    REASONING_FIELDS.has(signature)
  )
    return false;
  return record.redacted === true || (isString(signature) && !!signature);
}

function stringsOf(value: unknown): string[] {
  const strings: string[] = [];
  mapSensitiveStrings(value, (text) => {
    strings.push(text);
    return text;
  });
  return strings;
}

export function sensitiveTextRedaction(
  known: KnownSecrets,
  sessionId: string,
): SensitiveTextRedaction {
  const sessionPart = markerTag(sessionPartOf(sessionId));
  const tag =
    sessionPart + markerTag(randomBytes(TAG_PART_BYTES).toString("hex"));
  const matcher = knownMatcher();
  const secretMatcher = knownMatcher();
  const secrets = new Set<string>();
  const byValue = new Map<string, TableEntry>();
  const byIndex = new Map<number, TableEntry>();
  const pending = new Map<string, string[]>();
  const counts: RedactionCounts = {
    redacted: {},
    scan_failed: 0,
    unkept: 0,
    restore_blocked: 0,
    compaction_residual: 0,
    thinking_kept: 0,
  };
  const failedMarker = sessionMarker(SCAN_FAILED, UNKEPT_INDEX, tag);
  let residual = false;

  const refresh = async () => {
    let current: readonly string[];
    try {
      current = await known();
    } catch {
      return;
    }
    for (const secret of current) {
      if (!secret || secrets.has(secret)) continue;
      secrets.add(secret);
      matcher.addSecret(secret);
      secretMatcher.addSecret(secret);
    }
  };

  const remember = (value: string, rule: SensitiveRule) => {
    const existing = byValue.get(value);
    if (existing) return existing;
    if (
      byValue.size >= REDACTION_TABLE_MAX ||
      value.length > SENSITIVE_VALUE_MAX_CHARACTERS
    )
      return undefined;
    const entry = { index: byValue.size + 1, rule, value };
    byValue.set(value, entry);
    byIndex.set(entry.index, entry);
    return entry;
  };

  const learn = (span: SensitiveSpan) => {
    if (!remember(span.value, span.rule)) return;
    if (promotes(span.value, span.rule))
      matcher.add({ value: span.value, rule: span.rule });
  };

  const markerOf = (text: string, span: SensitiveSpan) => {
    const exact = text.slice(span.start, span.end);
    const entry = exact === span.value ? remember(exact, span.rule) : undefined;
    if (entry && span.rule === SensitiveRule.LlmCredential)
      entry.rule = SensitiveRule.LlmCredential;
    if (!entry) {
      counts.unkept++;
      return sessionMarker(span.rule, UNKEPT_INDEX, tag);
    }
    if (residual) counts.compaction_residual++;
    else counts.redacted[entry.rule] = (counts.redacted[entry.rule] ?? 0) + 1;
    return sessionMarker(entry.rule, entry.index, tag);
  };

  const exactSpans = (text: string, values: readonly string[]) => {
    const spans: SensitiveSpan[] = [];
    for (const value of values) {
      const entry = byValue.get(value);
      if (!entry) continue;
      for (
        let at = text.indexOf(value);
        at !== NOT_FOUND;
        at = text.indexOf(value, at + value.length)
      )
        spans.push({
          rule: entry.rule,
          start: at,
          end: at + value.length,
          value,
        });
    }
    return spans;
  };

  const redactStrings = (
    strings: readonly string[],
    extra: readonly string[],
  ): Map<string, string> => {
    const firstPass = new Map<string, SensitiveSpan[] | undefined>();
    for (const text of strings) {
      if (firstPass.has(text)) continue;
      try {
        const spans = findPatternText(text);
        for (const span of spans) learn(span);
        firstPass.set(text, spans);
      } catch {
        firstPass.set(text, undefined);
      }
    }
    const result = new Map<string, string>();
    for (const [text, pattern] of firstPass) {
      if (!pattern) {
        counts.scan_failed++;
        result.set(text, failedMarker);
        continue;
      }
      try {
        const spans = mergeSpans(
          text,
          [...findKnownText(text, matcher), ...exactSpans(text, extra)],
          pattern,
        );
        result.set(
          text,
          replaceSpans(text, spans, (span) => markerOf(text, span)),
        );
      } catch {
        counts.scan_failed++;
        result.set(text, failedMarker);
      }
    }
    return result;
  };

  const keepThinking = (block: Record<string, unknown>) => {
    for (const text of stringsOf([block.thinking, block.thinkingSignature]))
      try {
        const pattern = findPatternText(text);
        for (const span of pattern) learn(span);
        counts.thinking_kept += mergeSpans(
          text,
          findKnownText(text, matcher),
          pattern,
        ).length;
      } catch {
        counts.scan_failed++;
      }
  };

  const redactMessage = (message: Message, extra: readonly string[]) => {
    const content = message[CONTENT_KEY];
    const blocks = Array.isArray(content) ? content : undefined;
    const kept =
      message.role === ASSISTANT_ROLE && blocks
        ? new Set(blocks.filter((block) => keptThinking(message, block)))
        : new Set<unknown>();
    for (const block of kept) keepThinking(block as Record<string, unknown>);
    const free = message.role === CUSTOM_ROLE;
    const walk = (transform: (text: string) => string): Message => {
      const rest = mapSensitiveStrings(
        { ...message, [CONTENT_KEY]: undefined },
        transform,
      ) as Message;
      const mapped = blocks
        ? blocks.map((block) =>
            kept.has(block)
              ? block
              : mapSensitiveStrings(block, transform, free),
          )
        : mapSensitiveStrings(content, transform, free);
      const copy = { ...rest, [CONTENT_KEY]: mapped };
      if (!(CONTENT_KEY in message)) delete copy[CONTENT_KEY];
      return copy;
    };
    const strings: string[] = [];
    walk((text) => {
      strings.push(text);
      return text;
    });
    const replaced = redactStrings(strings, extra);
    let changed = false;
    const copy = walk((text) => {
      const next = replaced.get(text) ?? text;
      changed ||= next !== text;
      return next;
    });
    return changed ? copy : undefined;
  };

  const failedMessage = (message: Message): Message => {
    counts.scan_failed++;
    try {
      return mapSensitiveStrings(message, () => failedMarker) as Message;
    } catch {
      return {
        role: message.role,
        ...(message.role === TOOL_RESULT_ROLE
          ? { toolCallId: message.toolCallId, toolName: message.toolName }
          : {}),
        [CONTENT_KEY]: [{ type: TEXT_TYPE, text: failedMarker }],
        timestamp: message.timestamp,
      };
    }
  };

  const restoreInput = (event: ToolCallEvent): RestoreReason | undefined => {
    const writes = RESTORE_TOOLS.has(event.toolName);
    const shell = event.toolName === SHELL_TOOL;
    let reason: RestoreReason | undefined;
    const block = (next: RestoreReason) => {
      if (reason !== RestoreReason.Credential) reason = next;
    };
    const restored: string[] = [];
    const restoreText = (text: string) =>
      text.replace(
        SESSION_MARKER_PATTERN,
        (whole, rule: string, index: string, markerTag: string) => {
          if (!markerTag.startsWith(sessionPart)) return whole;
          const entry =
            markerTag === tag ? byIndex.get(markerIndex(index)) : undefined;
          if (
            entry?.rule === SensitiveRule.LlmCredential ||
            rule === SensitiveRule.LlmCredential
          ) {
            block(RestoreReason.Credential);
            return whole;
          }
          if (shell) {
            reason ??= RestoreReason.Shell;
            return whole;
          }
          if (!writes) return whole;
          if (markerTag !== tag) {
            reason ??= RestoreReason.Resume;
            return whole;
          }
          if (!entry) {
            reason ??= RestoreReason.Unkept;
            return whole;
          }
          restored.push(entry.value);
          return entry.value;
        },
      );
    const input = event.input as Record<string, unknown>;
    const copy = mapSensitiveStrings(input, restoreText, true) as Record<
      string,
      unknown
    >;
    for (const value of restored)
      if (findKnownText(value, secretMatcher).length)
        block(RestoreReason.Credential);
    if (reason) return reason;
    if (!restored.length) return undefined;
    for (const key of Object.keys(input)) input[key] = copy[key];
    const owner = outermostCall(event);
    for (const value of restored) {
      const entry = byValue.get(value)!;
      if (
        promotes(value, entry.rule) ||
        value.length >= KNOWN_VALUE_MIN_CHARACTERS
      )
        matcher.add({ value, rule: entry.rule });
      else pending.set(owner, [...(pending.get(owner) ?? []), value]);
    }
    return undefined;
  };

  const restore: InlineExtension = (pi) => {
    pi.on("tool_call", (event) => {
      let reason: RestoreReason | undefined;
      try {
        reason = restoreInput(event);
      } catch {
        reason = RestoreReason.Unkept;
      }
      if (!reason) return undefined;
      counts.restore_blocked++;
      if (outermostCall(event) === event.toolCallId)
        pending.delete(event.toolCallId);
      return { block: true, reason };
    });
    pi.on("agent_end", () => {
      pending.clear();
    });
  };

  const redactEvent = (message: Message) => {
    const owner =
      message.role === TOOL_RESULT_ROLE ? String(message.toolCallId) : "";
    const extra = pending.get(owner) ?? [];
    pending.delete(owner);
    try {
      return redactMessage(message, extra);
    } catch {
      return failedMessage(message);
    }
  };

  const hook: InlineExtension = (pi) => {
    pi.on("turn_start", async () => {
      await refresh();
    });
    pi.on("message_end", async (event) => {
      const message = event.message as unknown as Message;
      if (!REDACTED_ROLES.has(String(message.role))) return undefined;
      if (message.role === ASSISTANT_ROLE) await refresh();
      const copy = redactEvent(message);
      return copy ? { message: copy as typeof event.message } : undefined;
    });
    pi.on("context", (event) => {
      let changed = false;
      const messages = event.messages.map((message) => {
        const record = message as unknown as Message;
        if (record.role === COMPACTION_SUMMARY_ROLE) {
          const summary = String(record.summary);
          let next: string;
          try {
            next = redactStrings([summary], []).get(summary)!;
          } catch {
            next = failedMarker;
          }
          if (next === summary) return message;
          changed = true;
          return { ...message, summary: next } as typeof message;
        }
        if (record.role !== CUSTOM_ROLE) return message;
        const copy = redactEvent(record);
        if (!copy) return message;
        changed = true;
        return copy as unknown as typeof message;
      });
      return changed ? { messages } : undefined;
    });
    pi.on("session_compact", (event) => {
      const summary = event.compactionEntry.summary;
      residual = true;
      try {
        event.compactionEntry.summary = redactStrings([summary], []).get(
          summary,
        )!;
      } catch {
        event.compactionEntry.summary = failedMarker;
      } finally {
        residual = false;
      }
    });
  };

  return {
    restore,
    hook,
    text: async (value) => {
      await refresh();
      return redactStrings([value], []).get(value)!;
    },
    counts: () => structuredClone(counts),
  };
}
