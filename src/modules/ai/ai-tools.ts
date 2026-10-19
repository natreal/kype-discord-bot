/**
 * The concrete AI tools.
 *
 * Every tool here is a *declaration*: a name, a description, a category, the
 * permissions it needs, and a Zod validator plus an executor. The executor is the
 * only thing that touches Discord, and it does so exclusively through
 * `context.actions` (the `AiToolActionsPort`) or a guild-bound service — never a
 * raw `Guild`/`Client`. That is the non-negotiable boundary: the AI chooses a
 * tool from a menu, and a deterministic, permission-checked layer performs the
 * effect through the same services a human command would.
 *
 * Sensitive tools (ban, kick, timeout, purge) live in the `moderation` category
 * and are therefore only *reachable* in `large` mode (or a `custom` mode that
 * ticks it). Being reachable does not make them runnable: the author still needs
 * the matching granular permission, which the registry enforces before `execute`.
 */
import { z } from "zod";

import { ValidationError } from "../../utils/errors.js";
import type { AiTicketActionsPort, AiTicketSummary, AiTool, AiToolContext } from "./ai.module.js";

const roleName = z.string().trim().min(1).max(100);
const channelName = z.string().trim().min(1).max(100);
const snowflakePattern = /^\d{17,20}$/;
const memberId = z.string().trim().regex(snowflakePattern, "must be a user snowflake");

/**
 * Normalizes a tool argument that the model may send either as a proper object
 * (`{ name: "x" }`) or, when the declaration's shape is loose, as a bare scalar
 * (`"x"`). Tool declarations now advertise named properties, but providers and
 * models vary, so accepting both keeps a valid intent from failing validation.
 *
 * @param input The raw model-provided argument.
 * @param field The single field the scalar form maps onto.
 */
function asObject(input: unknown, field: string): Record<string, unknown> {
  if (input !== null && typeof input === "object" && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }
  return { [field]: input };
}

/** Reads a single field from an input that may be an object or a bare scalar. */
function scalarField(input: unknown, field: string): unknown {
  return asObject(input, field)[field];
}

/** A resolved channel/role target (id + current name). */
interface NamedTarget {
  readonly id: string;
  readonly name: string;
}

/**
 * Resolves a channel-ish target from a name or snowflake id: tries the by-name
 * lookup first so "kype delete the v7 channel" works without ids, then falls
 * back to treating the argument as an id. `kind` (when given) restricts the
 * by-name lookup to categories or non-categories.
 */
async function resolveChannel(
  context: AiToolContext,
  reference: string,
  kind?: "category" | "non-category",
): Promise<NamedTarget> {
  const byName = await context.actions.findChannelByName(reference, kind);
  if (byName) {
    return byName;
  }
  if (snowflakePattern.test(reference)) {
    return { id: reference, name: reference };
  }
  throw new ValidationError(
    `no channel named "${reference}" exists — check the spelling, or call list_channels to see the channels that do exist`,
  );
}

/** Resolves a role by name or snowflake id, or throws a clean refusal. */
async function resolveRole(context: AiToolContext, reference: string): Promise<NamedTarget> {
  const byName = await context.actions.findRoleByName(reference);
  if (byName) {
    return byName;
  }
  if (snowflakePattern.test(reference)) {
    return { id: reference, name: reference };
  }
  throw new ValidationError(
    `no role named "${reference}" exists — check the spelling, or call list_roles to see the roles that do exist`,
  );
}

/** Finds a thread id by name across the guild's active threads, or throws. */
async function findThreadId(context: AiToolContext, name: string): Promise<string> {
  const byName = await context.actions.findThreadByName(name);
  if (!byName) {
    throw new ValidationError(`no thread named "${name}" exists`);
  }
  return byName.id;
}


/** `create_role` — a safe, reversible effect. Strict/large. */
export const createRoleTool: AiTool<{ name: string }, { id: string; name: string }> = {
  name: "create_role",
  description: "Create a role with the given name.",
  category: "roles",
  requiredGranularPermissions: ["server.settings"],
  parameters: {
    type: "object",
    properties: { name: { type: "string", description: "The role name, e.g. \"Moderator\"." } },
    required: ["name"],
    additionalProperties: false,
  },
  validate: (input) => ({ name: roleName.parse(scalarField(input, "name")) }),
  execute: async (input, context) => {
    return context.actions.createRole(input.name);
  },
};

/** `assign_role` — grants an existing role to a user. Strict/large. */
export const assignRoleTool: AiTool<{ userId: string; role: string }, { ok: boolean }> = {
  name: "assign_role",
  description: "Assign an existing role to a user (by role name or id).",
  category: "roles",
  requiredGranularPermissions: ["server.settings"],
  parameters: {
    type: "object",
    properties: {
      userId: { type: "string", description: "The user's snowflake id." },
      role: { type: "string", description: "The role name or id." },
    },
    required: ["userId", "role"],
    additionalProperties: false,
  },
  validate: (input) => {
    const { userId, role } = z.object({ userId: memberId, role: roleName }).parse(input);
    return { userId, role };
  },
  execute: async (input, context) => {
    const role = await context.actions.findRoleByName(input.role);
    if (!role) {
      throw new ValidationError(
        `no role named "${input.role}" exists — check the spelling, or call list_roles to see the roles that do exist`,
      );
    }
    const result = await context.actions.setMemberRole(input.userId, role.id, true);
    if (!result.ok) {
      throw new ValidationError(result.detail ?? "Discord refused the change");
    }
    return { ok: true };
  },
};

