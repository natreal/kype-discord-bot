/**
 * `/roles` — role and power-level management.
 *
 * One command that owns every role surface, so a server never has to leave Discord
 * or edit a database to answer "who can do what here?":
 *
 *   /roles list                     — every role, its power level and its member count
 *   /roles show    role             — one role: bound classes, granular permissions
 *   /roles classes                  — the built-in power levels and what each grants
 *   /roles bind    role class       — give a role a power level (the admin-role fix)
 *   /roles unbind  role class       — remove a power level from a role
 *   /roles create  name [class]     — create a role, optionally bound to a class
 *   /roles delete  role             — delete a role the bot can manage
 *
 * The command owns no permission logic of its own. It declares `server.settings` and
 * the authorization layer decides; it reads and writes bindings through
 * `PermissionClassStore` (the same store the authorization layer resolves), so a role
 * bound here takes effect on the very next command with no restart.
 *
 * Two invariants are worth stating because they are choices, not consequences:
 * - **A power level is granted by a role binding, never by editing a role's Discord
 *   permissions.** A class cannot grant a Discord bit, so binding a role to
 *   `administrator` gives the bot permissions (tickets, moderation, …) without ever
 *   touching `Administrator` on the role itself. This is the whole point of the
 *   admin power level: a role that does *not* hold Discord's `Administrator` can be
 *   bound to `administrator` and receive every bot permission.
 * - **Only `owner` is not bindable.** It is implied by Discord (the guild owner) and
 *   cannot be delegated to a role. `administrator` is bindable *in addition to* being
 *   implied: a member either holds Discord's `Administrator` bit, or holds a role
 *   bound to the class — both grant the class.
 */
import {
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Role,
} from "discord.js";

import { defineSlashCommand } from "../define.js";
import type { CommandExecutionContext } from "../context.js";
import { brandedEmbed, errorEmbed } from "../../utils/presenters.js";
import { ValidationError } from "../../utils/errors.js";
import { hasGodAccess } from "../../services/authorization/index.js";
import {
  BUILT_IN_PERMISSION_CLASSES,
  permissionsByModule,
  type Permission,
  type PermissionClassDefinition,
} from "../../services/authorization/index.js";

/**
 * The power levels a role may be bound to, in priority order (highest first).
 *
 * Every class is bindable except `owner`: the guild owner is a Discord fact that
 * cannot be delegated to a role. `administrator` *is* bindable — that is how a role
 * that does not hold Discord's `Administrator` bit gets the top bot power level — and
 * stays usable even though it is also implied for members who do hold the bit.
 */
const BINDABLE_CLASSES = BUILT_IN_PERMISSION_CLASSES.filter(
  (definition) => definition.key !== "owner",
);

/** Power levels shown by `/roles classes`, including the implied ones. */
const ALL_CLASSES = BUILT_IN_PERMISSION_CLASSES;

/**
 * The requirement every `/roles` subcommand declares.
 *
 * `server.settings` is deliberate: role and power-level management is server
 * configuration, and the granular classes already grant it to `bot-manager`. The
 * Discord bits are the operator's *own* guard rails — you must be able to manage
 * roles and the server — so the command never hardcodes a user ID.
 */
const MANAGE_REQUIREMENT = {
  discord: [PermissionFlagsBits.ManageRoles, PermissionFlagsBits.ManageGuild],
  custom: ["server.settings"] as readonly Permission[],
};

