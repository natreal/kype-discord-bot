/**
 * Scheduler module (V6).
 *
 * The single place deferred work lives: temporary roles expiring, temporary
 * channels closing, reminders firing, and the automation engine's delayed actions
 * all become rows in `scheduled_tasks` and are executed by one engine.
 *
 * The split matters more than the code:
 *   - `scheduler.types.ts` — the contracts (task, handler, recurrence, options).
 *   - `task-registry.ts` — which kinds exist, with duplicate and unknown kinds
 *     rejected rather than silently ignored.
 *   - `scheduler.repository.ts` — the durable truth, including the conditional
 *     claim that makes two workers safe without a distributed lock.
 *   - `scheduler.service.ts` — the engine: claim, dispatch, and decide the outcome.
 */
export { SCHEDULER_MODULE_NAME, schedulerModule } from "./scheduler.module.js";
export {
  PrismaScheduledTaskRepository,
  type ScheduledTaskRepository,
} from "./scheduler.repository.js";
export { SchedulerService, type SchedulerServiceDeps } from "./scheduler.service.js";
export {
  DuplicateTaskHandlerError,
  TaskHandlerRegistry,
  UnknownTaskKindError,
} from "./task-registry.js";
export {
  MIN_RECURRENCE_SECONDS,
  SCHEDULED_TASK_STATUSES,
  SCHEDULER_DEFAULTS,
  type ScheduleTaskInput,
  type ScheduledTaskRecord,
  type ScheduledTaskStatus,
  type SchedulerOptions,
  type SchedulerTickResult,
  type TaskHandler,
  type TaskHandlerContext,
  type TaskHandlerResult,
  type TaskRecurrence,
} from "./scheduler.types.js";
