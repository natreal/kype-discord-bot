/**
 * Parses and validates a published `progress.json`.
 *
 * The validation mirrors `progress.py`'s own `validate_snapshot()`: every field
 * the bot later renders is checked for type and range, so a schema drift on the
 * upstream side surfaces as a named, reportable failure ("the snapshot does not
 * look like progress.json") instead of `NaN%` in a Discord embed. Nothing is
 * defaulted or guessed — an unreadable snapshot is a failed refresh, not a zero.
 */
import { z } from "zod";

import { ValidationError } from "../../utils/errors.js";

const nameList = z.array(z.string());

const groupSchema = z.object({
  name: z.string().min(1),
  label: z.string().optional(),
  done: z.number().int().min(0),
  todo: z.number().int().min(0),
  done_names: nameList.optional(),
  todo_names: nameList.optional(),
  inert_names: nameList.optional(),
  shared_sources: z.string().optional(),
});

const sectionSchema = z.object({
  done: z.number().int().min(0),
  total: z.number().int().min(0),
  percent: z.number().min(0).max(100),
  groups: z.array(groupSchema),
  extra: z.array(z.string()).optional(),
});

const progressSchema = z.object({
  libraries: sectionSchema,
  shaders: sectionSchema,
});

/** One library as the snapshot reports it. */
export interface SnapshotGroup {
  readonly name: string;
  readonly label: string;
  readonly done: number;
  readonly todo: number;
  readonly total: number;
  readonly percent: number;
  readonly doneNames: readonly string[];
  readonly todoNames: readonly string[];
  readonly inertNames: readonly string[];
  readonly sharedSources: string | null;
}

/** One section (libraries or shaders) of the snapshot. */
export interface SnapshotSection {
  readonly done: number;
  readonly total: number;
  readonly percent: number;
  readonly groups: readonly SnapshotGroup[];
}

/** A validated `progress.json`. */
export interface AnyPs5Progress {
  readonly libraries: SnapshotSection;
  readonly shaders: SnapshotSection & { readonly extra: readonly string[] };
}

/**
 * @param raw the parsed JSON body of `progress.json`.
 * @throws ValidationError when it is not shaped like a snapshot.
 */
export function parseProgressSnapshot(raw: unknown): AnyPs5Progress {
  const parsed = progressSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError("The AnyPS5 progress snapshot has an unexpected shape.", {
      issues: parsed.error.issues.slice(0, 5).map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
  }

  return {
    libraries: toSection(parsed.data.libraries),
    shaders: { ...toSection(parsed.data.shaders), extra: parsed.data.shaders.extra ?? [] },
  };
}

function toSection(section: z.infer<typeof sectionSchema>): SnapshotSection {
  return {
    done: section.done,
    total: section.total,
    percent: roundPercent(section.percent),
    groups: section.groups.map(toGroup),
  };
}

function toGroup(group: z.infer<typeof groupSchema>): SnapshotGroup {
  const total = group.done + group.todo;
  return {
    name: group.name,
    // A group's label is a display convenience; the name is the identity.
    label: group.label ?? group.name.replace(/^libSce/, ""),
    done: group.done,
    todo: group.todo,
    total,
    percent: total === 0 ? 0 : roundPercent((100 * group.done) / total),
    doneNames: group.done_names ?? [],
    todoNames: group.todo_names ?? [],
    inertNames: group.inert_names ?? [],
    sharedSources: group.shared_sources ?? null,
  };
}

/** Percentages are stored with the same 2-decimal precision the project uses. */
export function roundPercent(value: number): number {
  return Math.round(value * 100) / 100;
}
