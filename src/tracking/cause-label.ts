import {
  CauseAssigner,
  CauseAttribute,
  CauseCategory,
  effectiveCauseSchema,
  type EffectiveCause,
} from "../kernel/cause.ts";
import type { Attributes } from "./contract.ts";

export { causeLabelSpanIdSchema, causeLabelTextIdSchema } from "./contract.ts";

export const CAUSE_LABEL_OPERATION = "tracking.cause_label";
export const CAUSE_LABEL_SUFFIX = ".cause_label";
const CAUSE_LABEL_REASON_SUFFIX = `${CAUSE_LABEL_SUFFIX}:reason`;

export function causeLabelSpanId(rootSpanId: string): string {
  return `${rootSpanId}${CAUSE_LABEL_SUFFIX}`;
}

export function causeLabelReasonTextId(rootSpanId: string): string {
  return `${rootSpanId}${CAUSE_LABEL_REASON_SUFFIX}`;
}

function subcategoryOf(attributes: Attributes) {
  const subcategory = attributes[CauseAttribute.Subcategory];
  return subcategory === undefined ? {} : { subcategory };
}

function causeOfLabel(label: Attributes): unknown {
  return {
    category: label[CauseAttribute.Category],
    assigner: CauseAssigner.Human,
    ...subcategoryOf(label),
  };
}

function causeOfRoot(root: Attributes): unknown {
  const category = root[CauseAttribute.Category];
  return {
    category,
    assigner: root[CauseAttribute.Assigner],
    ...subcategoryOf(root),
    ...(category === CauseCategory.Unattributed
      ? { suspects: root[CauseAttribute.Suspects] ?? [] }
      : {}),
  };
}

function candidateOf(
  root: Attributes | null,
  label: Attributes | null,
): unknown {
  if (label !== null && CauseAttribute.Category in label)
    return causeOfLabel(label);
  if (root !== null && CauseAttribute.Category in root)
    return causeOfRoot(root);
  return null;
}

export function effectiveCauseOf(
  root: Attributes | null,
  label: Attributes | null,
): EffectiveCause | null {
  const parsed = effectiveCauseSchema.safeParse(candidateOf(root, label));
  return parsed.success ? parsed.data : null;
}
