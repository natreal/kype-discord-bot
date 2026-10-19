/**
 * Public surface of the role module.
 *
 * Re-exported so `app.ts` and the commands import from one path, and so the
 * module's internals (the Prisma repository, the discord.js adapter) stay an
 * implementation detail of the files that construct them.
 */
export { roleModule, ROLE_MODULE_NAME, ROLE_RESOURCES } from "./role.module.js";
export {
  RoleService,
  ROLE_EXPIRE_TASK_KIND,
  ROLE_LIMITS,
  type RoleGrantOutcome,
  type RoleGrantRequest,
  type RoleListQuery,
  type RoleServiceDeps,
} from "./role.service.js";
export { PrismaRoleGrantRepository } from "./roles.repository.js";
export { DiscordRoleActions } from "./discord-role-actions.js";
export type {
  GuildRoleActionAdapter,
  GuildRoleActions,
  RoleActionResult,
  RoleGrantDraft,
  RoleGrantQuery,
  RoleGrantRecord,
  RoleGrantRepository,
  RoleGrantSource,
  RoleGrantStatus,
} from "./role.types.js";
