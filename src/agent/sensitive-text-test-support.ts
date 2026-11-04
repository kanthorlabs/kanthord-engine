import { createHash } from "node:crypto";
import {
  findKnownText,
  findPatternText,
  type KnownMatcher,
  knownMatcher,
  SENSITIVE_VALUE_MAX_CHARACTERS,
  SensitiveRule,
} from "./sensitive-text.ts";

export const MiB = 1 << 20;
const KiB = 1 << 10;
const V = SENSITIVE_VALUE_MAX_CHARACTERS;
const GROUP_VALUES = 9;
const MORSE_ROUNDS = 7;
const KEY_UNIT = 512;
const KEY_LENGTHS = 8;

export interface ScanRow {
  name: string;
  prepare(): () => unknown;
}

export function wholeScan(text: string, matcher: KnownMatcher) {
  return [findPatternText(text), findKnownText(text, matcher)];
}

export function seededText() {
  let counter = 0;
  const bytes = (n: number) => {
    const chunks: Buffer[] = [];
    let have = 0;
    while (have < n) {
      const digest = createHash("sha256").update(String(counter++)).digest();
      chunks.push(digest);
      have += digest.length;
    }
    return Buffer.concat(chunks).subarray(0, n);
  };
  const random = (n: number) => bytes(n).toString("base64url").slice(0, n);
  let seed = 7;
  const fraction = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  return { bytes, random, fraction };
}

const fill = (unit: string, n: number) =>
  unit.repeat(Math.ceil(n / unit.length)).slice(0, n);