export default defineSlashCommand({
  meta: {
    name: "roles",
    description: "Manage roles and their power levels (permissions).",
    category: "utility",
    usage: "/roles list|show|classes|bind|unbind|create|delete",
    examples: [
      "/roles list",
      "/roles show role:@Moderator",
      "/roles bind role:@Staff class:administrator",
      "/roles create name:Announcements class:moderator color:#5865F2",
    ],
  },
  permissions: MANAGE_REQUIREMENT,
  data: new SlashCommandBuilder()
    .setName("roles")
    .setDescription("Manage roles and their power levels (permissions).")
    .addSubcommand((sub) =>
      sub.setName("list").setDescription("List every role and its power level."),
    )
    .addSubcommand((sub) =>
      sub
        .setName("show")
        .setDescription("Show one role: its power levels and granular permissions.")
        .addRoleOption((option) =>
          option.setName("role").setDescription("The role to inspect.").setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub.setName("classes").setDescription("List the built-in power levels and what each grants."),
    )
    .addSubcommand((sub) =>
      sub
        .setName("bind")
        .setDescription("Give a role a power level (permission class).")
        .addRoleOption((option) =>
          option.setName("role").setDescription("The role to bind.").setRequired(true),
        )
        .addStringOption((option) =>
          option
            .setName("class")
            .setDescription("The power level to grant.")
            .setRequired(true)
            .setAutocomplete(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("unbind")
        .setDescription("Remove a power level from a role.")
        .addRoleOption((option) =>
          option.setName("role").setDescription("The role to unbind.").setRequired(true),
        )
        .addStringOption((option) =>
          option
            .setName("class")
            .setDescription("The power level to remove.")
            .setRequired(true)
            .setAutocomplete(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("create")
        .setDescription("Create a role, optionally with a power level.")
        .addStringOption((option) =>
          option
            .setName("name")
            .setDescription("The role name.")
            .setRequired(true)
            .setMaxLength(100),
        )
        .addStringOption((option) =>
          option
            .setName("class")
            .setDescription("A power level to grant the new role.")
            .setAutocomplete(true),
        )
        .addStringOption((option) =>
          option.setName("color").setDescription("A hex colour, e.g. #5865F2."),
        )
        .addBooleanOption((option) =>
          option.setName("hoist").setDescription("Show the role separately in the member list."),
        )
        .addBooleanOption((option) =>
          option.setName("mentionable").setDescription("Allow members to mention the role."),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("delete")
        .setDescription("Delete a role the bot can manage.")
        .addRoleOption((option) =>
          option.setName("role").setDescription("The role to delete.").setRequired(true),
        ),
    ),

  autocomplete: async (interaction) => {
    const focused = interaction.options.getFocused(true);
    if (focused.name !== "class") {
      await interaction.respond([]);
      return;
    }
    const query = focused.value.trim().toLowerCase();
    const matches = BINDABLE_CLASSES.filter(
      (definition) =>
        query.length === 0 ||
        definition.key.includes(query) ||
        definition.name.toLowerCase().includes(query),
    )
      .slice(0, 25)
      .map((definition) => ({
        name: `${definition.name} — ${definition.permissions.length} permission(s)`,
        value: definition.key,
      }));
    await interaction.respond(matches);
  },

  execute: async (interaction, context) => {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    if (!interaction.guild) {
      await interaction.editReply({
        embeds: [errorEmbed("Roles", "This command only works inside a server.")],
      });
      return;
    }

    const subcommand = interaction.options.getSubcommand();
    switch (subcommand) {
      case "list":
        await replyWithList(interaction, context);
        return;
      case "classes":
        await replyWithClasses(interaction);
        return;
      case "show":
        await replyWithShow(interaction, context);
        return;
      case "bind":
        await handleBinding(interaction, context, "bind");
        return;
      case "unbind":
        await handleBinding(interaction, context, "unbind");
        return;
      case "create":
        await handleCreate(interaction, context);
        return;
      case "delete":
        await handleDelete(interaction, context);
        return;
      default:
        await interaction.editReply({
          embeds: [errorEmbed("Roles", `Unknown subcommand \`${subcommand}\`.`)],
        });
    }
  },
});

/** @returns the class definition for `key`, or `null` when it is not bindable. */
function bindableClass(key: string): PermissionClassDefinition | null {
  return BINDABLE_CLASSES.find((definition) => definition.key === key) ?? null;
}

/**
 * @returns the full `Role` behind a `/roles` role option, or `null`.
 *
 * `options.getRole` can hand back an `APIRole` (a partial) when the role was not in the
 * cache; the command needs `.members`, `.permissions` and `.delete`, so it resolves
 * through the guild's cache first and falls back to a fetch.
 */
async function resolveRole(interaction: ChatInputCommandInteraction): Promise<Role | null> {
  const option = interaction.options.getRole("role", true);
  const guild = interaction.guild;
  if (!guild) {
    return null;
  }
  const cached = guild.roles.cache.get(option.id);
  if (cached) {
    return cached;
  }
  try {
    return await guild.roles.fetch(option.id);
  } catch {
    return null;
  }
}

/** @returns the class keys a guild role is currently bound to, highest priority first. */
async function classesForRole(
  context: CommandExecutionContext,
  guildId: string,
  roleId: string,
): Promise<PermissionClassDefinition[]> {
  const [classes, bindings] = await Promise.all([
    context.permissionClasses.list(guildId),
    context.permissionClasses.listBindings(guildId),
  ]);
  const boundKeys = new Set(
    bindings.filter((binding) => binding.roleId === roleId).map((binding) => binding.classKey),
  );
  return classes
    .filter((definition) => boundKeys.has(definition.key))
    .sort((left, right) => right.priority - left.priority);
}

/** @returns a role's Discord permissions as a short, sorted description. */
function describeDiscordPermissions(role: Role): string {
  const names = role.permissions.toArray().sort();
  if (names.length === 0) {
    return "none";
  }
  // `Administrator` is special-cased: the array still lists it, but a reader needs to see
  // it first, because it makes every other entry redundant.
  const ordered = names.includes("Administrator")
    ? ["Administrator", ...names.filter((name) => name !== "Administrator")]
    : names;
  return ordered.join(", ");
}

/** `#5865F2` (or `5865F2`) → `0x5865f2`, or throws a user-facing validation error. */
function parseColor(raw: string): number {
  const match = raw.trim().match(/^#?([0-9a-fA-F]{6})$/);
  if (!match) {
    throw new ValidationError(`Expected a hex colour like \`#5865F2\`, received "${raw}"`, {
      value: raw,
    });
  }
  return Number.parseInt(match[1] as string, 16);
}

/** Replies with the built-in power levels and what each grants. */
async function replyWithClasses(interaction: ChatInputCommandInteraction): Promise<void> {
  const embed = brandedEmbed("Power levels").setDescription(
    "A power level is granted by binding a Discord role to a class. Binding a class " +
      "never grants a raw Discord permission — it grants the bot's own permissions.",
  );

  for (const definition of ALL_CLASSES) {
    const status =
      definition.key === "owner"
        ? "implicit (Discord) — never bound to a role"
        : definition.implied === true
          ? "bindable · also implicit for Discord administrators"
          : "bindable";
    embed.addFields({
      name: `${definition.name} — ${definition.key} (priority ${definition.priority})`,
      value: [
        definition.description,
        `**${status}** · ${definition.permissions.length} permission(s)`,
        "```" + summarizePermissions(definition.permissions) + "```",
      ].join("\n"),
    });
  }

  await interaction.editReply({ embeds: [embed] });
}

/** @returns the permissions grouped by module, as a compact multi-line string. */
function summarizePermissions(permissions: readonly Permission[]): string {
  const granted = new Set(permissions);
  const grouped = permissionsByModule();
  const lines: string[] = [];
  for (const [module, modulePermissions] of Object.entries(grouped)) {
    const owned = modulePermissions.filter((permission) => granted.has(permission));
    if (owned.length > 0) {
      lines.push(`${module}: ${owned.map((permission) => permission.split(".")[1]).join(", ")}`);
    }
  }
  return lines.join("\n") || "(none)";
}

/** Replies with every role in the guild, its power levels and its member count. */
async function replyWithList(
  interaction: ChatInputCommandInteraction,
  context: CommandExecutionContext,
): Promise<void> {
  const guild = interaction.guild;
  if (!guild) {
    return;
  }
  const [classes, bindings] = await Promise.all([
    context.permissionClasses.list(guild.id),
    context.permissionClasses.listBindings(guild.id),
  ]);
  const classByKey = new Map(classes.map((definition) => [definition.key, definition]));
  const labels = new Map<string, string[]>();
  for (const binding of bindings) {
    const definition = classByKey.get(binding.classKey);
    const label = definition ? definition.name : binding.classKey;
    labels.set(binding.roleId, [...(labels.get(binding.roleId) ?? []), label]);
  }

  const roles = [...guild.roles.cache.values()]
    .filter((role) => role.id !== guild.id)
    .sort((left, right) => right.position - left.position);

  const lines = roles.slice(0, 60).map((role) => {
    const bound = labels.get(role.id);
    const power = bound && bound.length > 0 ? bound.join(", ") : "—";
    return `<@&${role.id}> · ${role.members.size} member(s) · **${power}**`;
  });

  const embed = brandedEmbed(`Roles (${roles.length})`).setDescription(
    lines.length === 0 ? "This server has no roles yet." : lines.join("\n"),
  );
  if (roles.length > lines.length) {
    embed.setFooter({ text: `Showing ${lines.length} of ${roles.length} roles.` });
  }
  await interaction.editReply({ embeds: [embed] });
}

/** Replies with one role's power levels and granular permissions. */
async function replyWithShow(
  interaction: ChatInputCommandInteraction,
  context: CommandExecutionContext,
): Promise<void> {
  const guild = interaction.guild;
  if (!guild) {
    return;
  }
  const role = await resolveRole(interaction);
  if (!role) {
    await interaction.editReply({
      embeds: [errorEmbed("Role", "That role could not be resolved — it may have been deleted.")],
    });
    return;
  }

  const bound = await classesForRole(context, guild.id, role.id);
  const permissions = [...new Set(bound.flatMap((definition) => definition.permissions))].sort();

  const embed = brandedEmbed(`Role: ${role.name}`).addFields(
    { name: "ID", value: `\`${role.id}\``, inline: true },
    { name: "Members", value: String(role.members.size), inline: true },
    { name: "Position", value: String(role.position), inline: true },
    {
      name: "Power levels",
      value:
        bound.length === 0
          ? "none bound — this role grants no bot permissions"
          : bound.map((definition) => `${definition.name} (\`${definition.key}\`)`).join("\n"),
    },
    {
      name: "Bot permissions",
      value:
        permissions.length === 0 ? "(none)" : "```" + summarizePermissions(permissions) + "```",
    },
    { name: "Discord permissions", value: "```" + describeDiscordPermissions(role) + "```" },
  );

  await interaction.editReply({ embeds: [embed] });
}

/**
 * Refuses a power level the caller could not grant without escalating.
 *
 * `/roles` declares `server.settings`, which `bot-manager` holds — but holding a
 * bot permission must not turn role management into a ladder. A bot-manager is
 * usually *not* a Discord administrator; binding a role (possibly their own) to
 * `administrator` would hand out every bot permission the caller never had, and
 * `/roles` would then be the escalation path instead of the escalation fix.
 *
 * The invariant lives in `AuthorizationService.canGrantClass` (nobody may grant a
 * class containing a permission they do not already hold); this wrapper only
 * resolves the member and renders the refusal.
 *
 * @returns true when the caller may grant `classKey`, false after replying.
 */
async function mayGrantClass(
  interaction: ChatInputCommandInteraction,
  context: CommandExecutionContext,
  classKey: string,
): Promise<boolean> {
  const guild = interaction.guild;
  const member = guild?.members.cache.get(interaction.user.id) ?? null;
  if (!guild || !member) {
    await interaction.editReply({
      embeds: [errorEmbed("Power level", "Could not resolve your membership of this server.")],
    });
    return false;
  }

  if (await context.authorization.canGrantClass(member, classKey)) {
    return true;
  }

  await interaction.editReply({
    embeds: [
      errorEmbed(
        "Power level",
        `You cannot grant \`${classKey}\`: it includes permissions you do not hold yourself. ` +
          "Ask an administrator to bind this role.",
      ),
    ],
  });
  return false;
}

/** Binds or unbinds a role to a power level, reporting the resulting state. */
async function handleBinding(
  interaction: ChatInputCommandInteraction,
  context: CommandExecutionContext,
  mode: "bind" | "unbind",
): Promise<void> {
  const guild = interaction.guild;
  const classKey = interaction.options.getString("class", true);
  if (!guild) {
    return;
  }
  const role = await resolveRole(interaction);
  if (!role) {
    await interaction.editReply({
      embeds: [errorEmbed("Role", "That role could not be resolved — it may have been deleted.")],
    });
    return;
  }

  if (role.id === guild.id) {
    await interaction.editReply({
      embeds: [
        errorEmbed(
          "Power level",
          "`@everyone` is not a role you can bind — binding it would grant every member " +
            "of the server the class. Bind a real role instead.",
        ),
      ],
    });
    return;
  }

  if (bindableClass(classKey) === null) {
    const known = ALL_CLASSES.find((definition) => definition.key === classKey);
    await interaction.editReply({
      embeds: [
        errorEmbed(
          "Power level",
          known
            ? `\`${known.key}\` is the guild-owner class — it is granted by Discord itself (the server owner), never by a role binding.`
            : `Unknown power level \`${classKey}\`. Run \`/roles classes\` to see the available ones.`,
        ),
      ],
    });
    return;
  }

  if (mode === "bind") {
    if (!(await mayGrantClass(interaction, context, classKey))) {
      return;
    }
    await context.permissionClasses.bindRole(guild.id, role.id, classKey);
  } else {
    await context.permissionClasses.unbindRole(guild.id, role.id, classKey);
  }

  await recordRoleAudit(context, interaction, role.id, classKey, mode);

  const bound = await classesForRole(context, guild.id, role.id);
  await interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setTitle(mode === "bind" ? "Power level granted" : "Power level removed")
        .setDescription(
          [
            `**Role:** <@&${role.id}>`,
            `**Power level:** \`${classKey}\``,
            "",
            bound.length === 0
              ? "This role now holds no power levels."
              : `This role holds: ${bound.map((definition) => definition.name).join(", ")}`,
          ].join("\n"),
        ),
    ],
  });
}

/** Creates a role, optionally granting it a power level. */
async function handleCreate(
  interaction: ChatInputCommandInteraction,
  context: CommandExecutionContext,
): Promise<void> {
  const guild = interaction.guild;
  if (!guild) {
    return;
  }
  const name = interaction.options.getString("name", true).trim();
  const classKey = interaction.options.getString("class");
  const colorRaw = interaction.options.getString("color");
  const hoist = interaction.options.getBoolean("hoist") ?? false;
  const mentionable = interaction.options.getBoolean("mentionable") ?? false;

  if (classKey !== null && bindableClass(classKey) === null) {
    await interaction.editReply({
      embeds: [errorEmbed("Create role", `\`${classKey}\` is not a bindable power level.`)],
    });
    return;
  }
  if (classKey !== null && !(await mayGrantClass(interaction, context, classKey))) {
    return;
  }
  const color = colorRaw === null ? undefined : parseColor(colorRaw);

  let role: Role;
  try {
    role = await guild.roles.create({
      name,
      hoist,
      mentionable,
      ...(color === undefined ? {} : { color }),
      reason: `Role created by ${interaction.user.id} via /roles`,
    });
  } catch (error) {
    await interaction.editReply({
      embeds: [
        errorEmbed(
          "Create role",
          "Discord refused to create the role. The bot needs `Manage Roles`, and its own " +
            `highest role must sit above the new one.${error instanceof Error ? ` (${error.message})` : ""}`,
        ),
      ],
    });
    return;
  }

  if (classKey !== null) {
    await context.permissionClasses.bindRole(guild.id, role.id, classKey);
    await recordRoleAudit(context, interaction, role.id, classKey, "bind");
  }

  await interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setTitle("Role created")
        .setDescription(
          [
            `**Role:** <@&${role.id}>`,
            colorRaw === null ? null : `**Colour:** \`${colorRaw}\``,
            classKey === null ? null : `**Power level:** \`${classKey}\``,
          ]
            .filter((line): line is string => line !== null)
            .join("\n"),
        ),
    ],
  });
}

/** Deletes a role the bot can manage, clearing its bindings first. */
async function handleDelete(
  interaction: ChatInputCommandInteraction,
  context: CommandExecutionContext,
): Promise<void> {
  const guild = interaction.guild;
  if (!guild) {
    return;
  }
  const role = await resolveRole(interaction);
  if (!role) {
    await interaction.editReply({
      embeds: [errorEmbed("Role", "That role could not be resolved — it may have been deleted.")],
    });
    return;
  }

  if (role.id === guild.id || role.managed) {
    await interaction.editReply({
      embeds: [
        errorEmbed(
          "Delete role",
          role.id === guild.id
            ? "`@everyone` cannot be deleted."
            : "That role is managed by an integration, so the bot cannot delete it.",
        ),
      ],
    });
    return;
  }

  // Remove bindings first, so a later role re-created with the same name never inherits
  // the deleted role's power level by accident.
  const bound = await classesForRole(context, guild.id, role.id);
  for (const definition of bound) {
    await context.permissionClasses.unbindRole(guild.id, role.id, definition.key);
    await recordRoleAudit(context, interaction, role.id, definition.key, "unbind");
  }

  try {
    await role.delete(`Role deleted by ${interaction.user.id} via /roles`);
  } catch (error) {
    await interaction.editReply({
      embeds: [
        errorEmbed(
          "Delete role",
          "Discord refused to delete the role. It must sit below the bot's highest " +
            `role.${error instanceof Error ? ` (${error.message})` : ""}`,
        ),
      ],
    });
    return;
  }

  await interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setTitle("Role deleted")
        .setDescription(
          `Deleted **${role.name}**.` +
            (bound.length > 0 ? ` Removed ${bound.length} power level binding(s).` : ""),
        ),
    ],
  });
}

/** Records a power-level change in the audit trail. */
async function recordRoleAudit(
  context: CommandExecutionContext,
  interaction: ChatInputCommandInteraction,
  roleId: string,
  classKey: string,
  mode: "bind" | "unbind",
): Promise<void> {
  const god = hasGodAccess(interaction.user.id);
  if (god) {
    context.logger.warn("Role power level changed by the owner account", {
      guildId: interaction.guildId ?? "unknown",
      userId: interaction.user.id,
      roleId,
      classKey,
    });
  }
  await context.audit.record({
    guildId: interaction.guildId ?? "unknown",
    action: mode === "bind" ? "roles.class.bound" : "roles.class.unbound",
    category: "authorization",
    severity: "privileged",
    actorId: interaction.user.id,
    actorKind: god ? "god" : "user",
    targetType: "role",
    targetId: roleId,
    outcome: "success",
    details: { classKey, mode },
  });
}
