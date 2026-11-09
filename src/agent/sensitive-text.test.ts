import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, test } from "node:test";
import { getHeapStatistics, setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import {
  findKnownText,
  findPatternText,
  KNOWN_PART_MIN_CHARACTERS,
  knownMatcher,
  markerIndex,
  markerTag,
  matcherNodes,
  mergeSpans,
  redactValue,
  SCAN_FAILED,
  SENSITIVE_SCAN_MAX_CHARACTERS,
  SensitiveRule,
  type SensitiveSpan,
  SESSION_MARKER_PATTERN,
  sessionMarker,
  tracerMarker,
} from "./sensitive-text.ts";
import {
  GO_DSN_REVISION_2,
  MiB,
  scanRows,
  seededText,
} from "./sensitive-text-test-support.ts";

const j = (...parts: string[]) => parts.join("");
let { bytes } = seededText();
beforeEach(() => {
  ({ bytes } = seededText());
});
const pick = (alphabet: string, n: number) =>
  [...bytes(n)].map((byte) => alphabet[byte % alphabet.length]).join("");
const UP = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const LO = "abcdefghijklmnopqrstuvwxyz";
const DG = "0123456789";
const AN = UP + LO + DG;
const an = (n: number) => pick(AN, n);
const hx = (n: number) => pick("0123456789abcdef", n);
const b64 = (n: number) => pick(AN + "+/", n);
const u = (n: number) => pick(AN + "_-", n);
const up = (n: number) => pick(UP + DG, n);

const PASS = j("pass", "word");
const SECRET = j("sec", "ret");
const TOKEN = j("tok", "en");
const S3 = j("s3cr", "et");
const HUNTER = j("hunter2", "hunter2");
const ABC = j("abcdef", "123456");
const GHP = j("gh", "p_0123456789abcdefghijABCDEFGHIJ012345");
const BEGIN = j("-----BEG", "IN");
const END = "-----END";
const PRIVATE = j("PRIV", "ATE KEY");
const begin = (label: string) => j(BEGIN, " ", label, "-----");
const end = (label: string) => j(END, " ", label, "-----");
const pemBody = () => Array.from({ length: 4 }, () => b64(64)).join("\n");
const jwt = () => j("ey", "J", u(20), ".", "ey", "J", u(40), ".", u(43));
const ANTHROPIC_SECRET = () => j("sk", "-ant-api03-", u(93));

const rules = (text: string) => findPatternText(text).map((span) => span.rule);
const covered = (text: string, spans: readonly SensitiveSpan[]) =>
  spans.map((span) => text.slice(span.start, span.end));

test("every decision case of the reference scanner gives a span on deny and none on allow", () => {
  const cases: [string, string, boolean][] = [
    ["AWS access key ID", j("key = ", "AK", "IA", "IOSFODNN7EXAMPLE"), true],
    [
      "AWS secret access key",
      j(
        "aws_",
        SECRET,
        "_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfi",
        "CYEXAMPLEKEY",
      ),
      true,
    ],
    [
      "Postgres DSN",
      j("DATABASE_URL=postgres://app:", S3, "@db.internal:5432/app"),
      true,
    ],
    [
      "Go MySQL DSN",
      j('dsn := "app:', S3, '@tcp(db.internal:3306)/app"'),
      true,
    ],
    ["DSN on a public IP", j("mysql://app:", S3, "@10.0.0.5:3306/app"), true],
    [
      "DSN on a lookalike local host",
      j("postgres://app:", S3, "@localhost.evil.com/app"),
      true,
    ],
    [
      "DSN on a 192.168 prefix host name",
      j("postgres://app:", S3, "@192.168.1.10.evil.com/app"),
      true,
    ],
    [
      "local and remote DSN on one line",
      j(
        "a=postgres://app:",
        S3,
        "@localhost/app b=postgres://app:",
        S3,
        "@db.internal/app",
      ),
      true,
    ],
    ["private key", j(begin(j("RSA ", PRIVATE)), "\n", b64(64), "\n"), true],
    ["PKCS8 private key", j(begin(PRIVATE), "\n", b64(64), "\n"), true],
    ["GitHub token", j(TOKEN, ": ", GHP), true],
    [
      "Anthropic key",
      j("sk", "-ant-api03-0123456789abcdefghijABCDEFGHIJ"),
      true,
    ],
    ["password literal", j(PASS, ' = "', HUNTER, '"'), true],
    [
      "env file secret",
      j("export STRIPE_", SECRET.toUpperCase(), "=", ABC),
      true,
    ],
    [
      "debug secret literal",
      j("const ", SECRET.toUpperCase(), ' = "debug_fixture-value";'),
      false,
    ],
    [
      "test secret literal",
      j("const ", SECRET.toUpperCase(), " = 'test_fixture-value';"),
      false,
    ],
    ["JSON fixture value", '{"api_key":"test_fixture-value"}', false],
    [
      "debug env value",
      j("export SERVICE_", SECRET.toUpperCase(), "=debug_fixture-value"),
      false,
    ],
    [
      "test quoted env value",
      j("SERVICE_", TOKEN.toUpperCase(), '="test_fixture-value"'),
      false,
    ],
    [
      "test DSN password",
      "postgres://app:test_fixture-value@db.internal/app",
      false,
    ],
    [
      "debug Go DSN password",
      "app:debug_fixture-value@tcp(db.internal:3306)/app",
      false,
    ],
    [
      "fixture named variable with ordinary value",
      j("test_", SECRET, ' = "ordinary-value";'),
      true,
    ],
    ["uppercase prefix", j(SECRET, ' = "TEST_fixture-value";'), true],
    ["embedded prefix", j(SECRET, ' = "ordinary-test_fixture";'), true],
    [
      "prefix after a colon in the value",
      j(SECRET, ' = "ordinary:test_fixture";'),
      true,
    ],
    [
      "prefix after an equals sign in the value",
      j("SERVICE_", SECRET.toUpperCase(), "=ordinary=debug_fixture"),
      true,
    ],
    [
      "fixture and ordinary literal on one line",
      j(SECRET, ' = "test_fixture-value"; ', PASS, ' = "ordinary-value";'),
      true,
    ],
    [
      "fixture and ordinary JSON value on one line",
      j('{"', SECRET, '":"debug_fixture-value","', PASS, '":"ordinary-value"}'),
      true,
    ],
    [
      "fixture env and ordinary literal on one line",
      j(
        "SERVICE_",
        SECRET.toUpperCase(),
        "=test_fixture-value ",
        PASS,
        '="ordinary-value"',
      ),
      true,
    ],
    [
      "fixture and ordinary DSN on one line",
      "postgres://app:test_fixture@db/app postgres://app:ordinary-value@db/app",
      true,
    ],
    [
      "fixture DSN username with ordinary password",
      "postgres://test_user:ordinary-value@db/app",
      true,
    ],
    [
      "fixture Go DSN username with ordinary password",
      "debug_user:ordinary-value@tcp(db.internal:3306)/app",
      true,
    ],
    ["E2E env password", j("E2E_", PASS.toUpperCase(), "=", HUNTER), false],
    [
      "TEST exported env secret",
      j("export TEST_STRIPE_", SECRET.toUpperCase(), "=", ABC),
      false,
    ],
    ["DEBUG quoted env secret", 'DEBUG_API_KEY="ordinary value 12345"', false],
    [
      "TEST single-quoted env password",
      j("TEST_", PASS.toUpperCase(), "='", HUNTER, "'"),
      false,
    ],
    [
      "E2E env DSN",
      j("E2E_DATABASE_URL=postgres://app:", S3, "@db.internal/app"),
      false,
    ],
    [
      "TEST env token, a deviation",
      j("TEST_GITHUB_", TOKEN.toUpperCase(), "=", GHP),
      true,
    ],
    [
      "indented DEBUG env secret",
      j("  DEBUG_", SECRET.toUpperCase(), "=", ABC),
      false,
    ],
    [
      "YAML map env password",
      j("  E2E_", PASS.toUpperCase(), ": ", HUNTER),
      false,
    ],
    ["YAML map quoted env secret", j('TEST_API_KEY: "', ABC, '"'), false],
    [
      "YAML map single-quoted env DSN",
      j("DEBUG_DATABASE_URL: 'postgres://app:", S3, "@db.internal/app'"),
      false,
    ],
    [
      "YAML list env secret",
      j("      - TEST_STRIPE_", SECRET.toUpperCase(), "=", ABC),
      false,
    ],
    [
      "YAML list env token, a deviation",
      j("- E2E_GITHUB_", TOKEN.toUpperCase(), "=", GHP),
      true,
    ],
    [
      "YAML map ordinary secret",
      j("  STRIPE_", SECRET.toUpperCase(), ': "', ABC, '"'),
      true,
    ],
    [
      "YAML list ordinary secret",
      j("  - STRIPE_", SECRET.toUpperCase(), "=", ABC),
      true,
    ],
    [
      "YAML list double-quoted ordinary secret",
      j("  - STRIPE_", SECRET.toUpperCase(), '="', ABC, '"'),
      true,
    ],
    [
      "YAML list single-quoted ordinary secret",
      j("  - STRIPE_", SECRET.toUpperCase(), "='", ABC, "'"),
      true,
    ],
    [
      "YAML list env reference",
      j("  - DB_", PASS.toUpperCase(), "=${VAULT_DB_", PASS.toUpperCase(), "}"),
      false,
    ],
    [
      "YAML map without a space after the colon",
      j("TEST_", PASS.toUpperCase(), ':"', HUNTER, '"'),
      true,
    ],
    [
      "YAML map env and ordinary map on next line",
      j(
        "TEST_",
        SECRET.toUpperCase(),
        ": x\nSTRIPE_",
        SECRET.toUpperCase(),
        ": '",
        ABC,
        "'",
      ),
      true,
    ],
    [
      "lowercase env prefix",
      j("test_", SECRET.toUpperCase(), '="', ABC, '"'),
      true,
    ],
    [
      "embedded env prefix",
      j("APP_TEST_", SECRET.toUpperCase(), "=", ABC),
      true,
    ],
    [
      "prefix in a code literal",
      j("TEST_", PASS.toUpperCase(), ' = "', HUNTER, '"'),
      true,
    ],
    [
      "E2E env and ordinary literal on one line",
      j("export E2E_", SECRET.toUpperCase(), "=x ", PASS, '="', HUNTER, '"'),
      true,
    ],
    [
      "E2E env and ordinary env on next line",
      j(
        "E2E_",
        SECRET.toUpperCase(),
        "=",
        ABC,
        "\nSTRIPE_",
        SECRET.toUpperCase(),
        "=",
        ABC,
      ),
      true,
    ],
    [
      "JSON Web Token, a deviation",
      j(
        TOKEN,
        " = eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.",
        "dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
      ),
      true,
    ],
    ["plain source", 'func main() { fmt.Println("hello") }', false],
    [
      "DSN on localhost",
      j("postgres://app:", S3, "@localhost:5432/app"),
      false,
    ],
    ["DSN on 127.0.0.1", j("redis://default:", S3, "@127.0.0.1:6379/0"), false],
    [
      "DSN on 192.168 network",
      j("mongodb://app:", S3, "@192.168.1.20/app"),
      false,
    ],
    [
      "Go MySQL DSN on 127.0.0.1",
      j("app:", S3, "@tcp(127.0.0.1:3306)/app"),
      false,
    ],
    ["Go MySQL DSN on localhost", j("app:", S3, "@tcp(localhost)/app"), false],
    ["DSN without password", "postgres://app@db.internal:5432/app", false],
    [
      "DSN with env placeholder",
      j("postgres://app:${DB_", PASS.toUpperCase(), "}@db.internal/app"),
      false,
    ],
    [
      "password from env lookup",
      j(PASS, ' = os.getenv("DB_', PASS.toUpperCase(), '")'),
      false,
    ],
    [
      "password literal placeholder",
      j("export OPENCODE_SERVER_", PASS.toUpperCase(), '="$', PASS, '"'),
      false,
    ],
    [
      "code constant named like a token",
      j(TOKEN.toUpperCase(), '_ROW = re.compile(r"^abc")'),
      false,
    ],
    [
      "env file reference",
      j("DB_", PASS.toUpperCase(), "=${VAULT_DB_", PASS.toUpperCase(), "}"),
      false,
    ],
    [
      "DSN with angle placeholder",
      j("mysql://app:<", PASS, ">@db/app and app:<", PASS, ">@tcp(db)/app"),
      false,
    ],
  ];
  for (const [name, text, deny] of cases)
    assert.equal(Boolean(findPatternText(text).length), deny, name);
  assert.deepEqual(
    rules(
      j(
        "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.",
        "dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
      ),
    ),
    [SensitiveRule.Jwt],
  );
});

test("each shape of the category study gives a span of its rule", () => {
  const positives: [string, SensitiveRule, string][] = [
    ["AWS access key id", SensitiveRule.AwsAccessKeyId, j("AK", "IA", up(16))],
    [
      "AWS secret in credentials file",
      SensitiveRule.AwsSigningKey,
      j("aws_", SECRET, "_access_key = ", b64(40)),
    ],
    [
      "AWS session token env",
      SensitiveRule.AwsSessionToken,
      j("AWS_SESSION_", TOKEN.toUpperCase(), "=", b64(200)),
    ],
    ["Google API key", SensitiveRule.GoogleCloudKey, j("AI", "za", u(35))],
    [
      "Google OAuth client secret",
      SensitiveRule.GoogleCloudKey,
      j("GOC", "SPX-", u(28)),
    ],
    [
      "Google OAuth access token",
      SensitiveRule.GoogleCloudKey,
      j("ya", "29.", u(120)),
    ],
    [
      "GCP service account JSON private_key",
      SensitiveRule.PrivateKey,
      j(
        '{"private_key": "',
        begin(PRIVATE),
        "\\n",
        b64(64),
        "\\n",
        b64(64),
        "\\n",
        end(PRIVATE),
        '\\n"}',
      ),
    ],
    [
      "Azure storage connection string",
      SensitiveRule.ConnectionSecret,
      j(
        "DefaultEndpointsProtocol=https;AccountName=acme;Account",
        "Key=",
        b64(86),
        "==;EndpointSuffix=core.windows.net",
      ),
    ],
    [
      "Azure Service Bus connection string",
      SensitiveRule.ConnectionSecret,
      j(
        "Endpoint=sb://acme.servicebus.windows.net/;SharedAccessKeyName=Root;SharedAccess",
        "Key=",
        b64(43),
        "=",
      ),
    ],
    [
      "Azure SAS URL sig",
      SensitiveRule.ConnectionSecret,
      j(
        "https://acme.blob.core.windows.net/c/b?sv=2022-11-02&se=2026-12-01&sp=r&s",
        "ig=",
        b64(40),
        "%3D",
      ),
    ],
    [
      "AWS presigned URL signature",
      SensitiveRule.ConnectionSecret,
      j(
        "https://b.s3.amazonaws.com/k?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signa",
        "ture=",
        hx(64),
      ),
    ],
    ["GitHub classic PAT", SensitiveRule.PlatformToken, j("gh", "p_", an(36))],
    [
      "GitHub fine-grained PAT",
      SensitiveRule.PlatformToken,
      j("github_", "pat_", an(22), "_", an(59)),
    ],
    ["GitLab PAT", SensitiveRule.PlatformToken, j("gl", "pat-", u(20))],
    ["GitLab runner token", SensitiveRule.PlatformToken, j("gl", "rt-", u(20))],
    [
      "Bitbucket app password",
      SensitiveRule.PlatformToken,
      j("AT", "BB", an(32)),
    ],
    [
      "Atlassian API token",
      SensitiveRule.PlatformToken,
      j("ATA", "TT3", u(186)),
    ],
    ["npm token", SensitiveRule.PlatformToken, j("np", "m_", an(36))],
    [
      "PyPI token",
      SensitiveRule.PlatformToken,
      j("py", "pi-AgEIcHlwaS5vcmc", u(60)),
    ],
    ["Docker Hub PAT", SensitiveRule.PlatformToken, j("dc", "kr_pat_", u(27))],
    ["RubyGems key", SensitiveRule.PlatformToken, j("ruby", "gems_", hx(48))],
    ["DigitalOcean PAT", SensitiveRule.PlatformToken, j("do", "p_v1_", hx(64))],
    ["Vault service token", SensitiveRule.PlatformToken, j("hv", "s.", u(90))],
    [
      "Terraform Cloud token",
      SensitiveRule.PlatformToken,
      j(pick(LO + DG, 14), ".atlas", "v1.", u(67)),
    ],
    [
      "Supabase access token",
      SensitiveRule.PlatformToken,
      j("sb", "p_", hx(40)),
    ],
    [
      "OpenAI project key",
      SensitiveRule.LlmProviderKey,
      j("sk", "-proj-", u(120)),
    ],
    ["Anthropic key", SensitiveRule.LlmProviderKey, ANTHROPIC_SECRET()],
    [
      "OpenRouter key",
      SensitiveRule.LlmProviderKey,
      j("sk", "-or-v1-", hx(64)),
    ],
    ["Groq key", SensitiveRule.LlmProviderKey, j("gs", "k_", an(52))],
    ["Hugging Face token", SensitiveRule.LlmProviderKey, j("hf", "_", an(34))],
    ["xAI key", SensitiveRule.LlmProviderKey, j("xa", "i-", an(80))],
    ["Perplexity key", SensitiveRule.LlmProviderKey, j("pp", "lx-", an(48))],
    ["Replicate token", SensitiveRule.LlmProviderKey, j("r8", "_", an(37))],
    [
      "Mistral key in env",
      SensitiveRule.EnvAssignment,
      j("MISTRAL_API_", "KEY=", an(32)),
    ],
    [
      "Cohere key in env",
      SensitiveRule.EnvAssignment,
      j("COHERE_API_", "KEY=", an(40)),
    ],
    [
      "Slack bot token",
      SensitiveRule.ChatToken,
      j("xo", "xb-", DG.slice(0, 9), "-", an(24)),
    ],
    [
      "Slack app token",
      SensitiveRule.ChatToken,
      j("xa", "pp-1-", up(11), "-", hx(64)),
    ],
    [
      "Slack webhook URL",
      SensitiveRule.ChatToken,
      j(
        "https://hooks.",
        "slack.com/services/T",
        up(8),
        "/B",
        up(8),
        "/",
        an(24),
      ),
    ],
    [
      "Discord webhook URL",
      SensitiveRule.ChatToken,
      j("https://discord.com/api/", "webhooks/", pick(DG, 18), "/", u(68)),
    ],
    [
      "Telegram bot token",
      SensitiveRule.ChatToken,
      j(pick(DG, 10), ":A", "A", u(33)),
    ],
    [
      "Teams Workflows webhook URL",
      SensitiveRule.ConnectionSecret,
      j(
        "https://prod-1.westus.logic.azure.com:443/workflows/",
        hx(32),
        "/triggers/manual/paths/invoke?api-version=2016-06-01&sp=%2Ftriggers&sv=1.0&s",
        "ig=",
        u(43),
      ),
    ],
    [
      "Stripe live secret key",
      SensitiveRule.SaasToken,
      j("sk", "_live_", an(99)),
    ],
    [
      "Stripe restricted key",
      SensitiveRule.SaasToken,
      j("rk", "_live_", an(99)),
    ],
    ["Stripe webhook secret", SensitiveRule.SaasToken, j("wh", "sec_", an(32))],
    ["SendGrid key", SensitiveRule.SaasToken, j("S", "G.", u(22), ".", u(43))],
    ["Shopify access token", SensitiveRule.SaasToken, j("sh", "pat_", hx(32))],
    [
      "Twilio auth token in env",
      SensitiveRule.EnvAssignment,
      j("TWILIO_AUTH_", TOKEN.toUpperCase(), "=", hx(32)),
    ],
    [
      "curl Authorization Bearer",
      SensitiveRule.HttpCredential,
      j(
        'curl -H "Author',
        "ization: Bearer ",
        u(40),
        '" https://api.example.com',
      ),
    ],
    [
      "Authorization Basic",
      SensitiveRule.HttpCredential,
      j("Author", "ization: Basic ", b64(32)),
    ],
    [
      "GitHub token header",
      SensitiveRule.HttpCredential,
      j("Author", "ization: token ", an(40)),
    ],
    [
      "X-API-Key header",
      SensitiveRule.HttpCredential,
      j("X-API-", "Key: ", an(32)),
    ],
    [
      "GitLab Private-Token header",
      SensitiveRule.HttpCredential,
      j("PRIV", "ATE-TOKEN: ", an(20)),
    ],
    [
      "Cookie header",
      SensitiveRule.HttpCredential,
      j("Coo", "kie: session=", u(40), "; theme=dark"),
    ],
    [
      "Set-Cookie header",
      SensitiveRule.HttpCredential,
      j("Set-Coo", "kie: sid=", u(32), "; Path=/; HttpOnly"),
    ],
    [
      "curl -u basic auth",
      SensitiveRule.HttpCredential,
      j("curl -u admin:", an(12), " https://ci.example.com"),
    ],
    ["JWT bearer token", SensitiveRule.Jwt, jwt()],
    [
      "Supabase service role key in env",
      SensitiveRule.Jwt,
      j("SUPABASE_SERVICE_ROLE_KEY=", jwt()),
    ],
    [
      "PKCS8 PEM",
      SensitiveRule.PrivateKey,
      j(begin(PRIVATE), "\n", pemBody(), "\n", end(PRIVATE)),
    ],
    [
      "RSA PEM",
      SensitiveRule.PrivateKey,
      j(
        begin(j("RSA ", PRIVATE)),
        "\n",
        pemBody(),
        "\n",
        end(j("RSA ", PRIVATE)),
      ),
    ],
    [
      "Encrypted RSA PEM with fields",
      SensitiveRule.PrivateKey,
      j(
        begin(j("RSA ", PRIVATE)),
        "\nProc-Type: 4,ENCRYPTED\nDEK-Info: AES-128-CBC,",
        hx(32).toUpperCase(),
        "\n\n",
        pemBody(),
        "\n",
        end(j("RSA ", PRIVATE)),
      ),
    ],
    [
      "OpenSSH key",
      SensitiveRule.PrivateKey,
      j(
        begin(j("OPENSSH ", PRIVATE)),
        "\n",
        pemBody(),
        "\n",
        end(j("OPENSSH ", PRIVATE)),
      ),
    ],
    [
      "PGP armored private key",
      SensitiveRule.PrivateKey,
      j(
        begin(j("PGP ", PRIVATE, " BLOCK")),
        "\nComment: test\n\n",
        pemBody(),
        "\n=",
        b64(4),
        "\n",
        end(j("PGP ", PRIVATE, " BLOCK")),
      ),
    ],
    [
      "PuTTY key",
      SensitiveRule.PrivateKey,
      j(
        "PuTTY-User-Key-File-3: ssh-ed25519\nEncryption: none\nComment: k\nPublic-Lines: 2\n",
        b64(64),
        "\n",
        b64(20),
        "\nPrivate",
        "-Lines: 1\n",
        b64(44),
        "\nPrivate-MAC: ",
        hx(64),
      ),
    ],
    [
      "age secret key",
      SensitiveRule.PrivateKey,
      j("AGE-SECRET", "-KEY-1", up(58)),
    ],
    [
      "quoted password in code",
      SensitiveRule.QuotedAssignment,
      j("const ", PASS, ' = "', an(14), '";'),
    ],
    [
      "quoted api_key in JSON",
      SensitiveRule.QuotedAssignment,
      j('"api_key": "', an(32), '"'),
    ],
    [
      "refresh_token in OAuth JSON",
      SensitiveRule.QuotedAssignment,
      j('"refresh_', TOKEN, '": "1//0', u(60), '"'),
    ],
    [
      ".env secret",
      SensitiveRule.EnvAssignment,
      j("APP_", SECRET.toUpperCase(), "=", an(32)),
    ],
    [
      ".env DJANGO_SECRET_KEY",
      SensitiveRule.EnvAssignment,
      j("DJANGO_", SECRET.toUpperCase(), "_KEY=", an(50)),
    ],
    [
      "compose env map form",
      SensitiveRule.EnvAssignment,
      j("      POSTGRES_", PASS.toUpperCase(), ": ", an(16)),
    ],
    [
      "YAML lower password",
      SensitiveRule.EnvAssignment,
      j("    ", PASS, ": ", an(16)),
    ],
    ["INI lower password", SensitiveRule.EnvAssignment, j(PASS, " = ", an(16))],
    [
      "Postgres URL with password",
      SensitiveRule.UrlUserinfo,
      j("postgres://app:", an(16), "@db.internal:5432/app"),
    ],
    [
      "Redis URL with password only",
      SensitiveRule.UrlUserinfo,
      j("redis://:", an(16), "@cache.internal:6379"),
    ],
    [
      "Go MySQL DSN",
      SensitiveRule.GoMysqlDsn,
      j("app:", an(16), "@tcp(db.internal:3306)/app"),
    ],
    [
      "libpq key-value DSN",
      SensitiveRule.ConnectionSecret,
      j("host=db.internal user=app ", PASS, "=", an(16), " dbname=app"),
    ],
    [
      "ADO.NET connection string",
      SensitiveRule.ConnectionSecret,
      j("Server=db;Database=app;User Id=sa;Pass", "word=", an(16), ";"),
    ],
    [
      "JDBC query password",
      SensitiveRule.ConnectionSecret,
      j("jdbc:postgresql://db/app?user=app&", PASS, "=", an(16)),
    ],
    [
      "CLI --password= flag",
      SensitiveRule.ConnectionSecret,
      j(
        "helm repo add r https://r.example.com --username u --",
        PASS,
        "=",
        an(16),
      ),
    ],
    [
      "URL token query",
      SensitiveRule.ConnectionSecret,
      j("https://app.example.com/reset?", TOKEN, "=", u(32)),
    ],
    [
      ".npmrc _authToken",
      SensitiveRule.CredentialFile,
      j("//npm.pkg.github.com/:_auth", "Token=", an(40)),
    ],
    [
      "docker config auth",
      SensitiveRule.CredentialFile,
      j('{"auths":{"ghcr.io":{"au', 'th": "', b64(40), '"}}}'),
    ],
    [
      "kubeconfig client-key-data",
      SensitiveRule.CredentialFile,
      j("    client-key-", "data: ", b64(200)),
    ],
    [
      ".netrc one line",
      SensitiveRule.CredentialFile,
      j("machine api.example.com login u ", PASS, " ", an(20)),
    ],
    [
      ".netrc multi line",
      SensitiveRule.CredentialFile,
      j("  ", PASS, " ", an(20)),
    ],
    [
      ".git-credentials",
      SensitiveRule.UrlUserinfo,
      j("https://u:", an(40), "@github.com"),
    ],
  ];
  assert.equal(positives.length, SHAPES_INCLUDED);
  for (const [label, rule, text] of positives)
    assert.ok(rules(text).includes(rule), `${label}: ${rules(text).join(",")}`);
});

const SHAPES_INCLUDED = 86;

test("each text that stays visible gives no span", () => {
  const negatives: [string, string][] = [
    ["UUID", "550e8400-e29b-41d4-a716-446655440000"],
    ["git SHA", j("commit ", hx(40))],
    ["sha256 hex", j("sha256 ", hx(64))],
    [
      "lockfile integrity",
      j("    resolution: {integrity: sha512-", b64(86), "==}"),
    ],
    ["docker digest", j("image@sha256:", hx(64))],
    ["go.sum line", j("github.com/x/y v1.2.3 h1:", b64(43), "=")],
    [
      "ssh public key",
      j("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI", b64(43), " u@h"),
    ],
    [
      "PEM certificate",
      j(begin("CERTIFICATE"), "\n", pemBody(), "\n", end("CERTIFICATE")),
    ],
    [
      "PEM public key",
      j(begin("PUBLIC KEY"), "\n", pemBody(), "\n", end("PUBLIC KEY")),
    ],
    ["data URI image", j("data:image/png;base64,", b64(400))],
    ["random base64 blob", Array.from({ length: 8 }, () => u(76)).join("\n")],
    ["Stripe publishable key", j("pk", "_live_", an(99))],
    ["Stripe test key", j("sk", "_test_", an(99))],
    ["Stripe restricted test key", j("rk", "_test_", an(99))],
    ["Sentry DSN", j("https://", hx(32), "@o12345.ingest.sentry.io/678")],
    ["AWS ARN", "arn:aws:iam::123456789012:role/deploy"],
    ["npm package spec", "@scope/pkg@1.2.3"],
    ["ULID", "01JBZ9W8Q8A1V2X3Y4Z5A6B7C8"],
    [
      "shell expansion env",
      j("GITHUB_", TOKEN.toUpperCase(), "=${GITHUB_", TOKEN.toUpperCase(), "}"),
    ],
    ["moustache template", j(TOKEN, ": {{ secrets.X }}")],
    ["angle template", j(TOKEN, ": <", TOKEN, ">")],
    ["TS type annotation", j("  ", PASS, ": string;")],
    ["TS object property", j("  ", TOKEN, ": options.accessToken,")],
    ["TS property of a token", j("  ", PASS, ": ", TOKEN, ",")],
    [
      "upper TS property of a token",
      j("  KANTHORD_", TOKEN.toUpperCase(), ": ", TOKEN, ","),
    ],
    ["docker -u uid:gid", "docker run -u 1000:1000 node"],
    ["git push -u", "git push -u origin main"],
    ["bearer template", j("Author", "ization: `Bearer ${", TOKEN, "}`")],
    ["local Postgres URL", j("postgres://app:", an(16), "@localhost:5432/app")],
    [
      "a label of the rule set",
      j("  Platform", 'Token: "platform_', TOKEN, '",'),
    ],
  ];
  for (const [label, text] of negatives)
    assert.deepEqual(rules(text), [], label);
});

const only = (text: string) => {
  const spans = findPatternText(text);
  assert.equal(spans.length, ONE_SPAN, `${text.slice(0, 80)}: ${spans.length}`);
  return { rule: spans[0]!.rule, value: covered(text, spans)[0]! };
};
const ONE_SPAN = 1;

test("rule 4 masks the whole userinfo, with or without a user", () => {
  const password = an(16);
  assert.deepEqual(only(j("postgres://app:", password, "@db.example.com/x")), {
    rule: SensitiveRule.UrlUserinfo,
    value: j("app:", password),
  });
  assert.deepEqual(only(j("redis://:", password, "@cache.example.com")), {
    rule: SensitiveRule.UrlUserinfo,
    value: j(":", password),
  });
  assert.deepEqual(rules(j("https://", hx(32), "@o1.ingest.sentry.io/1")), []);
  assert.deepEqual(rules("postgres://app:test_value-1@db.example.com/x"), []);
  assert.deepEqual(rules("postgres://app:$PGPASS@db.example.com/x"), []);
  const long = an(1024);
  assert.equal(
    only(j("postgres://app:", long, "@db.example.com/x")).value,
    j("app:", long),
  );
});

test("rule 6 masks the body lines of a key and keeps its header and END line", () => {
  const pgpLabel = j("PGP ", PRIVATE, " BLOCK");
  const body = pemBody();
  const checksum = j("=", b64(4));
  const pgp = j(
    begin(pgpLabel),
    "\nComment: test\n\n",
    body,
    "\n",
    checksum,
    "\n",
    end(pgpLabel),
  );
  assert.deepEqual(covered(pgp, findPatternText(pgp)), [
    j(body, "\n", checksum),
  ]);
  const kept = b64(44);
  const putty = j(
    "Public-Lines: 1\n",
    b64(64),
    "\nPrivate",
    "-Lines: 2\n",
    b64(64),
    "\n",
    kept,
    "\nPrivate-MAC: ",
    hx(64),
  );
  assert.ok(covered(putty, findPatternText(putty))[0]!.endsWith(kept));
  assert.equal(findPatternText(putty).length, ONE_SPAN);
  const age = j("AGE-SECRET", "-KEY-1", up(58));
  assert.deepEqual(only(j("key: ", age, "\n")), {
    rule: SensitiveRule.PrivateKey,
    value: age,
  });
  const rsa = j("RSA ", PRIVATE);
  const pem = j(begin(rsa), "\n", body, "\n", end(rsa), "\nafter");
  assert.deepEqual(covered(pem, findPatternText(pem)), [body]);
  const open = j(begin(rsa), "\n", body);
  assert.deepEqual(covered(open, findPatternText(open)), [body]);
  const json = j('{"k": "', begin(rsa), ' trailing text"}\nnext line');
  assert.deepEqual(rules(json), []);
  const apart = j(
    'const A = "',
    begin(rsa),
    '";\n',
    "const x = compute(y);\n".repeat(300),
    'const B = "',
    end(rsa),
    '";\n',
  );
  assert.deepEqual(rules(apart), []);
  const encrypted = j(
    begin(rsa),
    "\nProc-Type: 4,ENCRYPTED\nDEK-Info: AES-128-CBC,",
    hx(32).toUpperCase(),
    "\n\n",
    body,
  );
  assert.deepEqual(covered(encrypted, findPatternText(encrypted)), [body]);
  const heads = j(begin(rsa).repeat(64), "\n", body, "\n");
  assert.deepEqual(covered(heads, findPatternText(heads)), [body]);
  const fields = j(j("K: ", begin(rsa), "\n").repeat(64), body, "\n");
  assert.deepEqual(covered(fields, findPatternText(fields)), [body]);
  for (const text of [pem, "plain text", pem])
    assert.equal(
      findPatternText(text).length,
      text === pem ? ONE_SPAN : NO_SPANS,
    );
});
const NO_SPANS = 0;

test("rule 6 masks no line of the SSH key module with a key body in the table", () => {
  const rsa = j("RSA ", PRIVATE);
  const body = Array.from({ length: 49 }, () => b64(64)).join("\n");
  const matcher = knownMatcher();
  const key = j(begin(rsa), "\n", body, "\n", end(rsa));
  for (const span of findPatternText(key))
    matcher.add({ value: span.value, rule: span.rule });
  assert.equal(findKnownText(key, matcher).length, ONE_SPAN);
  const module = readFileSync(
    join(import.meta.dirname, "../repository/ssh-key.ts"),
    "utf8",
  );
  assert.deepEqual(findKnownText(module, matcher), []);
});

test("rules 7, 8 and 9 keep the public part of a token visible", () => {
  const docker = j("dc", "kr_pat_", u(26), "-");
  assert.deepEqual(only(docker), {
    rule: SensitiveRule.PlatformToken,
    value: docker,
  });
  const id = pick(LO + DG, 14);
  const terraform = j(".atlas", "v1.", u(67));
  assert.deepEqual(only(j(id, terraform)), {
    rule: SensitiveRule.PlatformToken,
    value: terraform,
  });
  const slackPath = j("T", up(8), "/B", up(8), "/", an(24));
  assert.deepEqual(
    only(j("https://hooks.", "slack.com/services/", slackPath)),
    {
      rule: SensitiveRule.ChatToken,
      value: slackPath,
    },
  );
  const discordPath = j(pick(DG, 18), "/", u(68));
  assert.deepEqual(
    only(j("https://discord.com/api/", "webhooks/", discordPath)),
    {
      rule: SensitiveRule.ChatToken,
      value: discordPath,
    },
  );
  const bot = pick(DG, 9);
  const telegram = j(":A", "A", u(33));
  assert.deepEqual(only(j(bot, telegram)), {
    rule: SensitiveRule.ChatToken,
    value: telegram,
  });
  assert.equal(only(j("sk", "_live_", an(24))).rule, SensitiveRule.SaasToken);
  assert.deepEqual(rules(j("sk", "_test_", an(24))), []);
  assert.deepEqual(rules(j("rk", "_test_", an(24))), []);
  assert.equal(
    only(j("STRIPE_", SECRET.toUpperCase(), "_KEY=", "sk", "_test_", an(24)))
      .rule,
    SensitiveRule.EnvAssignment,
  );
});

test("rules 12 and 13 find each assignment form", () => {
  const value = an(16);
  assert.equal(only(j('"refresh_', TOKEN, '": "', value, '"')).value, value);
  assert.equal(only(j(TOKEN, ' = "', value, '"')).value, value);
  assert.deepEqual(rules(j("PlatformTok", 'en: "platform_', TOKEN, '"')), []);
  const forms = [
    j("spring:\n  datasource:\n    ", PASS, ": ", value),
    j("[pypi]\nusername = __token__\n", PASS, " = ", value),
    j("[client]\nuser=app\n", PASS, "=", value),
    j(
      "[global]\nindex-url = https://pypi.example.com/simple\n",
      PASS,
      " = ",
      value,
    ),
    j(
      "services:\n  db:\n    environment:\n      POSTGRES_",
      PASS.toUpperCase(),
      ": ",
      value,
    ),
  ];
  for (const text of forms)
    assert.deepEqual(
      only(text),
      { rule: SensitiveRule.EnvAssignment, value },
      text,
    );
  assert.deepEqual(rules(j("  ", PASS, ": ", TOKEN, ",")), []);
  assert.deepEqual(
    rules(j("  KANTHORD_", TOKEN.toUpperCase(), ": ", TOKEN, ",")),
    [],
  );
  const line = j("DB_", PASS.toUpperCase(), "=", value);
  const fixture = j("TEST_", PASS.toUpperCase(), "=", value);
  for (const prefix of [
    "src/a.env:12:",
    "src/a.env-12-",
    "+12 ",
    "-",
    "    12\t",
  ]) {
    assert.equal(only(j(prefix, line)).value, value, prefix);
    assert.deepEqual(rules(j(prefix, fixture)), [], prefix);
  }
});

test("rule 14 finds a connection secret in each form", () => {
  const value = an(16);
  const forms = [
    j("host=db user=app ", PASS, "=", value, " dbname=x"),
    j("jdbc:sqlserver://db;user=a;", PASS, "=", value, ";"),
    j("jdbc:mysql://db/x?user=a&", PASS, "=", value),
    j("Server=x;User Id=a;Pass", "word=", value, ";"),
    j("DefaultEndpointsProtocol=https;Account", "Key=", value, ";"),
    j("Endpoint=sb://x/;SharedAccess", "Key=", value),
    j("mysqldump --", PASS, "=", value),
    j("https://x.example.com/a?", TOKEN, "=", value),
    j("https://b.s3.amazonaws.com/k?X-Amz-Signa", "ture=", value),
  ];
  for (const text of forms)
    assert.deepEqual(
      only(text),
      { rule: SensitiveRule.ConnectionSecret, value },
      text,
    );
});

test("rule 15 finds an HTTP credential and keeps a template, a uid and a git flag", () => {
  const value = u(30);
  const forms = [
    j("Author", "ization: Bearer ", value),
    j("Author", "ization: Basic ", value),
    j("X-API-", "Key: ", value),
    j("Coo", "kie: sid=", value),
  ];
  for (const text of forms)
    assert.equal(only(text).rule, SensitiveRule.HttpCredential, text);
  const user = j("alice:", an(12));
  assert.equal(only(j("curl -u ", user, " https://x")).value, user);
  assert.equal(only(j("curl -s https://x --user=", user)).value, user);
  assert.equal(only(j("curl curl -u ", user)).value, user);
  for (const text of [
    "curl -u 1000:1000 https://x",
    "docker run -u 1000:1000 img",
    "git push -u origin main",
    j("Author", "ization: `Bearer ${", TOKEN, "}`"),
  ])
    assert.deepEqual(rules(text), [], text);
});

test("rule 16 walks a JSON Web Token from each word start", () => {
  const header = j("eyJ", "h".repeat(20));
  const payload = j("eyJ", "p".repeat(20));
  const real = j(header, ".", payload, ".", "s".repeat(30));
  const lead = j("eyJ", "q".repeat(12), ".eyJ", "r".repeat(4), "-");
  assert.deepEqual(covered(lead + real, findPatternText(lead + real)), [
    lead + real,
  ]);
  const chain = j(real, "-", real);
  assert.deepEqual(only(chain), { rule: SensitiveRule.Jwt, value: chain });
  assert.deepEqual(only(j("x ", real, " y")), {
    rule: SensitiveRule.Jwt,
    value: real,
  });
  assert.deepEqual(
    rules(j(header, ".", "x".repeat(20), ".", "s".repeat(30))),
    [],
  );
  assert.deepEqual(rules(j(header, ".", payload, ".", "s".repeat(10))), []);
  assert.equal(
    only(j("Author", "ization: Bearer ", real)).rule,
    SensitiveRule.HttpCredential,
  );
});

test("rule 17 finds a value of each tool credential file", () => {
  const value = an(30);
  const forms = [
    j("//registry.npmjs.org/:_auth", "Token=", value),
    j('{"auths":{"x":{"au', 'th":"', value, '"}}}'),
    j("    client-key-", "data: ", value),
    j("machine api.example.com login bob ", PASS, " ", value),
    j(PASS, " ", value),
  ];
  for (const text of forms)
    assert.deepEqual(
      only(text),
      { rule: SensitiveRule.CredentialFile, value },
      text,
    );
});

test("the escaped view finds a line of a JSON string and maps it to the source", () => {
  const value = an(16);
  const tail = JSON.stringify({
    tail: j(
      "line 1\nDB_",
      PASS.toUpperCase(),
      "=",
      value,
      "\r\n",
      PASS,
      ' = "',
      value,
      'x"\n',
    ),
  });
  assert.deepEqual(
    findPatternText(tail).map((span) => span.rule),
    [SensitiveRule.EnvAssignment, SensitiveRule.QuotedAssignment],
  );
  assert.deepEqual(covered(tail, findPatternText(tail)), [
    value,
    j(value, "x"),
  ]);
  const slash = j('"', PASS, ' = \\"', value, '\\\\\\\\\\"');
  const spans = findPatternText(slash);
  assert.ok(slash.slice(0, spans[0]!.end).endsWith(j("\\", "\\")));
  const newline = j("a\\\\n", "DB_", PASS.toUpperCase(), "=", value);
  assert.deepEqual(rules(newline), []);
  const secret = ANTHROPIC_SECRET();
  const matcher = knownMatcher();
  matcher.addSecret(secret);
  const part = secret.slice(40);
  const cut = JSON.stringify(j("first line\n", part, "\nnext"));
  assert.deepEqual(covered(cut, findKnownText(cut, matcher)), [part]);
});

test("a long value stays one span", () => {
  const long = jwt() + u(2000);
  assert.equal(only(j(TOKEN, ' = "', long, '"')).value, long);
});

test("rule 5 is anchored at the DSN literal and keeps every finding of the revision 2 regex", () => {
  const password = an(16);
  assert.deepEqual(only(j("app:", password, "@tcp(db.internal:3306)/app")), {
    rule: SensitiveRule.GoMysqlDsn,
    value: password,
  });
  assert.equal(only(j("us$:", password, "@unix(/tmp/s)")).value, password);
  assert.equal(only(j("us<:", password, "@tcp(db)")).value, password);
  const dense = j("a:".repeat(25 * 1024), "@tcp(h)");
  const cost = cpuMs(() =>
    assert.equal(findPatternText(dense).length, ONE_SPAN),
  );
  assert.ok(cost < CI_ROW_LIMIT_MS);
  const alphabet = [
    "a",
    "b",
    ":",
    ":",
    "@tcp(",
    "@unix(",
    "@",
    "h",
    ")",
    "/",
    " ",
    "$",
    "<",
    "test_",
    "localhost",
    "'",
  ];
  let seed = 11;
  const next = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed;
  };
  let compared = 0;
  for (let trial = 0; trial < DIFFERENTIAL_TRIALS; trial++) {
    const draw = (n: number) => Math.floor((next() / 2147483648) * n);
    const text = Array.from(
      { length: 4 + draw(12) },
      () => alphabet[draw(alphabet.length)],
    ).join("");
    const found = findPatternText(text).filter(
      (span) => span.rule === SensitiveRule.GoMysqlDsn,
    );
    for (const match of text.matchAll(GO_DSN_REVISION_2)) {
      const [start, stop] = match.indices!.groups!.value!;
      const host = match.groups!.host!;
      const value = text.slice(start, stop);
      if (
        /^(?:localhost|127\.0\.0\.1)$/.test(host) ||
        /^(?:debug_|test_)/.test(value)
      )
        continue;
      if (/^[$<{]/.test(value)) continue;
      compared++;
      assert.ok(
        found.some((span) => span.start <= start && span.end >= stop),
        JSON.stringify(text),
      );
    }
  }
  assert.ok(compared > DIFFERENTIAL_MIN_FINDINGS, String(compared));
});
const DIFFERENTIAL_MIN_FINDINGS = 1000;
const DIFFERENTIAL_TRIALS = 200000;
const CI_ROW_LIMIT_MS = 600;
const MICROSECONDS_PER_MS = 1000;

function cpuMs(run: () => unknown) {
  const before = process.threadCpuUsage();
  run();
  const used = process.threadCpuUsage(before);
  return (used.user + used.system) / MICROSECONDS_PER_MS;
}

test("overlapping spans merge, and the lowest rule number wins", () => {
  const value = an(16);
  const text = j("DB_", PASS.toUpperCase(), "=", value, "tail");
  const matcher = knownMatcher();
  matcher.add({
    value: j(value.slice(4), "tailmore"),
    rule: SensitiveRule.UrlUserinfo,
  });
  matcher.add({
    value: j(value.slice(8), "tail"),
    rule: SensitiveRule.UrlUserinfo,
  });
  const spans = mergeSpans(
    text,
    findKnownText(text, matcher),
    findPatternText(text),
  );
  assert.deepEqual(
    spans.map((span) => [span.rule, span.value]),
    [[SensitiveRule.UrlUserinfo, j(value, "tail")]],
  );
  const key = j("AK", "IA", up(16));
  const quoted = j(PASS, ' = "x-', key, '-y"');
  assert.deepEqual(only(quoted), {
    rule: SensitiveRule.AwsAccessKeyId,
    value: j("x-", key, "-y"),
  });
  const secret = ANTHROPIC_SECRET();
  const withSecret = knownMatcher();
  withSecret.addSecret(secret);
  assert.deepEqual(
    mergeSpans(
      secret,
      findKnownText(secret, withSecret),
      findPatternText(secret),
    ).map((span) => span.rule),
    [SensitiveRule.LlmCredential],
  );
});

test("a session marker holds no digit and keeps its index and tag", () => {
  const index = 4290;
  const tag = markerTag("0123456789abcdef");
  const marker = sessionMarker(SensitiveRule.LlmCredential, index, tag);
  assert.doesNotMatch(marker, /\d/);
  const [match] = [...marker.matchAll(SESSION_MARKER_PATTERN)];
  assert.equal(markerIndex(match!.groups!.index!), index);
  assert.equal(match!.groups!.tag, tag);
});

test("a session marker index has one form for each number", () => {
  const tag = markerTag("0123456789abcdef");
  const marked = (index: string) =>
    [
      ...j("<redacted:", SensitiveRule.Jwt, ":", index, ":", tag, ">").matchAll(
        SESSION_MARKER_PATTERN,
      ),
    ].length;
  const markers = ["a", "b", "ba"];
  const others = ["aa", "ab"];
  assert.deepEqual(
    markers.map(marked),
    markers.map(() => 1),
  );
  assert.deepEqual(
    others.map(marked),
    others.map(() => 0),
  );
});

test("a valid marker cuts a span and an invalid marker is scanned", () => {
  const marker = sessionMarker(
    SensitiveRule.QuotedAssignment,
    3,
    markerTag("9f2c41ab07d1e5c3"),
  );
  const before = an(8);
  const text = j(PASS, ' = "', before, marker, 'abc"');
  assert.deepEqual(covered(text, findPatternText(text)), [before, "abc"]);
  const tracer = j(PASS, ' = "', tracerMarker(SensitiveRule.Jwt), '"');
  assert.deepEqual(rules(tracer), []);
  const key = j("AK", "IA", up(16));
  assert.deepEqual(only(j("<redacted:", key, ">")), {
    rule: SensitiveRule.AwsAccessKeyId,
    value: key,
  });
});

test("findKnownText finds each form of a known secret", () => {
  const secret = ANTHROPIC_SECRET();
  const matcher = knownMatcher();
  matcher.addSecret(secret);
  const found = (text: string) =>
    findKnownText(text, matcher).some(
      (span) => span.rule === SensitiveRule.LlmCredential,
    );
  assert.ok(found(j("key ", secret, " end")));
  assert.ok(found(Buffer.from(secret).toString("base64url")));
  assert.ok(found(encodeURIComponent(j(secret, "/"))));
  for (const offset of [0, 1, 2]) {
    const encoded = Buffer.concat([
      Buffer.alloc(offset, 7),
      Buffer.from(secret),
      Buffer.from("!"),
    ]).toString("base64");
    assert.ok(found(encoded), String(offset));
  }
  const wrapped = (width: number) =>
    Buffer.from(j(secret, secret))
      .toString("base64")
      .match(new RegExp(`.{1,${width}}`, "g"))!;
  assert.ok(found(wrapped(64).join("\n")));
  assert.ok(found(wrapped(76).join("\n")));
  assert.ok(found(wrapped(76).join("\r\n")));
  assert.ok(
    found(
      wrapped(76)
        .map((line) => "  " + line)
        .join("\n"),
    ),
  );
  assert.ok(found(JSON.stringify(wrapped(76).join("\n"))));
  const short = Buffer.from(secret)
    .toString("base64")
    .match(/.{1,76}/g)!;
  assert.ok(found(j(short[0]!, "\n", short[1]!)));
  const singleLine = Buffer.from(secret.slice(0, 57)).toString("base64");
  assert.equal(singleLine.length, WRAP_WIDTH_MIME);
  const lone = knownMatcher();
  lone.addSecret(secret.slice(0, 57));
  assert.deepEqual(
    findKnownText(j(singleLine.slice(0, 30), "\n", singleLine.slice(30)), lone),
    [],
  );
  const later = ANTHROPIC_SECRET();
  assert.ok(!found(later));
  matcher.addSecret(later);
  assert.ok(found(Buffer.from(later).toString("base64url")));
  const line = j("x".repeat(400), secret.slice(0, 60));
  assert.ok(found(j(line, "... [truncated]")));
  assert.ok(found(j("tail of a long line\n", secret.slice(30), "\n")));
  const publicPart = secret.slice(
    0,
    j("sk", "-ant-api03-").length + KNOWN_PART_MIN_CHARACTERS - 1,
  );
  assert.ok(!found(j("x", publicPart, "... [truncated]")));
});
const WRAP_WIDTH_MIME = 76;

test("the matcher masks from each key to the longest value of that key", () => {
  const nested = knownMatcher();
  for (let length = NESTED_FIRST; length < NESTED_END; length++)
    nested.add({
      value: "a".repeat(length),
      rule: SensitiveRule.QuotedAssignment,
    });
  const text = "a".repeat(200);
  assert.deepEqual(
    findKnownText(text, nested).map((span) => [span.start, span.end]),
    [[0, 200]],
  );
  const value = an(64);
  const longer = knownMatcher();
  longer.add({ value, rule: SensitiveRule.QuotedAssignment });
  const shared = j(value.slice(0, 32), "-", an(40));
  assert.deepEqual(covered(shared, findKnownText(shared, longer)), [
    shared.slice(0, 64),
  ]);
  const whole = knownMatcher();
  const small = an(20);
  whole.add({ value: small, rule: SensitiveRule.QuotedAssignment });
  assert.deepEqual(findKnownText(small.slice(0, 19), whole), []);
  assert.equal(findKnownText(j("x", small, "y"), whole).length, ONE_SPAN);
});

test("the matcher equals a model of its 32-character keys", () => {
  let seed = 5;
  const next = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const marks = (spans: [number, number][], length: number) => {
    const set = new Uint8Array(length);
    for (const [start, stop] of spans) set.fill(1, start, stop);
    return set;
  };
  for (let trial = 0; trial < MATCHER_TRIALS; trial++) {
    const alphabet = ["ab", "abc", "aaaaaaab", "abcdefgh"][trial % 4]!;
    const draw = (n: number) =>
      Array.from(
        { length: n },
        () => alphabet[Math.floor(next() * alphabet.length)],
      ).join("");
    const base = draw(120);
    const values = Array.from({ length: 1 + Math.floor(next() * 120) }, () => {
      const start = Math.floor(next() * 40);
      return (
        base.slice(start, start + 12 + Math.floor(next() * 70)) +
        (next() < HALF ? draw(Math.floor(next() * 6)) : "")
      );
    }).filter((value) => value.length >= KNOWN_PART_MIN_CHARACTERS);
    const text = Array.from(
      { length: 6 },
      () => base.slice(Math.floor(next() * 40)) + draw(Math.floor(next() * 10)),
    ).join("");
    const matcher = knownMatcher();
    for (const value of values)
      matcher.add({ value, rule: SensitiveRule.QuotedAssignment });
    const got = marks(
      findKnownText(text, matcher).map((span) => [span.start, span.end]),
      text.length,
    );
    const reach = new Map<string, number>();
    for (const value of values) {
      const key = value.slice(0, 32);
      reach.set(key, Math.max(reach.get(key) ?? 0, value.length));
    }
    const model: [number, number][] = [];
    for (const [key, length] of reach)
      for (
        let at = text.indexOf(key);
        at !== NOT_FOUND;
        at = text.indexOf(key, at + 1)
      )
        model.push([at, Math.min(text.length, at + length)]);
    assert.deepEqual(
      got,
      marks(model, text.length),
      JSON.stringify({ values, text }),
    );
    for (const value of values)
      for (
        let at = text.indexOf(value);
        at !== NOT_FOUND;
        at = text.indexOf(value, at + 1)
      )
        assert.ok(got.subarray(at, at + value.length).every(Boolean));
  }
});
const MATCHER_TRIALS = 6000;
const NOT_FOUND = -1;
const NESTED_FIRST = 12;
const NESTED_END = 76;
const HALF = 0.5;
const SHARED_GROUPS = 455;
const GROUP_VALUES = 9;

test("the matcher holds at most 32 nodes for each value and keeps its heap bound", () => {
  const values = Array.from({ length: 4096 }, () => u(128));
  const before = retainedHeap();
  const matcher = knownMatcher();
  for (const value of values)
    matcher.add({ value, rule: SensitiveRule.QuotedAssignment });
  const nodes = matcherNodes(matcher);
  const growth = retainedHeap() - before;
  assert.ok(nodes <= values.length * 32 + 1);
  assert.ok(growth < MATCHER_HEAP_LIMIT_BYTES, String(growth));
  const groups = knownMatcher();
  for (let group = 0; group < SHARED_GROUPS; group++) {
    const prefix = u(2048);
    for (let k = 1; k <= GROUP_VALUES; k++)
      groups.add({
        value: prefix + "!".repeat(k),
        rule: SensitiveRule.QuotedAssignment,
      });
  }
  const cost = cpuMs(() =>
    assert.ok(matcherNodes(groups) <= SHARED_GROUPS * GROUP_VALUES * 32 + 1),
  );
  assert.ok(cost < CI_ROW_LIMIT_MS);
});
const MATCHER_HEAP_LIMIT_BYTES = 64 * 1024 * 1024;

function retainedHeap() {
  setFlagsFromString("--expose-gc");
  (runInNewContext("gc") as () => void)();
  return getHeapStatistics().used_heap_size;
}

test("a string above the scan limit becomes a scan failure", () => {
  const huge = "a".repeat(SENSITIVE_SCAN_MAX_CHARACTERS + 1);
  assert.throws(() => findPatternText(huge), RangeError);
  assert.deepEqual(redactValue({ text: huge }, knownMatcher()), {
    text: tracerMarker(SCAN_FAILED),
  });
});

test("the source of the rule set gives one span, the label of rule 14", () => {
  const source = readFileSync(
    join(import.meta.dirname, "sensitive-text.ts"),
    "utf8",
  );
  const spans = findPatternText(source);
  assert.deepEqual(
    spans.map((span) => [span.rule, span.value]),
    [[SensitiveRule.QuotedAssignment, SensitiveRule.ConnectionSecret]],
  );
});

test("redactValue keeps structural keys and session markers and masks each finding", () => {
  const marker = sessionMarker(
    SensitiveRule.UrlUserinfo,
    1,
    markerTag("9f2c41ab07d1e5c3"),
  );
  const key = j("AK", "IA", up(16));
  const secret = ANTHROPIC_SECRET();
  const matcher = knownMatcher();
  assert.deepEqual(
    redactValue(
      {
        type: "message",
        id: key,
        message: {
          role: "user",
          content: [{ type: "text", text: j("a ", key, " ", marker) }],
        },
      },
      matcher,
    ),
    {
      type: "message",
      id: key,
      message: {
        role: "user",
        content: [
          {
            type: "text",
            text: j(
              "a ",
              tracerMarker(SensitiveRule.AwsAccessKeyId),
              " ",
              marker,
            ),
          },
        ],
      },
    },
  );
  assert.deepEqual(redactValue([j("x ", secret)], matcher), [
    j("x ", tracerMarker(SensitiveRule.LlmProviderKey)),
  ]);
  matcher.addSecret(secret);
  assert.deepEqual(redactValue([j("x ", secret)], matcher), [
    j("x ", tracerMarker(SensitiveRule.LlmCredential)),
  ]);
});

test("every whole-scan row stays below the CI limit", () => {
  const code = readCode();
  for (const row of scanRows(code)) {
    const cost = cpuMs(row.prepare());
    assert.ok(cost < CI_ROW_LIMIT_MS, `${row.name}: ${cost.toFixed(1)} ms`);
  }
});

function readCode() {
  const root = join(import.meta.dirname, "..");
  const files = (readdirSync(root, { recursive: true }) as string[])
    .filter((path) => path.endsWith(".ts") && !path.endsWith(".test.ts"))
    .sort();
  let text = "";
  for (const path of files) {
    if (text.length >= MiB) break;
    text += readFileSync(join(root, path), "utf8");
  }
  return (n: number) => text.slice(0, n);
}
