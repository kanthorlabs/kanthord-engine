import { z } from "zod";
import { type HumanActor, humanActorSchema } from "../kernel/actor.ts";
import type { Transaction } from "../kernel/store.ts";
import {
  FootprintKind,
  type FootprintThreshold,
  footprintThresholdSchema,
} from "./contract.ts";

export interface StoredAlert {
  readonly alert_id: string;
  readonly kind: FootprintKind;
  readonly instance_name: string | null;
  readonly item_key: string | null;
  readonly threshold: FootprintThreshold;
  readonly value: number;
  readonly resolved_at: number | null;
  readonly acknowledged_by: HumanActor | null;
  readonly acknowledged_at: number | null;
  readonly acknowledged_until: number | null;
}

interface AlertRow {
  id: string;
  kind: string;
  instance_name: string | null;
  item_key: string | null;
  threshold: string;
  value: number;
  resolved_at: number | null;
  acknowledged_by: string | null;
  acknowledged_at: number | null;
  acknowledged_until: number | null;
}

const COLUMNS =
  "id, kind, instance_name, item_key, threshold, value, resolved_at, acknowledged_by, acknowledged_at, acknowledged_until";

function parsed(row: AlertRow): StoredAlert {
  return {
    alert_id: row.id,
    kind: z.enum(FootprintKind).parse(row.kind),
    instance_name: row.instance_name,
    item_key: row.item_key,
    threshold: footprintThresholdSchema.parse(JSON.parse(row.threshold)),
    value: row.value,
    resolved_at: row.resolved_at,
    acknowledged_by:
      row.acknowledged_by === null
        ? null
        : humanActorSchema.parse(JSON.parse(row.acknowledged_by)),
    acknowledged_at: row.acknowledged_at,
    acknowledged_until: row.acknowledged_until,
  };
}

export function insertAlert(tx: Transaction, alert: StoredAlert): void {
  tx.database
    .prepare(
      `INSERT INTO footprint_alert (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      alert.alert_id,
      z.enum(FootprintKind).parse(alert.kind),
      alert.instance_name,
      alert.item_key,
      JSON.stringify(footprintThresholdSchema.parse(alert.threshold)),
      alert.value,
      alert.resolved_at,
      alert.acknowledged_by === null
        ? null
        : JSON.stringify(humanActorSchema.parse(alert.acknowledged_by)),
      alert.acknowledged_at,
      alert.acknowledged_until,
    );
}

export function alertOf(tx: Transaction, alertId: string): StoredAlert | null {
  const row = tx.database
    .prepare(`SELECT ${COLUMNS} FROM footprint_alert WHERE id = ?`)
    .get(alertId) as AlertRow | undefined;
  return row === undefined ? null : parsed(row);
}

export function listAlerts(
  tx: Transaction,
  open: boolean | null,
  before: string | null,
  limit: number,
): StoredAlert[] {
  const rows = tx.database
    .prepare(
      `SELECT ${COLUMNS} FROM footprint_alert WHERE (? IS NULL OR (resolved_at IS NULL) = ?) AND (? IS NULL OR id < ?) ORDER BY id DESC LIMIT ?`,
    )
    .all(
      open === null ? null : 1,
      open === null ? null : Number(open),
      before,
      before,
      limit,
    ) as unknown as AlertRow[];
  return rows.map(parsed);
}

export function openAlerts(tx: Transaction): StoredAlert[] {
  const rows = tx.database
    .prepare(
      `SELECT ${COLUMNS} FROM footprint_alert WHERE resolved_at IS NULL ORDER BY id`,
    )
    .all() as unknown as AlertRow[];
  return rows.map(parsed);
}

export function acknowledgeAlert(
  tx: Transaction,
  alertId: string,
  by: HumanActor,
  at: number,
  until: number,
): void {
  tx.database
    .prepare(
      "UPDATE footprint_alert SET acknowledged_by = ?, acknowledged_at = ?, acknowledged_until = ? WHERE id = ?",
    )
    .run(JSON.stringify(humanActorSchema.parse(by)), at, until, alertId);
}

export function resolveAlert(
  tx: Transaction,
  alertId: string,
  at: number,
): void {
  tx.database
    .prepare("UPDATE footprint_alert SET resolved_at = ? WHERE id = ?")
    .run(at, alertId);
}