/** `remove_role` — removes an existing role from a user. Strict/large. */
export const removeRoleTool: AiTool<{ userId: string; role: string }, { ok: boolean }> = {
  name: "remove_role",
  description: "Remove an existing role from a user (by role name or id).",
  category: "roles",
  requiredGranularPermissions: ["server.settings"],
  parameters: {
    type: "object",
    properties: {
      userId: { type: "string", description: "The user's snowflake id." },
      role: { type: "string", description: "The role name or id." },
    },
    required: ["userId", "role"],
    additionalProperties: false,
  },
  validate: (input) => {
    const { userId, role } = z.object({ userId: memberId, role: roleName }).parse(input);
    return { userId, role };
  },
  execute: async (input, context) => {
    const role = await context.actions.findRoleByName(input.role);
    if (!role) {
      throw new ValidationError(
        `no role named "${input.role}" exists — check the spelling, or call list_roles to see the roles that do exist`,
      );
    }
    const result = await context.actions.setMemberRole(input.userId, role.id, false);
    if (!result.ok) {
      throw new ValidationError(result.detail ?? "Discord refused the change");
    }
    return { ok: true };
  },
};

/** `list_roles` — read-only. Strict/large. */
export const listRolesTool: AiTool<Record<string, never>, { roles: string[] }> = {
  name: "list_roles",
  description: "List every role in the server.",
  category: "roles",
  parameters: { type: "object", properties: {}, additionalProperties: false },
  validate: () => ({}),
  execute: async (_input, context) => {
    const roles = await context.actions.listRoles();
    return { roles: roles.map((role) => role.name) };
  },
};

/**
 * `list_channels` — read-only. Strict/large.
 *
 * Exists so the agent can *check* a name before acting on it: "kype delete the v7
 * channel" either resolves or gives the model the real list to offer instead of a
 * vague failure, which is the difference between an actionable reply and a shrug.
 */
export const listChannelsTool: AiTool<Record<string, never>, { channels: string[] }> = {
  name: "list_channels",
  description:
    "List the server's channels with their ids and kinds, so a name can be verified before acting on it.",
  category: "channels",
  parameters: { type: "object", properties: {}, additionalProperties: false },
  validate: () => ({}),
  execute: async (_input, context) => {
    const channels = await context.actions.listChannels();
    return {
      channels: channels.map((channel) =>
        channel.parentId === null
          ? `${channel.name} (${channel.type}, id ${channel.id})`
          : `${channel.name} (${channel.type}, id ${channel.id}, under <#${channel.parentId}>)`,
      ),
    };
  },
};

/** `create_channel` — a safe, reversible effect. Strict/large. */
export const createChannelTool: AiTool<
  { name: string; type?: "text" | "voice" | "category"; topic?: string; parentId?: string; nsfw?: boolean },
  { id: string; name: string }
> = {
  name: "create_channel",
  description:
    "Create a channel (text, voice or category) with the given name. Optionally set a topic, parent category id, or NSFW flag.",
  category: "channels",
  requiredGranularPermissions: ["server.settings"],
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "The channel name, e.g. \"general\"." },
      type: {
        type: "string",
        enum: ["text", "voice", "category"],
        description: "Kind of channel; defaults to text.",
      },
      topic: { type: "string", description: "Optional channel topic (text channels only)." },
      parentId: { type: "string", description: "Optional parent category's snowflake id." },
      nsfw: { type: "boolean", description: "Mark the channel NSFW (text channels only)." },
    },
    required: ["name"],
    additionalProperties: false,
  },
  validate: (input) => {
    const parsed = z
      .object({
        name: channelName,
        type: z.enum(["text", "voice", "category"]).optional(),
        topic: z.string().trim().max(1024).optional(),
        parentId: z.string().trim().regex(snowflakePattern).optional(),
        nsfw: z.boolean().optional(),
      })
      .parse(asObject(input, "name"));
    return {
      name: parsed.name,
      ...(parsed.type === undefined ? {} : { type: parsed.type }),
      ...(parsed.topic === undefined ? {} : { topic: parsed.topic }),
      ...(parsed.parentId === undefined ? {} : { parentId: parsed.parentId }),
      ...(parsed.nsfw === undefined ? {} : { nsfw: parsed.nsfw }),
    };
  },
  execute: async (input, context) => {
    return context.actions.createChannel(input.name, {
      ...(input.type === undefined ? {} : { type: input.type }),
      ...(input.topic === undefined ? {} : { topic: input.topic }),
      ...(input.parentId === undefined ? {} : { parentId: input.parentId }),
      ...(input.nsfw === undefined ? {} : { nsfw: input.nsfw }),
    });
  },
};

/**
 * `delete_channel` — destroys a channel. Sensitive: Large/custom only.
 *
 * Deleting is irreversible (its message history goes with it), so it lives in the
 * `destructive` category — unreachable in `strict` mode — and still needs the
 * author's `server.settings` granular permission. The model may pass either a
 * channel name or a snowflake id; a name is resolved case-insensitively first so
 * the agent can honour "kype delete the v7 channel" without the caller pasting ids.
 */
export const deleteChannelTool: AiTool<{ channel: string }, { id: string; name: string }> = {
  name: "delete_channel",
  description: "Delete a channel by name or id. Large mode only; cannot be undone.",
  category: "destructive",
  requiredGranularPermissions: ["server.settings"],
  parameters: {
    type: "object",
    properties: { channel: { type: "string", description: "Channel name or id, e.g. \"v7\"." } },
    required: ["channel"],
    additionalProperties: false,
  },
  validate: (input) =>
    z.object({ channel: z.string().trim().min(1).max(100) }).parse(asObject(input, "channel")),
  execute: async (input, context) => {
    const byId = snowflakePattern.test(input.channel) ? input.channel : null;
    const target =
      (await context.actions.findChannelByName(input.channel)) ??
      (byId !== null ? { id: byId, name: byId } : null);
    if (!target) {
      throw new ValidationError(
        `no channel named "${input.channel}" exists — check the spelling, or call list_channels to see the channels that do exist`,
      );
    }
    const result = await context.actions.deleteChannel(target.id);
    if (!result.ok) {
      throw new ValidationError(result.detail ?? "Discord refused the deletion");
    }
    return { id: target.id, name: target.name };
  },
};

