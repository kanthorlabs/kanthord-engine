import assert from "node:assert/strict";
import { isObject, isString } from "../kernel/values.ts";

export const SensitiveRule = {
  LlmCredential: "llm_credential",
  AwsAccessKeyId: "aws_access_key_id",
  AwsSigningKey: "aws_signing_key",
  AwsSessionToken: "aws_session_token",
  UrlUserinfo: "url_userinfo",
  GoMysqlDsn: "go_mysql_dsn",
  PrivateKey: "private_key",
  PlatformToken: "platform_token",
  ChatToken: "chat_token",
  SaasToken: "saas_token",
  GoogleCloudKey: "google_cloud_key",
  LlmProviderKey: "llm_provider_key",
  QuotedAssignment: "quoted_assignment",
  EnvAssignment: "env_assignment",
  ConnectionSecret: "connection_secret",
  HttpCredential: "http_credential",
  Jwt: "jwt",
  CredentialFile: "credential_file",
} as const;
export type SensitiveRule = (typeof SensitiveRule)[keyof typeof SensitiveRule];

export const SCAN_FAILED = "scan_failed";
export const SENSITIVE_VALUE_MAX_CHARACTERS = 16384;
export const SENSITIVE_NAME_MAX_CHARACTERS = 256;
export const LINE_PREFIX_MAX_CHARACTERS = 512;
export const TOKEN_MAX_CHARACTERS = 512;
export const ASSIGNMENT_VALUE_MIN_CHARACTERS = 8;
export const KNOWN_VALUE_MIN_CHARACTERS = 12;
export const KNOWN_VALUE_MIN_ENTROPY_BITS = 3.25;
export const KNOWN_PART_MIN_CHARACTERS = 12;
export const INDEXED_PREFIX_CHARACTERS = 32;
export const KNOWN_PREFIX_PATTERN = /^[a-z]{2,8}(?:[-_][a-z0-9]{2,8}){0,3}[-_]/;
const BASE64_PEM_WIDTH = 64;
const BASE64_MIME_WIDTH = 76;
export const BASE64_WRAP_WIDTHS = [
  BASE64_PEM_WIDTH,
  BASE64_MIME_WIDTH,
] as const;
const JWT_HEADER_MIN_CHARACTERS = 11;
const JWT_PAYLOAD_MIN_CHARACTERS = 11;
const JWT_SIGNATURE_MIN_CHARACTERS = 16;
export const JWT_SEGMENT_MIN_CHARACTERS = [
  JWT_HEADER_MIN_CHARACTERS,
  JWT_PAYLOAD_MIN_CHARACTERS,
  JWT_SIGNATURE_MIN_CHARACTERS,
] as const;
export const COMMAND_ARGUMENTS_MAX_CHARACTERS = 512;
export const SENSITIVE_SCAN_MAX_CHARACTERS = 8388608;

export interface SensitiveSpan {
  rule: SensitiveRule;
  start: number;
  end: number;
  value: string;
}

export interface KnownValue {
  value: string;
  rule: SensitiveRule;
}

export interface KnownMatcher {
  add(value: KnownValue): void;
  addSecret(secret: string): void;
  size(): number;
}

const V = SENSITIVE_VALUE_MAX_CHARACTERS;
const NM = SENSITIVE_NAME_MAX_CHARACTERS;
const T = TOKEN_MAX_CHARACTERS;
const A = ASSIGNMENT_VALUE_MIN_CHARACTERS;
const C = COMMAND_ARGUMENTS_MAX_CHARACTERS;
const H = "[^\\S\\n]";
const P = `(?:[^\\n]{0,${LINE_PREFIX_MAX_CHARACTERS}}?:\\d+[:-]${H}?|[^\\n]{0,${LINE_PREFIX_MAX_CHARACTERS}}?-\\d+-${H}?|[+\\- ]${H}*\\d+${H}|[+-]${H}?|${H}*\\d+\\t)?`;
const DNS_HOST_MAX_CHARACTERS = 253;
const TABLE_VALUE_RANK = 0.5;
const BITS_BASE = 2;
const BYTE_BITS = 8;
const BASE64_DIGIT_BITS = 6;
const BASE64_GROUP_BYTES = 3;
const BASE64_OFFSETS = Array.from(
  { length: BASE64_GROUP_BYTES },
  (_, offset) => offset,
);
const BASE64_ENCODINGS = ["base64", "base64url"] as const;
const HEX_DIGITS = 16;
const LINE_END = "\n";
const CARRIAGE_RETURN = "\r";
const SEGMENT_DOT = ".";
const ESCAPE_CHARACTER = "\\";
const UNICODE_ESCAPE = "u";
const SIMPLE_ESCAPE_LENGTH = 2;
const UNICODE_ESCAPE_LENGTH = 6;
const COLON = ":";
const NO_MATCH = -1;
const TEXT_START = 0;
const ROOT_NODE = 0;
const HEADER_SEGMENT = 0;
const PAYLOAD_SEGMENT = 1;
const MIN_WRAP_LINES = 2;
const NO_NEWLINE = -2;
const JWT_START = "eyJ";
const JWT_SEGMENTS = 3;
const TRUNCATION_TEXT = "... [truncated]";
const MARKER_START = "<redacted:";
const LETTER_BASE = "a".charCodeAt(0);
const DECIMAL_RADIX = 10;
const HEX_RADIX = 16;
const GO_DSN_ANCHORS = ["@tcp(", "@unix("] as const;

const ORDERED_RULES: readonly SensitiveRule[] = Object.values(SensitiveRule);
const RULE_RANKS: ReadonlyMap<SensitiveRule, number> = new Map(
  ORDERED_RULES.map((rule, index) => [rule, index]),
);
const MARKER_RULES = [...ORDERED_RULES, SCAN_FAILED].join("|");

export const SESSION_MARKER_PATTERN = new RegExp(
  `<redacted:(?<rule>${MARKER_RULES}):(?<index>a|[b-j][a-j]{0,9}):(?<tag>[a-p]{16})>`,
  "g",
);
const ANY_MARKER_PATTERN = new RegExp(
  `<redacted:(?:${MARKER_RULES})(?::(?:a|[b-j][a-j]{0,9}):[a-p]{16})?>`,
  "g",
);

export function sessionMarker(
  rule: SensitiveRule | typeof SCAN_FAILED,
  index: number,
  tag: string,
): string {
  return `<redacted:${rule}:${shiftedLetters(String(index), DECIMAL_RADIX)}:${tag}>`;
}