export function scanRows(code: (n: number) => string): ScanRow[] {
  const { bytes, random, fraction } = seededText();
  const secretKind = ["sk-ant-oat01-", "sk-ant-ort01-"];
  const secrets = secretKind.map((kind) => kind + random(95));
  const values = (count: number, length: number | (() => number)) =>
    Array.from({ length: count }, () =>
      random(length instanceof Function ? length() : length),
    );
  const matcherOf = (
    table: readonly string[],
    known: readonly string[] = secrets,
  ) => {
    const matcher = knownMatcher();
    for (const secret of known) matcher.addSecret(secret);
    for (const value of table)
      matcher.add({ value, rule: SensitiveRule.QuotedAssignment });
    findKnownText("", matcher);
    return matcher;
  };
  const scan =
    (text: () => string, table: () => readonly string[], known = secrets) =>
    () => {
      const input = text();
      const matcher = matcherOf(table(), known);
      return () => wholeScan(input, matcher);
    };
  const randomText = () => {
    let text = "";
    while (text.length < MiB) text += random(99) + "\n";
    return text.slice(0, MiB);
  };
  const jsonCode = () => JSON.stringify(code(MiB - 200000)).slice(0, MiB);
  const base64Lines = () =>
    bytes(800000)
      .toString("base64")
      .match(/.{1,76}/g)!
      .join("\n")
      .slice(0, MiB);
  const mixedLength = () =>
    Math.round(
      Math.exp(Math.log(12) + fraction() * (Math.log(V) - Math.log(12))),
    );
  const table16 = (count: number) => () => values(count, 16);
  const rows: ScanRow[] = [];
  const row = (name: string, prepare: () => () => unknown) =>
    rows.push({ name, prepare });

  for (const count of [0, 1024, 4096]) {
    row(`random 1 MiB, table ${count} x 16`, scan(randomText, table16(count)));
    row(
      `code 1 MiB, table ${count} x 16`,
      scan(() => code(MiB), table16(count)),
    );
    row(
      `code as one JSON string 1 MiB, table ${count} x 16`,
      scan(jsonCode, table16(count)),
    );
    row(
      `code 50 KiB, table ${count} x 16`,
      scan(() => code(50 * KiB), table16(count)),
    );
    row(
      `base64 76 as one JSON string 1 MiB, table ${count} x 16`,
      scan(() => JSON.stringify(base64Lines()).slice(0, MiB), table16(count)),
    );
  }

  const longTables: [string, () => string[]][] = [
    ["4096 x 128", () => values(4096, 128)],
    ["512 x 2048", () => values(512, 2048)],
    ["4096 mixed 12 to 16384", () => values(4096, mixedLength)],
  ];
  for (const [label, make] of [
    ["4096 x 16", () => values(4096, 16)] as [string, () => string[]],
    ...longTables,
  ]) {
    row(`build table ${label}`, () => {
      const table = make();
      return () => matcherOf(table);
    });
  }
  for (const [label, make] of longTables) {
    row(
      `code 1 MiB, table ${label}`,
      scan(() => code(MiB), make),
    );
    row(`random 1 MiB, table ${label}`, scan(randomText, make));
  }
  for (const [groups, length] of [
    [455, 2048],
    [455, 16000],
  ] as const) {
    const shared = () => {
      const table: string[] = [];
      for (let group = 0; group < groups; group++) {
        const prefix = random(length);
        for (let k = 0; k < GROUP_VALUES; k++)
          table.push(prefix + "!".repeat(k + 1));
      }
      return table;
    };
    row(
      `build ${groups} groups of 9 values with a shared prefix of ${length}`,
      () => {
        const table = shared();
        return () => matcherOf(table);
      },
    );
    row(
      `${groups} groups of 9 values with a shared prefix of ${length}, 1 MiB of own values`,
      () => {
        const table = shared();
        const matcher = matcherOf(table);
        const text = fill(table.slice(0, 64).join(" ") + " ", MiB);
        return () => wholeScan(text, matcher);
      },
    );
  }

  const base64Table = table16(4096);
  row("base64 76 LF 1 MiB, table 4096 x 16", scan(base64Lines, base64Table));
  row(
    "base64 76 CRLF 1 MiB, table 4096 x 16",
    scan(
      () => base64Lines().replaceAll("\n", "\r\n").slice(0, MiB),
      base64Table,
    ),
  );
  row(
    "base64 76 indent 2 1 MiB, table 4096 x 16",
    scan(
      () =>
        base64Lines()
          .split("\n")
          .map((line) => "  " + line)
          .join("\n")
          .slice(0, MiB),
      base64Table,
    ),
  );
  const ofA = () => fill("a", MiB);
  row(
    "64 nested values a x 12 to a x 75, 1 MiB of a",
    scan(ofA, () => Array.from({ length: 64 }, (_, i) => "a".repeat(12 + i))),
  );
  row(
    "4096 nested values a x 12 to a x 4107, 1 MiB of a",
    scan(ofA, () => Array.from({ length: 4096 }, (_, i) => "a".repeat(12 + i))),
  );
  for (const tail of [5, 20])
    row(
      `4096 values a x 12 to a x 4107 with ${tail} random characters, 1 MiB of a`,
      scan(ofA, () =>
        Array.from(
          { length: 4096 },
          (_, i) => "a".repeat(12 + i) + random(tail),
        ),
      ),
    );
  row(
    "4096 values with one key and 4096 lengths, 1 MiB of the key and !",
    () => {
      const key = random(12);
      const matcher = matcherOf(
        Array.from({ length: 4096 }, (_, i) => key + random(i)),
      );
      const text = fill(key + "!", MiB);
      return () => wholeScan(text, matcher);
    },
  );
  row("4096 values with one key and 4096 lengths, 1 MiB of the values", () => {
    const key = random(12);
    const table = Array.from({ length: 4096 }, (_, i) => key + random(i));
    const matcher = matcherOf(table);
    const text = fill(table.slice(0, 200).join(" ") + " ", MiB);
    return () => wholeScan(text, matcher);
  });
  row(
    "4096 values in a chain of shared prefixes, 1 MiB of the longest prefix",
    () => {
      const base = random(4096);
      const matcher = matcherOf(
        Array.from(
          { length: 4096 },
          (_, i) =>
            base.slice(0, 12 + 12 * Math.floor(i / 17) + (i % 17)) +
            "!" +
            random(3),
        ),
      );
      const text = fill(base.slice(0, 3000) + "\n", MiB);
      return () => wholeScan(text, matcher);
    },
  );
  const header = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.";
  const jwt = () => header + random(120) + "." + random(43);
  row("4096 JWT values with one header, 1 MiB of the same values", () => {
    const table = Array.from({ length: 4096 }, jwt);
    const matcher = matcherOf(table);
    const text = fill(table.slice(0, 2000).join(" ") + " ", MiB);
    return () => wholeScan(text, matcher);
  });
  row("4096 JWT values with one header, 1 MiB of other JWTs", () => {
    const matcher = matcherOf(Array.from({ length: 4096 }, jwt));
    const text = fill(Array.from({ length: 2000 }, jwt).join(" ") + " ", MiB);
    return () => wholeScan(text, matcher);
  });
  row(
    "review 5 B18: a Thue-Morse value of 16384 characters, 1 MiB of B",
    () => {
      let morse = [1];
      for (let k = 0; k < MORSE_ROUNDS; k++)
        morse = morse.concat(morse.map((x) => -x));
      const delta = morse.map((x) => String.fromCharCode(66 + x)).join("");
      const matcher = matcherOf(["B".repeat(V - delta.length) + delta]);
      const text = fill("B", MiB);
      return () => wholeScan(text, matcher);
    },
  );
  for (const count of [2, 20, 60, 600]) {
    const many = () =>
      Array.from(
        { length: count },
        (_, i) => secretKind[i % secretKind.length]! + random(95),
      );
    row(`review 5 B20: ${count} secrets, short lines, 1 MiB`, () => {
      const known = many();
      const matcher = matcherOf(values(4096, 16), known);
      const text = fill("s\n", MiB);
      return () => wholeScan(text, matcher);
    });
    row(`review 5 B20: ${count} secrets, truncated cuts, 1 MiB`, () => {
      const known = many();
      const matcher = matcherOf(values(4096, 16), known);
      const text = fill(
        "x" + known[0]!.slice(0, 60) + "... [truncated]\n",
        MiB,
      );
      return () => wholeScan(text, matcher);
    });
  }
  const keyHit = (lines: boolean) => () => {
    const unit = random(512);
    const ring = unit + unit;
    const table: string[] = [];
    for (let p = 0; p < KEY_UNIT; p++)
      for (let k = 1; k <= KEY_LENGTHS; k++)
        table.push(ring.slice(p, p + 12) + "~".repeat(k));
    const matcher = matcherOf(table);
    const text = fill(unit + (lines ? "\n" : ""), MiB);
    return () => wholeScan(text, matcher);
  };
  row("review 5 B21: a key hit at each position, 1 MiB", keyHit(false));
  row(
    "review 5 B21: a key hit at each position with a line end per unit, 1 MiB",
    keyHit(true),
  );
  row(
    "a 32-character key hit at each position, tails up to 8000 characters, 1 MiB",
    () => {
      const unit = random(512);
      const ring = unit + unit;
      const table: string[] = [];
      for (let p = 0; p < KEY_UNIT; p++)
        for (let k = 1; k <= KEY_LENGTHS; k++)
          table.push(ring.slice(p, p + 32) + random(1000 * k));
      const matcher = matcherOf(table);
      const text = fill(unit, MiB);
      return () => wholeScan(text, matcher);
    },
  );

  const j = (...parts: string[]) => parts.join("");
  const secretWord = j("sec", "ret");
  const tokenWord = j("tok", "en");
  const passWord = j("pass", "word");
  const begin = j("-----BEG", "IN");
  const privateKey = j("PRIV", "ATE KEY");
  const units: [string, string][] = [
    [
      "rule 1: an AKIA prefix with 15 characters",
      j("AK", "IA", "A".repeat(15), " "),
    ],
    ["rule 2: aws_secret_key= with a space", j("aws_", secretWord, "_key= ")],
    [
      "rule 3: aws_session_token= with 99 characters and !",
      j("aws_session_", tokenWord, "=", "A".repeat(99), "!"),
    ],
    [
      "rule 4: 31 letters, ://u:, V value characters, a space",
      j("a".repeat(31), "://u:", "b".repeat(V), " "),
    ],
    ["rule 5: a:@tcp(", "a:@tcp("],
    [
      "rule 6: a BEGIN header with no line end",
      j(begin, " AAAA ", privateKey, "-----"),
    ],
    [
      "rule 6: the header with the four closing dashes cut",
      j(begin, " AAAA ", privateKey, "-"),
    ],
    [
      "rule 6: a header and one base64 line, with no END line",
      j(begin, " RSA ", privateKey, "-----\n", "QUFB".repeat(19), "\n"),
    ],
    [
      "rule 6: full PEM blocks of 25 base64 lines",
      j(
        begin,
        " RSA ",
        privateKey,
        "-----\n",
        ("QUFB".repeat(16) + "\n").repeat(25),
        "-----END RSA ",
        privateKey,
        "-----\n",
      ),
    ],
    [
      "rule 7: ghp_ with 35 characters, github_pat_ with 59",
      j("gh", "p_", "a".repeat(35), " github_", "pat_", "_".repeat(59), " "),
    ],
    [
      "rule 11: sk-ant- with 31 characters",
      j("sk", "-ant-", "a".repeat(31), " "),
    ],
    [
      'rule 12: a keyword, =", V value characters',
      j(passWord, '="', "a".repeat(V), " "),
    ],
    [
      "rule 13: 170 times :1:, then 200 name characters",
      j(":1:".repeat(170), "A".repeat(200), "\n"),
    ],
    [
      "fixture rule: 170 times :1:, then TEST_ and 200 characters",
      j(":1:".repeat(170), "TEST_", "a".repeat(200), "\n"),
    ],
    ["rule 0 parts: short lines", "s\n"],
    [
      "rule 0 prefix part: a secret prefix before each cut",
      j("x", secrets[0]!.slice(0, 60), "... [truncated]\n"),
    ],
    [
      "rule 0 suffix part: a 12-character probe hit on each line",
      j(secrets[0]!.slice(20, 32), "Z\n"),
    ],
    ["escaped view: a\\n repeated", "a\\n"],
    ["escaped view: \\u0041 repeated", "\\u0041"],
    ["escaped view: \\\\ repeated", "\\\\"],
    ["rule 16: -eyJ repeated", "-eyJ"],
    [
      "rule 16: -eyJ and 20000 segment characters",
      j("-eyJ", "a".repeat(20000), "\n"),
    ],
    [
      "rule 16: eyJ...eyJ... with a short third segment",
      j("eyJ", "a".repeat(100), ".eyJ", "a".repeat(100), ". "),
    ],
    [
      "rule 15: cookie: a= and 20000 characters",
      j("coo", "kie: a=", "b".repeat(20000), "\n"),
    ],
    [
      "rule 15: authorization: bearer and 7 characters",
      j("author", "ization: bearer ", "c".repeat(7), " "),
    ],
    ["rule 15: curl and 300 words, no -u", j("curl ", "x ".repeat(300), "\n")],
    [
      "rule 13: 170 times :1:, 200 lower-case name characters",
      j(":1:".repeat(170), "a".repeat(200), "\n"),
    ],
    [
      "rule 13: password: and 20000 characters and ,",
      j(passWord, ": ", "d".repeat(20000), ",\n"),
    ],
    [
      "rule 14: ?token= and 7 characters",
      j("?", tokenWord, "=", "d".repeat(7), " "),
    ],
    [
      "rule 14: ;password= and 30000 characters",
      j(";", passWord, "=", "e".repeat(30000), "\n"),
    ],
    [
      "rule 7: 14 letters, .atlasv1., 59 characters",
      j("a".repeat(14), ".atlas", "v1.", "f".repeat(59), " "),
    ],
    [
      "rule 8: Telegram id, :AA, 31 characters",
      j(" 1234567890:A", "A", "h".repeat(31), " "),
    ],
    [
      "rule 17: .netrc line with a 30000-character value",
      j("machine a login b ", passWord, " ", "i".repeat(30000), "\n"),
    ],
    [
      "rule 13: -1 x 85, -, the keyword, : and 200 characters, a space",
      j("-1".repeat(85), "-", passWord, ": ", "x".repeat(200), " y\n"),
    ],
    [
      "rule 13: -1 x 85, -, the keyword, : and 16000 characters, a space",
      j("-1".repeat(85), "-", passWord, ": ", "x".repeat(16000), " y\n"),
    ],
    [
      "rule 13: -1-a x 64, the keyword, : x",
      j("-1-a".repeat(64), passWord, ": x\n"),
    ],
    [
      "rule 13: :1: x 170, 200 lower-case characters, the keyword",
      j(":1:".repeat(170), "a".repeat(200), passWord, ": x\n"),
    ],
    ["rule 15: curl repeated", "curl "],
    ["rule 15: curl c repeated", "curl c "],
    ["rule 15: curl and 300 words", j("curl ", "word ".repeat(300), "\n")],
    ["rule 15: curl -u a: repeated", "curl -u a:"],
    ["rule 15: cookie:a= repeated", j("coo", "kie:a=")],
    ["rule 15: x-api-key: repeated", j("x-api", "-key:")],
    ["rule 14: ;password= repeated", j(";", passWord, "=")],
    ["rule 14: ?token= repeated", j("?", tokenWord, "=")],
    ["rule 17: :_auth= repeated", j(":_au", "th=")],
    ['rule 17: "auth":" repeated', j('"au', 'th":"')],
    ["rule 17: client-key-data: repeated", j("client-key", "-data:")],
    ['rule 12: token=" repeated', j(tokenWord, '="')],
  ];
  for (const [name, unit] of units)
    row(
      `${name}, 1 MiB, table 4096 x 16`,
      scan(() => fill(unit, MiB), base64Table),
    );
  row(
    "rule 6: one line of headers, then base64 lines, 1 MiB, table 4096 x 16",
    scan(() => {
      const head = j(begin, " RSA ", privateKey, "-----");
      return (
        head.repeat(Math.floor(MiB / 2 / head.length)) +
        "\n" +
        ("A".repeat(64) + "\n").repeat(Math.ceil(MiB / 2 / 65))
      ).slice(0, MiB);
    }, base64Table),
  );
  row(
    "rule 6: field lines that each hold a header, then base64 lines, 1 MiB, table 4096 x 16",
    scan(() => {
      const field = j("K: ", begin, " RSA ", privateKey, "-----\n");
      return (
        field.repeat(Math.floor(MiB / 2 / field.length)) +
        ("A".repeat(64) + "\n").repeat(Math.ceil(MiB / 2 / 65))
      ).slice(0, MiB);
    }, base64Table),
  );
  row(
    "rule 6: a header constant and an END constant 300 code lines apart, 1 MiB, table 4096 x 16",
    scan(
      () =>
        fill(
          j(
            'const A = "',
            begin,
            " RSA ",
            privateKey,
            '-----";\n',
            "const x = compute(y);\n".repeat(300),
            'const B = "-----END RSA ',
            privateKey,
            '-----";\n',
          ),
          MiB,
        ),
      base64Table,
    ),
  );
  for (const size of [64 * KiB, 256 * KiB])
    row(
      `regression: ${size / KiB} KiB of repeated -eyJ, table 0`,
      scan(
        () => fill("-eyJ", size),
        () => [],
      ),
    );
  return rows;
}

export const GO_DSN_REVISION_2 =
  /[^/\s:@"']{1,256}:(?<value>[^/\s@"'$<]{1,16384})@(?:tcp|unix)\((?<host>[^):\s]+)/dg;