/**
 * `edit_channel` — renames a channel, sets its topic, toggles NSFW, sets
 * slow-mode, or moves it under a category. Reversible, so it lives in
 * `channels` (reachable in strict and large). Refuses when no field is provided
 * rather than issuing a no-op Discord call.
 */
export const editChannelTool: AiTool<
  { channel: string; name?: string; topic?: string; nsfw?: boolean; slowmodeSeconds?: number; parent?: string },
  { id: string; ok: boolean }
> = {
  name: "edit_channel",
  description:
    "Change a channel: rename it, set its topic, toggle NSFW, set slow-mode (seconds) or move it under a category. Identify it by name or id.",
  category: "channels",
  requiredGranularPermissions: ["server.settings"],
  parameters: {
    type: "object",
    properties: {
      channel: { type: "string", description: "Channel name or id to change." },
      name: { type: "string", description: "New channel name." },
      topic: { type: "string", description: "New topic (text channels)." },
      nsfw: { type: "boolean", description: "Set the NSFW flag." },
      slowmodeSeconds: { type: "number", description: "Slow-mode in seconds (0-21600)." },
      parent: { type: "string", description: "Category name or id to move the channel under." },
    },
    required: ["channel"],
    additionalProperties: false,
  },
  validate: (input) => {
    const parsed = z
      .object({
        channel: z.string().trim().min(1).max(100),
        name: channelName.optional(),
        topic: z.string().trim().max(1024).optional(),
        nsfw: z.boolean().optional(),
        slowmodeSeconds: z.number().int().min(0).max(21_600).optional(),
        parent: z.string().trim().min(1).max(100).optional(),
      })
      .parse(input);
    return {
      channel: parsed.channel,
      ...(parsed.name === undefined ? {} : { name: parsed.name }),
      ...(parsed.topic === undefined ? {} : { topic: parsed.topic }),
      ...(parsed.nsfw === undefined ? {} : { nsfw: parsed.nsfw }),
      ...(parsed.slowmodeSeconds === undefined ? {} : { slowmodeSeconds: parsed.slowmodeSeconds }),
      ...(parsed.parent === undefined ? {} : { parent: parsed.parent }),
    };
  },
  execute: async (input, context) => {
    if (
      input.name === undefined &&
      input.topic === undefined &&
      input.nsfw === undefined &&
      input.slowmodeSeconds === undefined &&
      input.parent === undefined
    ) {
      throw new ValidationError("no change was specified (name, topic, nsfw, slowmodeSeconds or parent)");
    }
    const target = await resolveChannel(context, input.channel, "non-category");
    const parentId =
      input.parent === undefined ? undefined : (await resolveChannel(context, input.parent, "category")).id;
    const result = await context.actions.editChannel(target.id, {
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.topic === undefined ? {} : { topic: input.topic }),
      ...(input.nsfw === undefined ? {} : { nsfw: input.nsfw }),
      ...(input.slowmodeSeconds === undefined ? {} : { slowmodeSeconds: input.slowmodeSeconds }),
      ...(parentId === undefined ? {} : { parentId }),
    });
    if (!result.ok) {
      throw new ValidationError(result.detail ?? "Discord refused the change");
    }
    return { id: target.id, ok: true };
  },
};

/** `rename_channel` — the rename-only shorthand of `edit_channel`. Strict/large. */
export const renameChannelTool: AiTool<{ channel: string; name: string }, { id: string; name: string }> = {
  name: "rename_channel",
  description: "Rename a channel by name or id.",
  category: "channels",
  requiredGranularPermissions: ["server.settings"],
  parameters: {
    type: "object",
    properties: {
      channel: { type: "string", description: "Channel name or id to rename." },
      name: { type: "string", description: "The new channel name." },
    },
    required: ["channel", "name"],
    additionalProperties: false,
  },
  validate: (input) =>
    z.object({ channel: z.string().trim().min(1).max(100), name: channelName }).parse(input),
  execute: async (input, context) => {
    const target = await resolveChannel(context, input.channel, "non-category");
    const result = await context.actions.editChannel(target.id, { name: input.name });
    if (!result.ok) {
      throw new ValidationError(result.detail ?? "Discord refused the rename");
    }
    return { id: target.id, name: input.name };
  },
};

/**
 * `modify_permissions` — changes one role's overwrite on one channel. Sensitive:
 * `permissions`, large/custom only.
 *
 * Scoped to a *role on a channel* rather than to a member: overwrites are how a
 * server actually locks a channel down, and a role overwrite is the auditable,
 * reversible version of it. The permission names are resolved by the adapter
 * against a fixed allow-list, so the model can turn `SendMessages` off but cannot
 * mint `Administrator`.
 */
export const modifyPermissionsTool: AiTool<
  { channel: string; role: string; allow?: string[]; deny?: string[] },
  { ok: boolean; channel: string; role: string; allowed: string[]; denied: string[] }