function shiftedLetters(digits: string, radix: number): string {
  return Array.from(digits, (digit) =>
    String.fromCharCode(LETTER_BASE + parseInt(digit, radix)),
  ).join("");
}

export function markerTag(hex: string): string {
  return shiftedLetters(hex, HEX_RADIX);
}

export function markerIndex(letters: string): number {
  return Number(
    Array.from(letters, (letter) => letter.charCodeAt(0) - LETTER_BASE).join(
      "",
    ),
  );
}

export function tracerMarker(rule: SensitiveRule | typeof SCAN_FAILED): string {
  return `<redacted:${rule}>`;
}

const PROMOTED_RULES: ReadonlySet<SensitiveRule> = new Set([
  SensitiveRule.LlmCredential,
  SensitiveRule.AwsAccessKeyId,
  SensitiveRule.AwsSigningKey,
  SensitiveRule.AwsSessionToken,
  SensitiveRule.PrivateKey,
  SensitiveRule.PlatformToken,
  SensitiveRule.ChatToken,
  SensitiveRule.SaasToken,
  SensitiveRule.GoogleCloudKey,
  SensitiveRule.LlmProviderKey,
  SensitiveRule.Jwt,
]);
const FIXTURE_LINE_RULES: ReadonlySet<SensitiveRule> = new Set([
  SensitiveRule.AwsSigningKey,
  SensitiveRule.AwsSessionToken,
  SensitiveRule.UrlUserinfo,
  SensitiveRule.GoMysqlDsn,
  SensitiveRule.QuotedAssignment,
  SensitiveRule.EnvAssignment,
  SensitiveRule.ConnectionSecret,
  SensitiveRule.HttpCredential,
  SensitiveRule.CredentialFile,
]);
const LOCAL_HOST_RULES: ReadonlySet<SensitiveRule> = new Set([
  SensitiveRule.UrlUserinfo,
  SensitiveRule.GoMysqlDsn,
]);
const FIXTURE_SECRET_RULES: ReadonlySet<SensitiveRule> = new Set([
  SensitiveRule.UrlUserinfo,
  SensitiveRule.GoMysqlDsn,
  SensitiveRule.QuotedAssignment,
  SensitiveRule.EnvAssignment,
  SensitiveRule.ConnectionSecret,
  SensitiveRule.CredentialFile,
]);
const PLACEHOLDER_RULES: ReadonlySet<SensitiveRule> = new Set([
  SensitiveRule.UrlUserinfo,
  SensitiveRule.GoMysqlDsn,
  SensitiveRule.QuotedAssignment,
  SensitiveRule.EnvAssignment,
  SensitiveRule.ConnectionSecret,
  SensitiveRule.HttpCredential,
  SensitiveRule.CredentialFile,
]);
const LOCAL_HOST = /^(?:localhost|127\.0\.0\.1|192\.168\.\d{1,3}\.\d{1,3})$/;
const FIXTURE_SECRET = /^(?:debug_|test_)/;
const PLACEHOLDER = /^[$<{]/;
const CURL_USER_IDS = /^\d+:\d+$/;

const STRUCTURAL_KEYS: ReadonlySet<string> = new Set([
  "type",
  "role",
  "id",
  "toolCallId",
  "toolName",
  "customType",
  "api",
  "provider",
  "model",
  "stopReason",
  "timestamp",
  "mimeType",
  "textSignature",
  "thinkingSignature",
  "thoughtSignature",
  "namespace",
  "responseId",
]);
const FREE_KEYS: ReadonlySet<string> = new Set([
  "arguments",
  "details",
  "nestedCalls",
  "sections",
  "toolsAdded",
]);
const IMAGE_TYPE = "image";
const IMAGE_DATA_KEY = "data";

interface Span {
  rule: SensitiveRule;
  start: number;
  end: number;
  value: string;
  rank: number;
}

interface View {
  text: string;
  source(start: number, end: number): [number, number];
}

function identityView(text: string): View {
  return { text, source: (start, end) => [start, end] };
}

const SIMPLE_ESCAPES: ReadonlyMap<string, string> = new Map([
  ["n", "\n"],
  ["r", "\r"],
  ["t", "\t"],
  ["b", "\b"],
  ["f", "\f"],
  ['"', '"'],
  ["'", "'"],
  ["\\", "\\"],
  ["/", "/"],
]);
const ESCAPE_PRESENT = /\\(?:[nrtbf"'\\/]|u[0-9a-fA-F]{4})/;
const UNICODE_DIGITS = /^[0-9a-fA-F]{4}$/;

function escapedView(text: string): View | undefined {
  if (!ESCAPE_PRESENT.test(text)) return undefined;
  const parts: string[] = [];
  const viewStarts: number[] = [];
  const sourceStarts: number[] = [];
  const sourceEnds: number[] = [];
  let copied = 0;
  let viewLength = 0;
  for (
    let at = text.indexOf(ESCAPE_CHARACTER);
    at !== NO_MATCH && at + 1 < text.length;
    at = text.indexOf(ESCAPE_CHARACTER, at)
  ) {
    const next = text[at + 1]!;
    const digits = text.slice(
      at + SIMPLE_ESCAPE_LENGTH,
      at + UNICODE_ESCAPE_LENGTH,
    );
    let decoded = SIMPLE_ESCAPES.get(next);
    let consumed = SIMPLE_ESCAPE_LENGTH;
    if (
      decoded === undefined &&
      next === UNICODE_ESCAPE &&
      UNICODE_DIGITS.test(digits)
    ) {
      decoded = String.fromCharCode(Number.parseInt(digits, HEX_DIGITS));
      consumed = UNICODE_ESCAPE_LENGTH;
    }
    if (decoded === undefined) {
      at++;
      continue;
    }
    parts.push(text.slice(copied, at), decoded);
    viewLength += at - copied;
    viewStarts.push(viewLength);
    sourceStarts.push(at);
    sourceEnds.push(at + consumed);
    viewLength++;
    copied = at + consumed;
    at = copied;
  }
  parts.push(text.slice(copied));
  const locate = (index: number): [number, number] => {
    let low = 0;
    let high = viewStarts.length - 1;
    let found = NO_MATCH;
    while (low <= high) {
      const middle = (low + high) >>> 1;
      if (viewStarts[middle]! <= index) {
        found = middle;
        low = middle + 1;
      } else high = middle - 1;
    }
    if (found === NO_MATCH) return [index, index + 1];
    if (viewStarts[found] === index)
      return [sourceStarts[found]!, sourceEnds[found]!];
    const source = sourceEnds[found]! + index - viewStarts[found]! - 1;
    return [source, source + 1];
  };
  return {
    text: parts.join(""),
    source: (start, end) => [locate(start)[0], locate(end - 1)[1]],
  };
}

function lowerIncludes(
  context: ScanContext,
  literals: readonly string[],
): boolean {
  return literals.some((literal) => {
    let present = context.present.get(literal);
    if (present === undefined) {
      present = context.lower.includes(literal);
      context.present.set(literal, present);
    }
    return present;
  });
}

interface ScanContext {
  text: string;
  lower: string;
  present: Map<string, boolean>;
  fixtures: [number, number][] | undefined;
}

const FIXTURE_PATTERN = new RegExp(
  `^${P}${H}*(?:-${H}+|export${H}+)?(?:E2E_|TEST_|DEBUG_)[A-Za-z0-9_]{0,${NM}}(?:=|:${H}+)(?<value>"[^"\\n]*"|'[^'\\n]*'|\\S*)`,
  "gmd",
);
const FIXTURE_LITERALS = ["e2e_", "test_", "debug_"];

function fixtureSpans(context: ScanContext): [number, number][] {
  if (context.fixtures) return context.fixtures;
  const spans: [number, number][] = [];
  if (lowerIncludes(context, FIXTURE_LITERALS))
    for (const match of context.text.matchAll(FIXTURE_PATTERN)) {
      const range = match.indices?.groups?.value;
      if (range) spans.push([range[0], range[1]]);
    }
  context.fixtures = spans;
  return spans;
}

function insideFixture(context: ScanContext, start: number, end: number) {
  const spans = fixtureSpans(context);
  let low = 0;
  let high = spans.length - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    const span = spans[middle]!;
    if (span[1] < end) low = middle + 1;
    else if (span[0] > start) high = middle - 1;
    else return true;
  }
  return false;
}

interface MatchCheck {
  rule: SensitiveRule;
  start: number;
  end: number;
  secret: string;
  host: string | undefined;
}

function accepted(context: ScanContext, check: MatchCheck): boolean {
  if (
    LOCAL_HOST_RULES.has(check.rule) &&
    check.host !== undefined &&
    LOCAL_HOST.test(check.host)
  )
    return false;
  if (FIXTURE_SECRET_RULES.has(check.rule) && FIXTURE_SECRET.test(check.secret))
    return false;
  if (PLACEHOLDER_RULES.has(check.rule) && PLACEHOLDER.test(check.secret))
    return false;
  return !(
    FIXTURE_LINE_RULES.has(check.rule) &&
    insideFixture(context, check.start, check.end)
  );
}

function pushSpan(
  out: Span[],
  rule: SensitiveRule,
  text: string,
  start: number,
  end: number,
) {
  out.push({
    rule,
    start,
    end,
    value: text.slice(start, end),
    rank: RULE_RANKS.get(rule)!,
  });
}

interface PatternPart {
  rule: SensitiveRule;
  literals: readonly string[];
  pattern: RegExp;
  excludes?: RegExp;
  alternate?: SensitiveRule;
}

const FILE_LINE_GROUP = "file";

function findPart(context: ScanContext, part: PatternPart, out: Span[]) {
  if (!lowerIncludes(context, part.literals)) return;
  for (const match of context.text.matchAll(part.pattern)) {
    const range = match.indices?.groups?.value ?? [
      match.index,
      match.index + match[0].length,
    ];
    const value = context.text.slice(range[0], range[1]);
    const secret = match.groups?.password ?? value;
    const rule =
      part.alternate && match.groups?.[FILE_LINE_GROUP] !== undefined
        ? part.alternate
        : part.rule;
    if (part.excludes?.test(value)) continue;
    if (
      !accepted(context, {
        rule,
        start: range[0],
        end: range[1],
        secret,
        host: match.groups?.host,
      })
    )
      continue;
    pushSpan(out, rule, context.text, range[0], range[1]);
  }
}

const TOKEN_PATTERNS: readonly [SensitiveRule, string][] = [
  [SensitiveRule.AwsAccessKeyId, "\\b(?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\\b"],
  [
    SensitiveRule.PlatformToken,
    `\\b(?:gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{60,${T}}|gl(?:pat|dt|ptt|rt|cbt|soat)-[A-Za-z0-9_.-]{20,${T}}` +
      `|ATBB[A-Za-z0-9_=.-]{32,${T}}|ATATT3[A-Za-z0-9_=-]{180,${T}}|npm_[A-Za-z0-9]{36}|pypi-AgE[A-Za-z0-9_-]{50,${T}}` +
      `|dckr_(?:pat|oat)_[A-Za-z0-9_-]{27,${T}}|rubygems_[a-f0-9]{48}|do[opr]_v1_[a-f0-9]{64}|hv[sbr]\\.[A-Za-z0-9_-]{24,${T}}` +
      `|sbp_[a-f0-9]{40}|sb_secret_[A-Za-z0-9_-]{20,${T}})(?![A-Za-z0-9])` +
      `|(?<=\\b[a-z0-9]{14})\\.atlasv1\\.[A-Za-z0-9_=-]{60,${T}}`,
  ],
  [
    SensitiveRule.ChatToken,
    `\\bxox[abeoprs](?:\\.xox[bp])?-[A-Za-z0-9-]{10,${T}}` +
      `|\\bxapp-\\d-[A-Za-z0-9-]{10,${T}}` +
      `|hooks\\.slack\\.com/(?:services|workflows|triggers)/(?<value>[A-Za-z0-9_/+-]{20,${T}})` +
      `|discord(?:app)?\\.com/api/webhooks/(?<value>\\d{17,20}/[A-Za-z0-9_-]{60,${T}})` +
      `|(?<=\\b\\d{8,10}):AA[A-Za-z0-9_-]{32,33}(?![A-Za-z0-9_-])`,
  ],
  [
    SensitiveRule.SaasToken,
    `\\b(?:(?:sk|rk)_live_[A-Za-z0-9]{24,${T}}|whsec_[A-Za-z0-9+/=]{32,${T}}|SG\\.[A-Za-z0-9_-]{22}\\.[A-Za-z0-9_-]{43}` +
      `|shp(?:at|ca|pa|ss)_[a-fA-F0-9]{32})(?![A-Za-z0-9])`,
  ],
  [
    SensitiveRule.GoogleCloudKey,
    `\\bAIza[A-Za-z0-9_-]{35}|\\bGOCSPX-[A-Za-z0-9_-]{28}(?![A-Za-z0-9_-])|\\bya29\\.[A-Za-z0-9_-]{30,${T}}`,
  ],
  [
    SensitiveRule.LlmProviderKey,
    `\\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{32,${T}}` +
      `|\\b(?:gsk_[A-Za-z0-9]{52}|(?:hf|api_org)_[A-Za-z0-9]{34}|xai-[A-Za-z0-9]{80}|pplx-[A-Za-z0-9]{48}|r8_[A-Za-z0-9]{37})(?![A-Za-z0-9])`,
  ],
];
const TOKEN_GROUP_PREFIX = "rule";
const TOKEN_PATTERN = new RegExp(
  TOKEN_PATTERNS.map(
    ([, pattern], index) => `(?<${TOKEN_GROUP_PREFIX}${index}>${pattern})`,
  ).join("|"),
  "gd",
);

function findTokens(context: ScanContext, out: Span[]) {
  for (const match of context.text.matchAll(TOKEN_PATTERN)) {
    const index = TOKEN_PATTERNS.findIndex(
      (_, position) =>
        match.groups?.[`${TOKEN_GROUP_PREFIX}${position}`] !== undefined,
    );
    const range = match.indices?.groups?.value ?? [
      match.index,
      match.index + match[0].length,
    ];
    pushSpan(out, TOKEN_PATTERNS[index]![0], context.text, range[0], range[1]);
  }
}

const UPPER_NAME = `[A-Z0-9_]{0,${NM}}(?:PASSWORD|PASSWD|PWD|SECRET|TOKEN|CREDENTIALS|(?:API|ACCESS|SECRET|PRIVATE|SIGNING|ENCRYPTION|MASTER)_?KEY)`;
const LOWER_KEYWORD = "(?:password|passwd|secret|token|api_?key)";
const LOWER_NAME = `(?:${LOWER_KEYWORD}|[a-z](?:[a-z0-9_.]|-(?!\\d+-)){0,${NM}}${LOWER_KEYWORD})`;
const LINE_VALUE = `[^\\s$"'{<(),;\`]{${A},${V}}`;

const CONTEXT_PARTS: readonly PatternPart[] = [
  {
    rule: SensitiveRule.AwsSigningKey,
    literals: ["aws"],
    pattern: new RegExp(
      `aws_?secret_?(?:access_?)?key["']?${H}*[:=]${H}*["']?(?<value>[A-Za-z0-9/+=]{40})`,
      "gid",
    ),
  },
  {
    rule: SensitiveRule.AwsSessionToken,
    literals: ["aws"],
    pattern: new RegExp(
      `aws_?session_?token["']?${H}*[:=]${H}*["']?(?<value>[A-Za-z0-9/+=]{100,${V}})`,
      "gid",
    ),
  },
  {
    rule: SensitiveRule.UrlUserinfo,
    literals: ["://"],
    pattern: new RegExp(
      `(?<![A-Za-z0-9+.-])[A-Za-z][A-Za-z0-9+.-]{0,31}://(?<value>[^/\\s:@"']{0,${NM}}:(?<password>[^/\\s@"'$<]{1,${V}}))` +
        `@(?<host>[^/\\s:?#"'),]{1,${DNS_HOST_MAX_CHARACTERS}})`,
      "gd",
    ),
  },
  {
    rule: SensitiveRule.QuotedAssignment,
    literals: ["pass", "secret", "key", "token"],
    pattern: new RegExp(
      `(?:password|passwd|secret|api_?key|access_?token|auth_?token|refresh_?token|(?<![A-Za-z0-9_])token)["']?${H}*[:=]${H}*["']` +
        `(?<value>[^"'\\s$<{][^"'\\s]{${A - 1},${V}})["']`,
      "gid",
    ),
  },
  {
    rule: SensitiveRule.EnvAssignment,
    literals: ["pass", "secret", "token", "key", "pwd", "credential"],
    pattern: new RegExp(
      `^${P}${H}*(?:(?:-${H}+|export${H}+)?${UPPER_NAME}=["']?(?<value>[^\\s$"'{<]{${A},${V}})` +
        `|(?:-${H}+)?${UPPER_NAME}:${H}+["']?(?<value>${LINE_VALUE})["']?${H}*$` +
        `|(?:-${H}+)?${LOWER_NAME}(?::${H}+|${H}*=${H}*)(?<value>${LINE_VALUE})${H}*$` +
        `|(?<${FILE_LINE_GROUP}>password${H}+(?<value>[^\\s$<{]{1,${V}})${H}*$))`,
      "gmd",
    ),
    alternate: SensitiveRule.CredentialFile,
  },
  {
    rule: SensitiveRule.ConnectionSecret,
    literals: ["password=", "pwd=", "accountkey=", "sharedaccesskey="],
    pattern: new RegExp(
      `(?:^|[;\\s"'?&-])(?:password|pwd|accountkey|sharedaccesskey)=(?<value>[^;&\\s"'$<{]{1,${V}})`,
      "gid",
    ),
  },
  {
    rule: SensitiveRule.ConnectionSecret,
    literals: ["?", "&"],
    pattern: new RegExp(
      `[?&](?:access_?token|refresh_?token|token|api_?key|apikey|client_?secret|secret|sig|signature` +
        `|x-amz-signature|x-amz-security-token|x-goog-signature)=(?<value>[^&#\\s"'$<{]{${A},${V}})`,
      "gid",
    ),
  },
  {
    rule: SensitiveRule.HttpCredential,
    literals: ["authorization"],
    pattern: new RegExp(
      `(?<![A-Za-z0-9-])(?:proxy-)?authorization["']?${H}*[:=]${H}*["'\`]?(?:bearer|basic|token)${H}+(?<value>[A-Za-z0-9._~+/=-]{${A},${V}})`,
      "gid",
    ),
  },
  {
    rule: SensitiveRule.HttpCredential,
    literals: ["api-key", "-token"],
    pattern: new RegExp(
      `(?<![A-Za-z0-9-])(?:x-api-key|api-key|x-auth-token|x-access-token|private-token|x-goog-api-key|x-vault-token)["']?${H}*:${H}*["']?` +
        `(?<value>[^\\s"'$<{,;\`]{${A},${V}})`,
      "gid",
    ),
  },
  {
    rule: SensitiveRule.HttpCredential,
    literals: ["cookie"],
    pattern: new RegExp(
      `(?<![A-Za-z0-9-])(?:set-)?cookie["']?${H}*:${H}*["']?(?<value>[^\\s;=,"'$<{\`]{1,${NM}}=[^\\n"'\`]{1,${V}})`,
      "gid",
    ),
  },
  {
    rule: SensitiveRule.HttpCredential,
    literals: ["curl"],
    pattern: new RegExp(
      `\\bcurl\\b(?:(?!\\bcurl\\b)[^\\n]){0,${C}}?${H}(?:-u|--user)(?:${H}+|=)["']?(?<value>[^\\s:"'$<{]{1,${NM}}:[^\\s"']{1,${V}})`,
      "gd",
    ),
    excludes: CURL_USER_IDS,
  },
  {
    rule: SensitiveRule.CredentialFile,
    literals: ["_auth", "_password"],
    pattern: new RegExp(
      `(?:^|:)_(?:authToken|auth|password)${H}*=${H}*(?<value>[^\\s"'$<{]{1,${V}})`,
      "gmd",
    ),
  },
  {
    rule: SensitiveRule.CredentialFile,
    literals: ['"auth"', "identitytoken", "registrytoken"],
    pattern: new RegExp(
      `"(?:auth|identitytoken|registrytoken)"${H}*:${H}*"(?<value>[A-Za-z0-9+/=._-]{${A},${V}})"`,
      "gd",
    ),
  },
  {
    rule: SensitiveRule.CredentialFile,
    literals: ["client-key-data"],
    pattern: new RegExp(
      `client-key-data:${H}*["']?(?<value>[A-Za-z0-9+/=]{16,${V}})`,
      "gd",
    ),
  },
  {
    rule: SensitiveRule.CredentialFile,
    literals: ["password"],
    pattern: new RegExp(
      `\\b(?:machine|login)${H}+\\S{1,${NM}}${H}+password${H}+(?<value>\\S{1,${V}})`,
      "gd",
    ),
  },
];

const DSN_VALUE_CHARACTER = /[^/\s@"'$<]/;
const DSN_USER_CHARACTER = /[^/\s:@"']/;
const DSN_HOST_CHARACTER = /[^):\s]/;

function findGoMysqlDsn(context: ScanContext, out: Span[]) {
  const { text } = context;
  for (const anchor of GO_DSN_ANCHORS) {
    if (!context.lower.includes(anchor)) continue;
    for (
      let at = text.indexOf(anchor);
      at !== NO_MATCH;
      at = text.indexOf(anchor, at + 1)
    ) {
      let windowStart = at;
      const limit = Math.max(0, at - V);
      while (
        windowStart > limit &&
        DSN_VALUE_CHARACTER.test(text[windowStart - 1]!)
      )
        windowStart--;
      const hostStart = at + anchor.length;
      let hostEnd = hostStart;
      while (
        hostEnd < text.length &&
        hostEnd - hostStart < DNS_HOST_MAX_CHARACTERS &&
        DSN_HOST_CHARACTER.test(text[hostEnd]!)
      )
        hostEnd++;
      if (hostEnd === hostStart) continue;
      for (let colon = windowStart; colon + 1 < at; colon++) {
        if (text[colon] !== COLON) continue;
        let user = colon;
        while (
          user > TEXT_START &&
          colon - user < NM &&
          DSN_USER_CHARACTER.test(text[user - 1]!)
        )
          user--;
        if (user === colon) continue;
        if (
          accepted(context, {
            rule: SensitiveRule.GoMysqlDsn,
            start: colon + 1,
            end: at,
            secret: text.slice(colon + 1, at),
            host: text.slice(hostStart, hostEnd),
          })
        )
          pushSpan(out, SensitiveRule.GoMysqlDsn, text, colon + 1, at);
        break;
      }
    }
  }
}

const PRIVATE_KEY_LITERALS = [
  "private key",
  "private-lines:",
  "age-secret-key-",
];
const PRIVATE_KEY_HEADER =
  /-----BEGIN (?:[A-Z0-9]+ ){0,2}PRIVATE KEY(?: BLOCK)?-----/g;
const PRIVATE_KEY_HEADER_IN_LINE =
  /-----BEGIN (?:[A-Z0-9]+ ){0,2}PRIVATE KEY(?: BLOCK)?-----/;
const PRIVATE_KEY_END_LINE =
  /^-----END (?:[A-Z0-9]+ ){0,2}PRIVATE KEY(?: BLOCK)?-----/;
const BASE64_LINE = /^[A-Za-z0-9+/=]+\r?$/;
const PEM_FIELD_LINE = /^[A-Za-z][A-Za-z0-9-]*: .*$/;
const BLANK_LINE = /^\r?$/;
const PUTTY_PRIVATE_LINES = /^Private-Lines: (?<count>\d+)\r?$/gm;
const AGE_SECRET_KEY = /\bAGE-SECRET-KEY-1[0-9A-Z]{58}\b/g;

interface KeyWalk {
  lineEnd: number;
  bodyStart: number;
}

function lineEndAt(text: string, position: number): number {
  const end = text.indexOf(LINE_END, position);
  return end === NO_MATCH ? text.length : end;
}

function privateKeyBody(
  text: string,
  headerEnd: number,
  walk: KeyWalk,
  out: Span[],
) {
  if (walk.lineEnd !== NO_MATCH && walk.lineEnd < headerEnd)
    walk.lineEnd = text.indexOf(LINE_END, headerEnd);
  if (walk.lineEnd === NO_MATCH) return;
  const start = walk.lineEnd + 1;
  if (walk.bodyStart === start) return;
  walk.bodyStart = start;
  let position = start;
  let runEnd = start;
  let inRun = true;
  let bodyStart = NO_MATCH;
  while (position < text.length) {
    const end = lineEndAt(text, position);
    const line = text.slice(position, end);
    if (PRIVATE_KEY_HEADER_IN_LINE.test(line)) break;
    if (PRIVATE_KEY_END_LINE.test(line)) {
      if (bodyStart !== NO_MATCH && position - 1 > bodyStart)
        pushSpan(out, SensitiveRule.PrivateKey, text, bodyStart, position - 1);
      return;
    }
    if (BASE64_LINE.test(line)) {
      if (bodyStart === NO_MATCH) bodyStart = position;
      if (inRun) runEnd = end;
    } else if (BLANK_LINE.test(line) || PEM_FIELD_LINE.test(line)) {
      if (bodyStart !== NO_MATCH) inRun = false;
    } else break;
    position = end + 1;
  }
  if (bodyStart !== NO_MATCH && runEnd > bodyStart)
    pushSpan(out, SensitiveRule.PrivateKey, text, bodyStart, runEnd);
}

function findPrivateKeys(context: ScanContext, out: Span[]) {
  const { text } = context;
  if (!lowerIncludes(context, PRIVATE_KEY_LITERALS)) return;
  const walk: KeyWalk = { lineEnd: NO_NEWLINE, bodyStart: NO_MATCH };
  for (const match of text.matchAll(PRIVATE_KEY_HEADER))
    privateKeyBody(text, match.index + match[0].length, walk, out);
  for (const match of text.matchAll(PUTTY_PRIVATE_LINES)) {
    const count = Number(match.groups?.count);
    const start = lineEndAt(text, match.index) + 1;
    let position = start;
    let end = start;
    for (let line = 0; line < count && position < text.length; line++) {
      const lineEnd = lineEndAt(text, position);
      if (!BASE64_LINE.test(text.slice(position, lineEnd))) break;
      end = lineEnd;
      position = lineEnd + 1;
    }
    if (end > start) pushSpan(out, SensitiveRule.PrivateKey, text, start, end);
  }
  for (const match of text.matchAll(AGE_SECRET_KEY))
    pushSpan(
      out,
      SensitiveRule.PrivateKey,
      text,
      match.index,
      match.index + match[0].length,
    );
}

const ASCII_CODES = 128;
const CHARACTER_CODES = 65536;
const JWT_SEGMENT_CODES = codeTable(/[A-Za-z0-9_-]/);
const WORD_CODES = codeTable(/\w/);

function codeTable(pattern: RegExp): boolean[] {
  return Array.from({ length: ASCII_CODES }, (_, code) =>
    pattern.test(String.fromCharCode(code)),
  );
}

function segmentEnd(text: string, start: number): number {
  let position = start;
  while (
    position < text.length &&
    position - start < V &&
    JWT_SEGMENT_CODES[text.charCodeAt(position)]
  )
    position++;
  return position;
}

function findJwt(context: ScanContext, out: Span[]) {
  const { text } = context;
  if (!context.lower.includes(JWT_START.toLowerCase())) return;
  let from = 0;
  for (;;) {
    const start = text.indexOf(JWT_START, from);
    if (start === NO_MATCH) return;
    from = start + 1;
    if (start > TEXT_START && WORD_CODES[text.charCodeAt(start - 1)]) continue;
    let position = start;
    let firstEnd = start;
    let valid = true;
    for (let segment = 0; segment < JWT_SEGMENTS && valid; segment++) {
      const segmentStart = position;
      if (
        segment === PAYLOAD_SEGMENT &&
        !text.startsWith(JWT_START, position)
      ) {
        valid = false;
        break;
      }
      position = segmentEnd(text, position);
      if (segment === HEADER_SEGMENT) firstEnd = position;
      if (position - segmentStart < JWT_SEGMENT_MIN_CHARACTERS[segment]!)
        valid = false;
      else if (segment < JWT_SEGMENTS - 1) {
        if (text[position] === SEGMENT_DOT) position++;
        else valid = false;
      }
    }
    if (!valid) {
      from = Math.max(from, firstEnd);
      continue;
    }
    while (
      text[position] === SEGMENT_DOT &&
      JWT_SEGMENT_CODES[text.charCodeAt(position + 1)]
    )
      position = segmentEnd(text, position + 1);
    pushSpan(out, SensitiveRule.Jwt, text, start, position);
    from = position;
  }
}

function patternSpans(view: View, out: Span[]) {
  const context: ScanContext = {
    text: view.text,
    lower: view.text.toLowerCase(),
    present: new Map(),
    fixtures: undefined,
  };
  const local: Span[] = [];
  findTokens(context, local);
  findGoMysqlDsn(context, local);
  findPrivateKeys(context, local);
  findJwt(context, local);
  for (const part of CONTEXT_PARTS) findPart(context, part, local);
  for (const span of local) out.push(mapped(view, span));
}

function mapped(view: View, span: Span): Span {
  const [start, end] = view.source(span.start, span.end);
  return { ...span, start, end };
}

function checkLength(text: string) {
  if (text.length > SENSITIVE_SCAN_MAX_CHARACTERS)
    throw new RangeError(
      `a string of ${text.length} characters exceeds the scan limit`,
    );
}

function markerRanges(text: string): [number, number][] {
  if (!text.includes(MARKER_START)) return [];
  return [...text.matchAll(ANY_MARKER_PATTERN)].map((match) => [
    match.index,
    match.index + match[0].length,
  ]);
}

function cutAtMarkers(span: Span, markers: [number, number][]): Span[] {
  const pieces: Span[] = [];
  let start = span.start;
  for (const [markerStart, markerEnd] of markers) {
    if (markerEnd <= start || markerStart >= span.end) continue;
    if (markerStart > start) pieces.push({ ...span, start, end: markerStart });
    start = Math.max(start, markerEnd);
  }
  if (start < span.end) pieces.push({ ...span, start });
  return pieces;
}

function merged(text: string, spans: Span[]): SensitiveSpan[] {
  const ordered = [...spans].sort(
    (left, right) => left.start - right.start || left.rank - right.rank,
  );
  const groups: { span: Span; exact: boolean; values: string[] }[] = [];
  for (const span of ordered) {
    const exact = span.value === text.slice(span.start, span.end);
    const last = groups.at(-1);
    if (last && span.start < last.span.end) {
      last.span.end = Math.max(last.span.end, span.end);
      if (span.rank < last.span.rank) {
        last.span.rank = span.rank;
        last.span.rule = span.rule;
      }
      last.exact &&= exact;
      last.values.push(span.value);
    } else groups.push({ span: { ...span }, exact, values: [span.value] });
  }
  const markers = markerRanges(text);
  return groups.flatMap(({ span, exact, values }) =>
    cutAtMarkers(span, markers).map((piece) => ({
      rule: piece.rule,
      start: piece.start,
      end: piece.end,
      value: exact ? text.slice(piece.start, piece.end) : values.join(""),
    })),
  );
}

function ranked(span: SensitiveSpan, rank: number): Span {
  return { ...span, rank };
}

export function mergeSpans(
  text: string,
  known: readonly SensitiveSpan[],
  pattern: readonly SensitiveSpan[],
): SensitiveSpan[] {
  return merged(text, [
    ...known.map((span) =>
      ranked(
        span,
        span.rule === SensitiveRule.LlmCredential ? 0 : TABLE_VALUE_RANK,
      ),
    ),
    ...pattern.map((span) => ranked(span, RULE_RANKS.get(span.rule)!)),
  ]);
}

export function findPatternText(text: string): SensitiveSpan[] {
  checkLength(text);
  const spans: Span[] = [];
  patternSpans(identityView(text), spans);
  const escaped = escapedView(text);
  if (escaped) patternSpans(escaped, spans);
  return merged(text, spans);
}

interface IndexedValue {
  rule: SensitiveRule;
  rank: number;
}

class Automaton {
  readonly next: Map<number, number>[] = [new Map()];
  readonly fail: number[] = [0];
  readonly depth: number[] = [0];
  readonly reach: number[] = [0];
  readonly link: number[] = [0];
  readonly rank: number[] = [0];
  readonly rule: SensitiveRule[] = [SensitiveRule.LlmCredential];

  readonly rootNext = new Int32Array(CHARACTER_CODES);

  constructor(values: Iterable<[string, IndexedValue]>) {
    for (const [value, indexed] of values) this.insert(value, indexed);
    this.linkFailures();
    for (const [code, child] of this.next[ROOT_NODE]!)
      this.rootNext[code] = child;
  }

  private insert(value: string, indexed: IndexedValue) {
    const keyLength = Math.min(value.length, INDEXED_PREFIX_CHARACTERS);
    let node = 0;
    for (let index = 0; index < keyLength; index++) {
      const code = value.charCodeAt(index);
      let child = this.next[node]!.get(code);
      if (child === undefined) {
        child = this.next.length;
        this.next.push(new Map());
        this.fail.push(0);
        this.depth.push(this.depth[node]! + 1);
        this.reach.push(0);
        this.link.push(0);
        this.rank.push(indexed.rank);
        this.rule.push(indexed.rule);
        this.next[node]!.set(code, child);
      }
      node = child;
    }
    const fresh = !this.reach[node];
    if (
      fresh ||
      indexed.rank < this.rank[node]! ||
      (indexed.rank === this.rank[node] && value.length > this.reach[node]!)
    ) {
      this.rank[node] = indexed.rank;
      this.rule[node] = indexed.rule;
    }
    this.reach[node] = Math.max(this.reach[node]!, value.length);
  }

  private linkFailures() {
    const queue = [...this.next[0]!.values()];
    for (let head = 0; head < queue.length; head++) {
      const node = queue[head]!;
      for (const [code, child] of this.next[node]!) {
        let failure = this.fail[node]!;
        while (failure !== ROOT_NODE && !this.next[failure]!.has(code))
          failure = this.fail[failure]!;
        const target = this.next[failure]!.get(code);
        const childFailure =
          target !== undefined && target !== child ? target : 0;
        this.fail[child] = childFailure;
        this.link[child] = this.reach[childFailure]
          ? childFailure
          : this.link[childFailure]!;
        queue.push(child);
      }
    }
  }

  nodes(): number {
    return this.next.length;
  }

  scan(text: string, out: Span[]) {
    let node = 0;
    let last: Span | undefined;
    for (let index = 0; index < text.length; index++) {
      const code = text.charCodeAt(index);
      let target = ROOT_NODE;
      while (node !== ROOT_NODE) {
        const child = this.next[node]!.get(code);
        if (child !== undefined) {
          target = child;
          break;
        }
        node = this.fail[node]!;
      }
      node = node === ROOT_NODE ? this.rootNext[code]! : target;
      if (node === ROOT_NODE) continue;
      const key = this.reach[node] ? node : this.link[node]!;
      if (key === ROOT_NODE) continue;
      const start = index + 1 - this.depth[key]!;
      const end = Math.min(text.length, start + this.reach[key]!);
      if (last && start <= last.end) {
        last.start = Math.min(last.start, start);
        last.end = Math.max(last.end, end);
        if (this.rank[key]! < last.rank) {
          last.rank = this.rank[key]!;
          last.rule = this.rule[key]!;
        }
      } else {
        last = {
          rule: this.rule[key]!,
          start,
          end,
          value: "",
          rank: this.rank[key]!,
        };
        out.push(last);
      }
    }
    for (const span of out) span.value ||= text.slice(span.start, span.end);
  }
}

function secretForms(secret: string): string[] {
  const forms = [secret, encodeURIComponent(secret)];
  const bytes = Buffer.from(secret);
  for (const encoding of BASE64_ENCODINGS)
    for (const offset of BASE64_OFFSETS) {
      const encoded = Buffer.concat([
        Buffer.alloc(offset),
        bytes,
        Buffer.alloc(BASE64_GROUP_BYTES),
      ]).toString(encoding);
      forms.push(
        encoded.slice(
          Math.ceil((offset * BYTE_BITS) / BASE64_DIGIT_BITS),
          Math.floor(((offset + bytes.length) * BYTE_BITS) / BASE64_DIGIT_BITS),
        ),
      );
    }
  return [...new Set(forms)].filter((form) => form.length);
}

interface Prepared {
  all: Automaton;
  forms: Automaton;
  windows: Map<string, [string, number][]>;
}

const SECRET_VALUE: IndexedValue = {
  rule: SensitiveRule.LlmCredential,
  rank: 0,
};

class TableMatcher implements KnownMatcher {
  private readonly values = new Map<string, IndexedValue>();
  private readonly secrets = new Set<string>();
  private readonly formValues = new Map<string, IndexedValue>();
  private prepared: Prepared | undefined;

  add(value: KnownValue) {
    if (!value.value || this.values.has(value.value)) return;
    this.values.set(value.value, {
      rule: value.rule,
      rank: value.rule === SensitiveRule.LlmCredential ? 0 : TABLE_VALUE_RANK,
    });
    this.prepared = undefined;
  }

  addSecret(secret: string) {
    if (!secret || this.secrets.has(secret)) return;
    this.secrets.add(secret);
    for (const form of secretForms(secret))
      this.formValues.set(form, SECRET_VALUE);
    this.prepared = undefined;
  }

  size(): number {
    return this.values.size + this.formValues.size;
  }

  state(): Prepared {
    this.prepared ??= {
      all: new Automaton([...this.values, ...this.formValues]),
      forms: new Automaton(this.formValues),
      windows: this.windowMap(),
    };
    return this.prepared;
  }

  private windowMap(): Map<string, [string, number][]> {
    const windows = new Map<string, [string, number][]>();
    for (const secret of this.secrets) {
      const prefix = KNOWN_PREFIX_PATTERN.exec(secret)?.[0].length ?? 0;
      for (
        let offset = prefix;
        offset + KNOWN_PART_MIN_CHARACTERS <= secret.length;
        offset++
      ) {
        const key = secret.slice(offset, offset + KNOWN_PART_MIN_CHARACTERS);
        const hits = windows.get(key) ?? [];
        hits.push([secret, offset]);
        windows.set(key, hits);
      }
    }
    return windows;
  }
}

export function knownMatcher(): KnownMatcher {
  return new TableMatcher();
}

export function matcherNodes(matcher: KnownMatcher): number {
  assert.ok(matcher instanceof TableMatcher);
  return matcher.state().all.nodes();
}

function partSpans(text: string, prepared: Prepared, out: Span[]) {
  const { windows } = prepared;
  if (!windows.size) return;
  for (let position = 0; position <= text.length;) {
    const hits = windows.get(
      text.slice(position, position + KNOWN_PART_MIN_CHARACTERS),
    );
    for (const [secret, offset] of hits ?? [])
      if (text.startsWith(secret.slice(offset), position))
        out.push(secretSpan(text, position, position + secret.length - offset));
    const lineEnd = text.indexOf(LINE_END, position);
    if (lineEnd === NO_MATCH) break;
    position = lineEnd + 1;
  }
  for (
    let cut = text.indexOf(TRUNCATION_TEXT);
    cut !== NO_MATCH;
    cut = text.indexOf(TRUNCATION_TEXT, cut + 1)
  ) {
    if (cut < KNOWN_PART_MIN_CHARACTERS) continue;
    const hits = windows.get(text.slice(cut - KNOWN_PART_MIN_CHARACTERS, cut));
    for (const [secret, offset] of hits ?? []) {
      const length = offset + KNOWN_PART_MIN_CHARACTERS;
      if (
        length < secret.length &&
        text.startsWith(secret.slice(0, length), cut - length)
      )
        out.push(secretSpan(text, cut - length, cut));
    }
  }
}

function secretSpan(text: string, start: number, end: number): Span {
  return {
    rule: SensitiveRule.LlmCredential,
    start,
    end,
    value: text.slice(start, end),
    rank: 0,
  };
}

const WRAP_LINE = /^[A-Za-z0-9+/=_-]+$/;
const LINE_INDENT = /^[ \t]*/;

interface WrapLine {
  start: number;
  end: number;
  indent: number;
}

function wrapLines(text: string): WrapLine[] {
  const lines: WrapLine[] = [];
  for (let position = 0; position <= text.length;) {
    const lineEnd = lineEndAt(text, position);
    let end = lineEnd;
    if (end > position && text[end - 1] === CARRIAGE_RETURN) end--;
    const indent = LINE_INDENT.exec(text.slice(position, end))![0].length;
    lines.push({ start: position + indent, end, indent });
    position = lineEnd + 1;
  }
  return lines;
}

function wrapLine(text: string, line: WrapLine | undefined, indent: number) {
  return (
    line !== undefined &&
    line.indent === indent &&
    WRAP_LINE.test(text.slice(line.start, line.end))
  );
}

function wrappedViews(text: string): View[] {
  const views: View[] = [];
  const lines = wrapLines(text);
  for (let index = 0; index < lines.length;) {
    const first = lines[index]!;
    const width = first.end - first.start;
    if (
      !BASE64_WRAP_WIDTHS.some((wrap) => wrap === width) ||
      !wrapLine(text, first, first.indent)
    ) {
      index++;
      continue;
    }
    let next = index + 1;
    while (
      wrapLine(text, lines[next], first.indent) &&
      lines[next]!.end - lines[next]!.start === width
    )
      next++;
    const tail = lines[next];
    if (wrapLine(text, tail, first.indent) && tail!.end - tail!.start < width)
      next++;
    if (next - index >= MIN_WRAP_LINES)
      views.push(joinedView(text, lines.slice(index, next)));
    index = next;
  }
  return views;
}

function joinedView(text: string, lines: WrapLine[]): View {
  const map: number[] = [];
  const parts: string[] = [];
  for (const line of lines) {
    parts.push(text.slice(line.start, line.end));
    for (let position = line.start; position < line.end; position++)
      map.push(position);
  }
  return {
    text: parts.join(""),
    source: (start, end) => [map[start]!, map[end - 1]! + 1],
  };
}

function knownSpans(view: View, prepared: Prepared, out: Span[]) {
  const local: Span[] = [];
  prepared.all.scan(view.text, local);
  partSpans(view.text, prepared, local);
  if (prepared.windows.size)
    for (const wrapped of wrappedViews(view.text)) {
      const runSpans: Span[] = [];
      prepared.forms.scan(wrapped.text, runSpans);
      for (const span of runSpans) local.push(mapped(wrapped, span));
    }
  for (const span of local) out.push(mapped(view, span));
}

export function findKnownText(
  text: string,
  matcher: KnownMatcher,
): SensitiveSpan[] {
  assert.ok(matcher instanceof TableMatcher);
  checkLength(text);
  const prepared = matcher.state();
  const spans: Span[] = [];
  knownSpans(identityView(text), prepared, spans);
  const escaped = escapedView(text);
  if (escaped) knownSpans(escaped, prepared, spans);
  return merged(text, spans);
}

function entropy(value: string): number {
  const counts = new Map<string, number>();
  const characters = [...value];
  for (const character of characters)
    counts.set(character, (counts.get(character) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const share = count / characters.length;
    bits -= share * Math.log(share);
  }
  return bits / Math.log(BITS_BASE);
}

export function promotes(value: string, rule: SensitiveRule): boolean {
  if (PROMOTED_RULES.has(rule)) return true;
  return (
    value.length >= KNOWN_VALUE_MIN_CHARACTERS &&
    entropy(value) >= KNOWN_VALUE_MIN_ENTROPY_BITS
  );
}

export function replaceSpans(
  text: string,
  spans: readonly SensitiveSpan[],
  marker: (span: SensitiveSpan) => string,
): string {
  const parts: string[] = [];
  let position = 0;
  for (const span of spans) {
    parts.push(text.slice(position, span.start), marker(span));
    position = span.end;
  }
  parts.push(text.slice(position));
  return parts.join("");
}

export function mapSensitiveStrings(
  value: unknown,
  transform: (text: string) => string,
  free = false,
): unknown {
  if (isString(value)) return transform(value);
  if (Array.isArray(value))
    return value.map((item) => mapSensitiveStrings(item, transform, free));
  if (!isObject(value)) return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(record).map(([key, item]) => {
      if (record.type === IMAGE_TYPE && key === IMAGE_DATA_KEY)
        return [key, item];
      if (!free && STRUCTURAL_KEYS.has(key)) return [key, item];
      return [
        key,
        mapSensitiveStrings(item, transform, free || FREE_KEYS.has(key)),
      ];
    }),
  );
}

export function redactValue(value: unknown, matcher: KnownMatcher): unknown {
  return mapSensitiveStrings(value, (text) => {
    try {
      const spans = mergeSpans(
        text,
        findKnownText(text, matcher),
        findPatternText(text),
      );
      return replaceSpans(text, spans, (span) => tracerMarker(span.rule));
    } catch {
      return tracerMarker(SCAN_FAILED);
    }
  });
}
