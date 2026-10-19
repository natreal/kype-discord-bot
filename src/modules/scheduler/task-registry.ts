/**
 * Registry of task kinds.
 *
 * A registry rather than a switch inside the scheduler, for one reason: the set
 * of things that can be deferred is owned by the *features*, not by the engine.
 * The roles module registers `role.expire`; the tickets module would register
 * `ticket.autoclose`; nothing in `scheduler.service.ts` mentions either.
 *
 * Two properties are enforced here, because they are the ones whose absence
 * causes silent wrong behaviour:
 *
 * - **A kind is unique.** Registering `role.expire` twice is a programming error:
 *   the second registration would either shadow the first (one of them silently
 *   never runs) or, worse, replace it. It throws instead.
 * - **An unknown kind is a hard failure at execution time.** A task row whose
 *   `kind` has no handler cannot be "ignored": ignoring it would mean a temporary
 *   role never gets removed and nothing says so. `resolve` throws a named error,
 *   and the scheduler fails the task so it surfaces in `lastError`.
 */
import { AppError } from "../../utils/errors.js";
import type { TaskHandler } from "./scheduler.types.js";

/** Raised when a task names a kind no module has registered a handler for. */
export class UnknownTaskKindError extends AppError {
  /** The unregistered task kind, kept as structured data for the caller. */
  public readonly taskKind: string;

  public constructor(taskKind: string, registered: readonly string[]) {
    super(`No handler is registered for scheduled task kind "${taskKind}".`, {
      code: "SCHEDULER_UNKNOWN_TASK_KIND",
      // Not user-facing: a task row naming an unregistered kind is a deployment or
      // registration problem, and the operator needs the log, not a Discord reply.
      expected: false,
      metadata: { kind: taskKind, registered: [...registered] },
    });
    this.taskKind = taskKind;
  }
}

/** Raised when a handler is registered twice for the same kind. */
export class DuplicateTaskHandlerError extends AppError {
  public constructor(kind: string) {
    super(`A handler for scheduled task kind "${kind}" is already registered.`, {
      code: "SCHEDULER_DUPLICATE_TASK_KIND",
      expected: false,
      metadata: { kind },
    });
  }
}

export class TaskHandlerRegistry {
  private readonly handlers = new Map<string, TaskHandler>();

  /** Registers one handler. Throws on a duplicate kind. */
  public register(handler: TaskHandler): void {
    if (this.handlers.has(handler.kind)) {
      throw new DuplicateTaskHandlerError(handler.kind);
    }
    this.handlers.set(handler.kind, handler);
  }

  /** Registers many handlers, failing as a unit if any is a duplicate. */
  public registerAll(handlers: readonly TaskHandler[]): void {
    for (const handler of handlers) {
      this.register(handler);
    }
  }

  /** The handler for a kind, or `null` when nothing claims it. */
  public find(kind: string): TaskHandler | null {
    return this.handlers.get(kind) ?? null;
  }

  /** The handler for a kind, throwing `UnknownTaskKindError` when absent. */
  public resolve(kind: string): TaskHandler {
    const handler = this.handlers.get(kind);
    if (!handler) {
      throw new UnknownTaskKindError(kind, this.kinds());
    }
    return handler;
  }

  public has(kind: string): boolean {
    return this.handlers.has(kind);
  }

  /** Every registered kind, sorted so output is stable across runs. */
  public kinds(): string[] {
    return [...this.handlers.keys()].sort();
  }

  /** Registered handlers, sorted by kind. Used by `/scheduler list`. */
  public list(): TaskHandler[] {
    return this.kinds().map((kind) => this.handlers.get(kind) as TaskHandler);
  }
}