> = {
  name: "modify_permissions",
  description:
    "Allow or deny Discord permissions for one role on one channel (for example deny SendMessages for @everyone). Large mode only.",
  category: "permissions",
  requiredGranularPermissions: ["server.settings"],
  parameters: {
    type: "object",
    properties: {
      channel: { type: "string", description: "Channel name or id." },
      role: { type: "string", description: "Role name or id whose overwrite changes." },
      allow: {
        type: "array",
        items: { type: "string" },
        description: 'Permission names to allow, e.g. ["ViewChannel", "SendMessages"].',
      },
      deny: {
        type: "array",
        items: { type: "string" },
        description: 'Permission names to deny, e.g. ["SendMessages"].',
      },
    },
    required: ["channel", "role"],
    additionalProperties: false,
  },
  validate: (input) => {
    const parsed = z
      .object({
        channel: z.string().trim().min(1).max(100),
        role: z.string().trim().min(1).max(100),
        allow: z.array(z.string().trim().min(1).max(64)).max(50).optional(),
        deny: z.array(z.string().trim().min(1).max(64)).max(50).optional(),
      })
      .parse(input);
    if (parsed.allow === undefined && parsed.deny === undefined) {
      throw new ValidationError("no change was specified (allow or deny a permission)");
    }
    return {
      channel: parsed.channel,
      role: parsed.role,
      ...(parsed.allow === undefined ? {} : { allow: parsed.allow }),
      ...(parsed.deny === undefined ? {} : { deny: parsed.deny }),
    };
  },
  execute: async (input, context) => {
    const channel = await resolveChannel(context, input.channel, "non-category");
    const role = await resolveRole(context, input.role);
    const result = await context.actions.setChannelPermissions(channel.id, role.id, {
      ...(input.allow === undefined ? {} : { allow: input.allow }),
      ...(input.deny === undefined ? {} : { deny: input.deny }),
    });
    if (!result.ok) {
      throw new ValidationError(result.detail ?? "Discord refused the permission change");
    }
    return {
      ok: true,
      channel: channel.name,
      role: role.name,
      allowed: input.allow ?? [],
      denied: input.deny ?? [],
    };
  },
};


/** `create_category` — builds a category. Sensitive: `categories`, large/custom. */
export const createCategoryTool: AiTool<{ name: string }, { id: string; name: string }> = {
  name: "create_category",
  description: "Create a channel category. Large mode only.",
  category: "categories",
  requiredGranularPermissions: ["server.settings"],
  parameters: {
    type: "object",
    properties: { name: { type: "string", description: "The category name." } },
    required: ["name"],
    additionalProperties: false,
  },
  validate: (input) => ({ name: channelName.parse(scalarField(input, "name")) }),
  execute: async (input, context) => {
    return context.actions.createChannel(input.name, { type: "category" });
  },
};

/** `rename_category` — renames a category. Sensitive: `categories`, large/custom. */
export const renameCategoryTool: AiTool<{ category: string; name: string }, { id: string; name: string }> = {
  name: "rename_category",
  description: "Rename a category by name or id. Large mode only.",
  category: "categories",
  requiredGranularPermissions: ["server.settings"],
  parameters: {
    type: "object",
    properties: {
      category: { type: "string", description: "Category name or id to rename." },
      name: { type: "string", description: "The new category name." },
    },
    required: ["category", "name"],
    additionalProperties: false,
  },
  validate: (input) => z.object({ category: z.string().trim().min(1).max(100), name: channelName }).parse(input),
  execute: async (input, context) => {
    const target = await resolveChannel(context, input.category, "category");
    const result = await context.actions.editChannel(target.id, { name: input.name });
    if (!result.ok) {
      throw new ValidationError(result.detail ?? "Discord refused the rename");
    }
    return { id: target.id, name: input.name };
  },
};

/** `delete_category` — destroys a category. Sensitive: `destructive`, large/custom. */
export const deleteCategoryTool: AiTool<{ category: string }, { id: string; name: string }> = {
  name: "delete_category",
  description: "Delete a category by name or id. Large mode only; cannot be undone.",
  category: "destructive",
  requiredGranularPermissions: ["server.settings"],
  parameters: {
    type: "object",
    properties: { category: { type: "string", description: "Category name or id, e.g. \"Archive\"." } },
    required: ["category"],
    additionalProperties: false,
  },
  validate: (input) => z.object({ category: z.string().trim().min(1).max(100) }).parse(asObject(input, "category")),
  execute: async (input, context) => {
    const target = await resolveChannel(context, input.category, "category");
    const result = await context.actions.deleteChannel(target.id);
    if (!result.ok) {
      throw new ValidationError(result.detail ?? "Discord refused the deletion");
    }
    return { id: target.id, name: target.name };
  },
};

/** `rename_role` — renames a role. Strict/large. */
export const renameRoleTool: AiTool<{ role: string; name: string }, { id: string; name: string }> = {
  name: "rename_role",
  description: "Rename a role by name or id.",
  category: "roles",
  requiredGranularPermissions: ["server.settings"],
  parameters: {
    type: "object",
    properties: {
      role: { type: "string", description: "Role name or id to rename." },
      name: { type: "string", description: "The new role name." },
    },
    required: ["role", "name"],
    additionalProperties: false,
  },
  validate: (input) => z.object({ role: z.string().trim().min(1).max(100), name: roleName }).parse(input),
  execute: async (input, context) => {
    const target = await resolveRole(context, input.role);
    const result = await context.actions.editRole(target.id, { name: input.name });
    if (!result.ok) {
      throw new ValidationError(result.detail ?? "Discord refused the change");
    }
    return { id: target.id, name: input.name };
  },
};

/** `edit_role` — renames and/or recolours a role. Strict/large. */
export const editRoleTool: AiTool<{ role: string; name?: string; color?: string }, { id: string; ok: boolean }> = {
  name: "edit_role",
  description: "Change a role: rename it and/or recolour it (hex like \"#ffcc00\"). Identify it by name or id.",
  category: "roles",
  requiredGranularPermissions: ["server.settings"],
  parameters: {
    type: "object",
    properties: {
      role: { type: "string", description: "Role name or id to change." },
      name: { type: "string", description: "New role name." },
      color: { type: "string", description: "New role colour (hex, e.g. \"#ffcc00\")." },
    },
    required: ["role"],
    additionalProperties: false,
  },
  validate: (input) => {
    const parsed = z
      .object({
        role: z.string().trim().min(1).max(100),
        name: roleName.optional(),
        color: z.string().trim().regex(/^#?[0-9a-fA-F]{6}$/, "must be a hex colour").optional(),
      })
      .parse(input);
    return {
      role: parsed.role,
      ...(parsed.name === undefined ? {} : { name: parsed.name }),
      ...(parsed.color === undefined ? {} : { color: parsed.color }),
    };
  },
  execute: async (input, context) => {
    if (input.name === undefined && input.color === undefined) {
      throw new ValidationError("no change was specified (name or color)");
    }
    const target = await resolveRole(context, input.role);
    const result = await context.actions.editRole(target.id, {
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.color === undefined ? {} : { color: input.color }),
    });
    if (!result.ok) {
      throw new ValidationError(result.detail ?? "Discord refused the change");
    }
    return { id: target.id, ok: true };
  },
};

