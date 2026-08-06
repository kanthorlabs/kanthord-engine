import type { z } from "zod";

import { projectView } from "../../http/contract/project.ts";

export type ProjectView = z.infer<typeof projectView>;

export function printProjectView(
  stdout: (text: string) => void,
  view: ProjectView,
): void {
  stdout(`kanthord: project ${view.id}\n`);
  stdout(`kanthord: name ${view.name}\n`);
  const repositories =
    view.repositories.length === 0 ? "<none>" : view.repositories.join(",");
  stdout(`kanthord: repositories ${repositories}\n`);
}
