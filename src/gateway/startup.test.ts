import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { createServer } from "node:http";
import pino from "pino";
import { ulid } from "ulid";
import { decode } from "hono/jwt";
import { gatewayFixture, temporary } from "../test-support.ts";
import { KANTHORD_AUTH_USERNAME } from "./constants.ts";
import { Store } from "../store.ts";
import { configuration } from "../config/index.ts";
import { gatewayMigrations } from "./migrations.ts";
import { GatewayService } from "./service.ts";
import { CancellationContext } from "../context.ts";
import { isString } from "../shared/values.ts";
import { HealthStatus } from "../service.ts";

const NO_PENDING_KEYS = 0;
const LIVE_DENYLIST_ENTRIES = 1;

test("concurrent starts share startup and restart preserves locally issued human JWTs without storing credentials", async (t) => {
  const path = join(temporary(t), "kanthord.db");
  const fixture = await gatewayFixture(t, { path });
  assert.equal(await fixture.gateway.stop(), null);
  fixture.store.close();
  const store = new Store(path);
  t.after(() => store.close());
  store.migrate([{ service: "gateway", migrations: gatewayMigrations }]);
  const gateway = new GatewayService({
    config: fixture.config,
    store,
    logger: pino({ enabled: false }),
  });
  t.after(() => gateway.stop());
  const start = gateway.start();
  assert.equal(start, gateway.start());
  assert.equal(await start, null);
  assert.deepEqual(
    await gateway.authentication.authenticate(`Bearer ${fixture.token}`),
    {
      kind: "human",
      accountId: KANTHORD_AUTH_USERNAME,
      name: KANTHORD_AUTH_USERNAME,
      jti: decode(fixture.token).payload.jti,
    },
  );
  assert.equal(
    store.database
      .prepare("SELECT name FROM sqlite_master WHERE name = 'gateway_account'")
      .get(),
    undefined,
  );
  for (const table of ["gateway_idempotency", "gateway_token_denylist"])
    assert.deepEqual(
      store.database.prepare(`SELECT * FROM ${table}`).all(),
      [],
    );
  assert.equal(await gateway.stop(), null);
});

test("a failed listener releases resources and startup sweeps dead keys and expired bans", async (t) => {
  const listener = createServer();
  await new Promise<void>((resolve) =>
    listener.listen(0, "127.0.0.1", resolve),
  );
  t.after(
    () => new Promise<void>((resolve) => listener.close(() => resolve())),
  );
  const address = listener.address();
  assert.ok(address && !isString(address));
  const store = new Store(":memory:");
  t.after(() => store.close());
  store.migrate([{ service: "gateway", migrations: gatewayMigrations }]);
  store.transaction(({ database }) => {
    database
      .prepare(
        "INSERT INTO gateway_idempotency VALUES (?, 'test', 'digest', 'caller', 'in_progress', NULL, ?)",
      )
      .run(ulid(), Date.now());
    const insert = database.prepare(
      "INSERT INTO gateway_token_denylist VALUES (?, ?, ?)",
    );
    insert.run(ulid(), Date.now() - 1, Date.now() - 1000);
    insert.run(ulid(), Date.now() + 60000, Date.now());
  });
  const gateway = new GatewayService({
    store,
    config: configuration({
      masterKey: Buffer.alloc(32).toString("base64"),
      gateway: { port: address.port },
    }).getProperties(),
    logger: pino({ enabled: false }),
  });
  assert.match((await gateway.start())!.message, /cannot bind/);
  assert.equal(gateway.address(), undefined);
  assert.equal(
    store.database
      .prepare("SELECT count(*) AS count FROM gateway_idempotency")
      .get()?.count,
    NO_PENDING_KEYS,
  );
  assert.equal(
    store.database
      .prepare("SELECT count(*) AS count FROM gateway_token_denylist")
      .get()?.count,
    LIVE_DENYLIST_ENTRIES,
  );
  assert.equal(await gateway.stop(), null);
});

test("cancellation before and during gateway startup returns an error after releasing the listener", async (t) => {
  const store = new Store(":memory:");
  t.after(() => store.close());
  store.migrate([{ service: "gateway", migrations: gatewayMigrations }]);
  const config = configuration({
    masterKey: Buffer.alloc(32).toString("base64"),
    gateway: { port: 0 },
  }).getProperties();
  for (const before of [true, false]) {
    const context = new CancellationContext();
    const gateway = new GatewayService({
      config,
      store,
      logger: pino({ enabled: false }),
    });
    if (before) context.cancel();
    const running = gateway.run(context);
    if (!before) context.cancel();
    assert.ok((await running) instanceof Error);
    assert.equal(await gateway.stop(), null);
    assert.equal(gateway.address(), undefined);
    assert.ok(
      Object.values(await gateway.healthcheck()).every(
        (code) => code === HealthStatus.Unavailable,
      ),
    );
    assert.equal(
      store.database
        .prepare(
          "SELECT name FROM sqlite_master WHERE name = 'gateway_account'",
        )
        .get(),
      undefined,
    );
  }
});