/** `delete_role` — destroys a role. Sensitive: `destructive`, large/custom. */
export const deleteRoleTool: AiTool<{ role: string }, { id: string; name: string }> = {
  name: "delete_role",
  description: "Delete a role by name or id. Large mode only; cannot be undone.",
  category: "destructive",
  requiredGranularPermissions: ["server.settings"],
  parameters: {
    type: "object",
    properties: { role: { type: "string", description: "Role name or id, e.g. \"Old Mod\"." } },
    required: ["role"],
    additionalProperties: false,
  },
  validate: (input) => z.object({ role: z.string().trim().min(1).max(100) }).parse(asObject(input, "role")),
  execute: async (input, context) => {
    const target = await resolveRole(context, input.role);
    const result = await context.actions.deleteRole(target.id);
    if (!result.ok) {
      throw new ValidationError(result.detail ?? "Discord refused the deletion");
    }
    return { id: target.id, name: target.name };
  },
};

/** `create_thread` — opens a thread. Sensitive: `threads`, large/custom. */
export const createThreadTool: AiTool<
  { channel: string; name: string; private?: boolean },
  { id: string; name: string }
> = {
  name: "create_thread",
  description: "Start a thread in a channel. Large mode only.",
  category: "threads",
  requiredGranularPermissions: ["server.settings"],
  parameters: {
    type: "object",
    properties: {
      channel: { type: "string", description: "Parent channel name or id." },
      name: { type: "string", description: "The thread name." },
      private: { type: "boolean", description: "Create a private thread (default false)." },
    },
    required: ["channel", "name"],
    additionalProperties: false,
  },
  validate: (input) => {
    const parsed = z
      .object({
        channel: z.string().trim().min(1).max(100),
        name: z.string().trim().min(1).max(100),
        private: z.boolean().optional(),
      })
      .parse(input);
    return {
      channel: parsed.channel,
      name: parsed.name,
      ...(parsed.private === undefined ? {} : { private: parsed.private }),
    };
  },
  execute: async (input, context) => {
    const target = await resolveChannel(context, input.channel, "non-category");
    return context.actions.createThread(target.id, input.name, input.private ?? false);
  },
};

/** `edit_thread` — renames/archives/locks a thread. Sensitive: `threads`, large/custom. */
export const editThreadTool: AiTool<
  { thread: string; name?: string; archived?: boolean; locked?: boolean },
  { id: string; ok: boolean }
> = {
  name: "edit_thread",
  description: "Change a thread: rename it, archive it or lock it. Large mode only.",
  category: "threads",
  requiredGranularPermissions: ["server.settings"],
  parameters: {
    type: "object",
    properties: {
      thread: { type: "string", description: "Thread name or id." },
      name: { type: "string", description: "New thread name." },
      archived: { type: "boolean", description: "Archive (true) or unarchive (false)." },
      locked: { type: "boolean", description: "Lock (true) or unlock (false)." },
    },
    required: ["thread"],
    additionalProperties: false,
  },
  validate: (input) => {
    const parsed = z
      .object({
        thread: z.string().trim().min(1).max(100),
        name: z.string().trim().min(1).max(100).optional(),
        archived: z.boolean().optional(),
        locked: z.boolean().optional(),
      })
      .parse(input);
    return {
      thread: parsed.thread,
      ...(parsed.name === undefined ? {} : { name: parsed.name }),
      ...(parsed.archived === undefined ? {} : { archived: parsed.archived }),
      ...(parsed.locked === undefined ? {} : { locked: parsed.locked }),
    };
  },
  execute: async (input, context) => {
    if (input.name === undefined && input.archived === undefined && input.locked === undefined) {
      throw new ValidationError("no change was specified (name, archived or locked)");
    }
    const threadId = snowflakePattern.test(input.thread) ? input.thread : await findThreadId(context, input.thread);
    const result = await context.actions.editThread(threadId, {
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.archived === undefined ? {} : { archived: input.archived }),
      ...(input.locked === undefined ? {} : { locked: input.locked }),
    });
    if (!result.ok) {
      throw new ValidationError(result.detail ?? "Discord refused the change");
    }
    return { id: threadId, ok: true };
  },
};

/** `delete_thread` — destroys a thread. Sensitive: `destructive`, large/custom. */
export const deleteThreadTool: AiTool<{ thread: string }, { id: string; ok: boolean }> = {
  name: "delete_thread",
  description: "Delete a thread by name or id. Large mode only; cannot be undone.",
  category: "destructive",
  requiredGranularPermissions: ["server.settings"],
  parameters: {
    type: "object",
    properties: { thread: { type: "string", description: "Thread name or id." } },
    required: ["thread"],
    additionalProperties: false,
  },
  validate: (input) => z.object({ thread: z.string().trim().min(1).max(100) }).parse(asObject(input, "thread")),
  execute: async (input, context) => {
    const threadId = snowflakePattern.test(input.thread) ? input.thread : await findThreadId(context, input.thread);
    const result = await context.actions.deleteThread(threadId);
    if (!result.ok) {
      throw new ValidationError(result.detail ?? "Discord refused the deletion");
    }
    return { id: threadId, ok: true };
  },
};

/**
 * Ticket tooling.
 *
 * The agent gets the same operations the ticket buttons offer — list, claim,
 * close, transcript, delete — and it reaches them through the ticket *service*,
 * never by touching a channel itself. The one-open-ticket rule, the claim race,
 * the transcript capture and the audit trail therefore behave identically whether
 * a human clicks a button or Kype acts on a request.
 */

/** @returns the ticket port, or refuses because the module is not wired here. */
function ticketPort(context: AiToolContext): AiTicketActionsPort {
  const tickets = context.actions.tickets;
  if (!tickets) {
    throw new ValidationError(
      "tickets are not available in this server — enable the tickets module with `/settings set area:tickets`",
    );
  }
  return tickets;
}

/** Resolves "#12", "12" or a ticket id to a ticket id, or throws a clean refusal. */
async function resolveTicketId(context: AiToolContext, reference: string): Promise<string> {
  const raw = reference.trim();
  const tickets = await ticketPort(context).list({ limit: 100 });
  const byId = tickets.find((ticket) => ticket.id === raw);
  if (byId) {
    return byId.id;
  }
  const number = Number.parseInt(raw.replace(/^#/, ""), 10);
  if (Number.isInteger(number)) {
    const byNumber = tickets.find((ticket) => ticket.number === number);
    if (byNumber) {
      return byNumber.id;
    }
  }
  throw new ValidationError(
    `no ticket "${raw}" exists — call list_tickets to see the tickets that do exist`,
  );
}

/** @returns one ticket as a single line the model can quote back verbatim. */
function describeTicket(ticket: AiTicketSummary): string {
  const handler = ticket.claimedById === null ? "nobody yet" : `<@${ticket.claimedById}>`;
  return `#${ticket.number} ${ticket.status} — "${ticket.subject ?? "(no subject)"}" in <#${ticket.channelId}>, handled by ${handler} (id ${ticket.id})`;
}

/** `list_tickets` — read-only queue. Sensitive: `tickets`, large/custom. */
export const listTicketsTool: AiTool<{ status?: string; limit?: number }, { tickets: string[] }> = {
  name: "list_tickets",
  description: "List this server's tickets (number, status, subject, handler and id). Large mode only.",
  category: "tickets",
  requiredGranularPermissions: ["tickets.view"],
  parameters: {
    type: "object",
    properties: {
      status: { type: "string", enum: ["open", "closed", "deleted"], description: "Optional status filter." },
      limit: { type: "number", description: "How many tickets to list (1-50, default 20)." },
    },
    additionalProperties: false,
  },
  validate: (input) => {
    const parsed = z
      .object({
        status: z.enum(["open", "closed", "deleted"]).optional(),
        limit: z.number().int().min(1).max(50).optional(),
      })
      .parse(input);
    return {
      ...(parsed.status === undefined ? {} : { status: parsed.status }),
      ...(parsed.limit === undefined ? {} : { limit: parsed.limit }),
    };
  },
  execute: async (input, context) => {
    const tickets = await ticketPort(context).list({
      ...(input.status === undefined ? {} : { status: input.status }),
      limit: input.limit ?? 20,
    });
    return { tickets: tickets.map(describeTicket) };
  },
};

/** `claim_ticket` — assigns a ticket to the caller. Sensitive: `tickets`. */
export const claimTicketTool: AiTool<{ ticket: string }, { ok: boolean; detail: string }> = {
  name: "claim_ticket",
  description: 'Assign a ticket to yourself, by number ("12", "#12") or id. Large mode only.',
  category: "tickets",
  requiredGranularPermissions: ["tickets.manage"],
  parameters: {
    type: "object",
    properties: { ticket: { type: "string", description: 'Ticket number or id, e.g. "12" or "#12".' } },
    required: ["ticket"],
    additionalProperties: false,
  },
  validate: (input) => z.object({ ticket: z.string().trim().min(1).max(100) }).parse(asObject(input, "ticket")),
  execute: async (input, context) => {
    const ticketId = await resolveTicketId(context, input.ticket);
    const result = await ticketPort(context).claim(ticketId, context.invoker.id);
    if (!result.ok) {
      throw new ValidationError(result.detail ?? "the ticket could not be claimed");
    }
    return { ok: true, detail: result.detail ?? "ticket claimed" };
  },
};

/** `close_ticket` — stores the transcript, then locks the channel. Sensitive: `tickets`. */
export const closeTicketTool: AiTool<{ ticket: string; reason?: string }, { ok: boolean; detail: string }> = {
  name: "close_ticket",
  description: "Close a ticket (its transcript is stored first), by number or id. Large mode only.",
  category: "tickets",
  requiredGranularPermissions: ["tickets.manage"],
  parameters: {
    type: "object",
    properties: {
      ticket: { type: "string", description: 'Ticket number or id, e.g. "12".' },
      reason: { type: "string", description: "Why it is being closed; kept in the transcript." },
    },
    required: ["ticket"],
    additionalProperties: false,
  },
  validate: (input) => {
    const parsed = z
      .object({
        ticket: z.string().trim().min(1).max(100),
        reason: z.string().trim().min(1).max(500).optional(),
      })
      .parse(input);
    return { ticket: parsed.ticket, ...(parsed.reason === undefined ? {} : { reason: parsed.reason }) };
  },
  execute: async (input, context) => {
    const ticketId = await resolveTicketId(context, input.ticket);
    const result = await ticketPort(context).close(ticketId, context.invoker.id, input.reason ?? "Closed by Kype");
    if (!result.ok) {
      throw new ValidationError(result.detail ?? "the ticket could not be closed");
    }
    return { ok: true, detail: result.detail ?? "ticket closed" };
  },
};

/** `read_ticket_transcript` — read-only. Sensitive: `tickets`, large/custom. */
export const readTicketTranscriptTool: AiTool<{ ticket: string }, { detail: string }> = {
  name: "read_ticket_transcript",
  description: "Check whether a ticket has a stored transcript and how many messages it holds. Large mode only.",
  category: "tickets",
  requiredGranularPermissions: ["tickets.view"],
  parameters: {
    type: "object",
    properties: { ticket: { type: "string", description: 'Ticket number or id, e.g. "12".' } },
    required: ["ticket"],
    additionalProperties: false,
  },
  validate: (input) => z.object({ ticket: z.string().trim().min(1).max(100) }).parse(asObject(input, "ticket")),
  execute: async (input, context) => {
    const ticketId = await resolveTicketId(context, input.ticket);
    const result = await ticketPort(context).transcript(ticketId);
    if (!result.ok) {
      throw new ValidationError(result.detail ?? "this ticket has no stored transcript yet");
    }
    return { detail: `transcript stored with ${result.messageCount ?? 0} messages` };
  },
};

/**
 * `delete_ticket` — destroys the ticket channel. Sensitive: `destructive`, large/custom.
 *
 * Deleting is irreversible for the channel, so it sits in the `destructive`
 * category alongside channel and role deletion; the stored transcript is taken
 * before the channel goes, which is what makes the deletion defensible.
 */
export const deleteTicketTool: AiTool<{ ticket: string }, { ok: boolean; detail: string }> = {
  name: "delete_ticket",
  description:
    "Delete a ticket's channel (a transcript is stored first), by number or id. Large mode only; cannot be undone.",
  category: "destructive",
  requiredGranularPermissions: ["tickets.manage"],
  parameters: {
    type: "object",
    properties: { ticket: { type: "string", description: 'Ticket number or id, e.g. "12".' } },
    required: ["ticket"],
    additionalProperties: false,
  },
  validate: (input) => z.object({ ticket: z.string().trim().min(1).max(100) }).parse(asObject(input, "ticket")),
  execute: async (input, context) => {
    const ticketId = await resolveTicketId(context, input.ticket);
    const result = await ticketPort(context).remove(ticketId, context.invoker.id);
    if (!result.ok) {
      throw new ValidationError(result.detail ?? "the ticket could not be deleted");
    }
    return { ok: true, detail: result.detail ?? "ticket deleted" };
  },
};

/** `send_message` — writes a message to a channel. Strict/large. */
export const sendMessageTool: AiTool<{ channelId: string; content: string }, { id: string }> = {
  name: "send_message",
  description: "Send a plain-text message to a channel.",
  category: "messages",
  parameters: {
    type: "object",
    properties: {
      channelId: { type: "string", description: "The target channel's snowflake id." },
      content: { type: "string", description: "The message text." },
    },
    required: ["channelId", "content"],
    additionalProperties: false,
  },
  validate: (input) =>
    z.object({ channelId: memberId, content: z.string().trim().min(1).max(2000) }).parse(input),
  execute: async (input, context) => {
    return context.actions.sendMessage(input.channelId, input.content);
  },
};

/** `summarize_channel` — read-only. Strict/large. */
export const summarizeChannelTool: AiTool<{ channelId: string; limit?: number }, { summary: string }> = {
  name: "summarize_channel",
  description: "Produce a concise summary of the recent messages in a channel.",
  category: "summary",
  parameters: {
    type: "object",
    properties: {
      channelId: { type: "string", description: "The channel's snowflake id." },
      limit: { type: "number", description: "How many recent messages to read (1-100)." },
    },
    required: ["channelId"],
    additionalProperties: false,
  },
  validate: (input) => {
    const { channelId, limit } = z
      .object({ channelId: memberId, limit: z.number().int().min(1).max(100).optional() })
      .parse(input);
    return limit === undefined ? { channelId } : { channelId, limit };
  },
  execute: async (input, context) => {
    const messages = await context.actions.readMessages(input.channelId, input.limit ?? 25);
    const summary = messages.map((message) => `${message.authorTag}: ${message.content}`).join("\n");
    return { summary: summary.slice(0, 4000) };
  },
};

/** `search_history` — read-only. Strict/large. */
export const searchHistoryTool: AiTool<{ channelId?: string; limit?: number }, { messages: string[] }> = {
  name: "search_history",
  description: "Read recent message history in a channel.",
  category: "history",
  parameters: {
    type: "object",
    properties: {
      channelId: { type: "string", description: "The channel's snowflake id." },
      limit: { type: "number", description: "How many recent messages to read (1-100)." },
    },
    additionalProperties: false,
  },
  validate: (input) => {
    const { channelId, limit } = z
      .object({ channelId: memberId.optional(), limit: z.number().int().min(1).max(100).optional() })
      .parse(input);
    return {
      ...(channelId === undefined ? {} : { channelId }),
      ...(limit === undefined ? {} : { limit }),
    };
  },
  execute: async (input, context) => {
    const messages =
      input.channelId !== undefined ? await context.actions.readMessages(input.channelId, input.limit ?? 25) : [];
    return { messages: messages.map((message) => `${message.authorTag}: ${message.content}`) };
  },
};

/** `recommend_moderation_action` — recommendation only, never acts. Strict/large. */
export const recommendModerationTool: AiTool<{ suggestion: string }, { recommendation: string }> = {
  name: "recommend_moderation_action",
  description: "Propose a moderation action for a human to confirm. Never acts itself.",
  category: "recommendation",
  parameters: {
    type: "object",
    properties: { suggestion: { type: "string", description: "The proposed moderation action." } },
    required: ["suggestion"],
    additionalProperties: false,
  },
  validate: (input) => ({ suggestion: z.string().trim().min(1).max(2000).parse(scalarField(input, "suggestion")) }),
  execute: (input) => Promise.resolve({ recommendation: input.suggestion }),
};

/** `remember` — writes a guild memory note. Gated by `memoryEnabled` at the agent. */
export const rememberTool: AiTool<{ key: string; content: string }, { key: string }> = {
  name: "remember",
  description: "Store a short note the assistant can recall later (guild memory).",
  category: "memory",
  parameters: {
    type: "object",
    properties: {
      key: { type: "string", description: "A short lookup key." },
      content: { type: "string", description: "The note to store." },
    },
    required: ["key", "content"],
    additionalProperties: false,
  },
  validate: (input) =>
    z.object({ key: z.string().trim().min(1).max(100), content: z.string().trim().min(1).max(2000) }).parse(input),
  execute: (input) => Promise.resolve({ key: input.key }),
};

/** `recall` — reads a guild memory note. Gated by `memoryEnabled` at the agent. */
export const recallTool: AiTool<{ key: string }, { content: string | null }> = {
  name: "recall",
  description: "Recall a previously stored note from guild memory.",
  category: "memory",
  parameters: {
    type: "object",
    properties: { key: { type: "string", description: "The lookup key to recall." } },
    required: ["key"],
    additionalProperties: false,
  },
  validate: (input) => ({ key: z.string().trim().min(1).max(100).parse(scalarField(input, "key")) }),
  execute: () => Promise.resolve({ content: null }),
};

/** `timeout` — sensitive moderation. Large only. */
export const timeoutTool: AiTool<{ userId: string; durationMs: number }, { ok: boolean }> = {
  name: "timeout",
  description: "Time a user out for a duration (milliseconds). Large mode only.",
  category: "moderation",
  requiredGranularPermissions: ["moderation.timeout"],
  parameters: {
    type: "object",
    properties: {
      userId: { type: "string", description: "The user's snowflake id." },
      durationMs: { type: "number", description: "Timeout duration in milliseconds." },
    },
    required: ["userId", "durationMs"],
    additionalProperties: false,
  },
  validate: (input) =>
    z
      .object({ userId: memberId, durationMs: z.number().int().min(5_000).max(28 * 24 * 60 * 60 * 1000) })
      .parse(input),
  execute: async (input, context) => {
    const result = await context.actions.moderate("timeout", input.userId, "AI agent");
    if (!result.ok) {
      throw new ValidationError(result.detail ?? "Discord refused the timeout");
    }
    return { ok: true };
  },
};

/** `kick` — sensitive moderation. Large only. */
export const kickTool: AiTool<{ userId: string }, { ok: boolean }> = {
  name: "kick",
  description: "Kick a user from the server. Large mode only.",
  category: "moderation",
  requiredGranularPermissions: ["moderation.kick"],
  parameters: {
    type: "object",
    properties: { userId: { type: "string", description: "The user's snowflake id." } },
    required: ["userId"],
    additionalProperties: false,
  },
  validate: (input) => ({ userId: memberId.parse(scalarField(input, "userId")) }),
  execute: async (input, context) => {
    const result = await context.actions.moderate("kick", input.userId, "AI agent");
    if (!result.ok) {
      throw new ValidationError(result.detail ?? "Discord refused the kick");
    }
    return { ok: true };
  },
};

/** `ban` — sensitive moderation. Large only. */
export const banTool: AiTool<{ userId: string }, { ok: boolean }> = {
  name: "ban",
  description: "Ban a user from the server. Large mode only.",
  category: "moderation",
  requiredGranularPermissions: ["moderation.ban"],
  parameters: {
    type: "object",
    properties: { userId: { type: "string", description: "The user's snowflake id." } },
    required: ["userId"],
    additionalProperties: false,
  },
  validate: (input) => ({ userId: memberId.parse(scalarField(input, "userId")) }),
  execute: async (input, context) => {
    const result = await context.actions.moderate("ban", input.userId, "AI agent");
    if (!result.ok) {
      throw new ValidationError(result.detail ?? "Discord refused the ban");
    }
    return { ok: true };
  },
};

/** `purge` — sensitive moderation. Large only. */
export const purgeTool: AiTool<{ channelId: string; count: number }, { purged: number }> = {
  name: "purge",
  description: "Bulk-delete recent messages in a channel. Large mode only.",
  category: "moderation",
  requiredGranularPermissions: ["moderation.purge"],
  parameters: {
    type: "object",
    properties: {
      channelId: { type: "string", description: "The channel's snowflake id." },
      count: { type: "number", description: "How many messages to delete (1-100)." },
    },
    required: ["channelId", "count"],
    additionalProperties: false,
  },
  validate: (input) =>
    z.object({ channelId: memberId, count: z.number().int().min(1).max(100) }).parse(input),
  execute: async (input, context) => {
    // A purge targets a channel, not a member: it goes through the dedicated
    // `purgeMessages` path so `count` is honoured and the real number removed is
    // reported, instead of being routed through the member-action pipeline (which
    // would look for a *member* with the channel's id and refuse).
    const result = await context.actions.purgeMessages(input.channelId, input.count);
    if (!result.ok) {
      throw new ValidationError(result.detail ?? "Discord refused the purge");
    }
    return { purged: result.purged };
  },
};

/** Every tool the registry registers, in a stable order (menu order). */
export const AI_TOOLS: readonly AiTool<unknown, unknown>[] = [
  createRoleTool,
  renameRoleTool,
  editRoleTool,
  assignRoleTool,
  removeRoleTool,
  listRolesTool,
  deleteRoleTool,
  createChannelTool,
  editChannelTool,
  renameChannelTool,
  deleteChannelTool,
  createCategoryTool,
  renameCategoryTool,
  deleteCategoryTool,
  createThreadTool,
  editThreadTool,
  deleteThreadTool,
  sendMessageTool,
  summarizeChannelTool,
  searchHistoryTool,
  recommendModerationTool,
  rememberTool,
  recallTool,
  timeoutTool,
  kickTool,
  banTool,
  purgeTool,
  // Introduced after the original registry: a channel inventory to check names
  // against, role-level channel overwrites, and the ticket operations.
  listChannelsTool,
  modifyPermissionsTool,
  listTicketsTool,
  claimTicketTool,
  closeTicketTool,
  readTicketTranscriptTool,
  deleteTicketTool,
];

/** Returns the tools keyed by name, for the agent's dispatch and the menu. */
export function toolsByName(): ReadonlyMap<string, AiTool<unknown, unknown>> {
  return new Map(AI_TOOLS.map((tool) => [tool.name, tool]));
}


