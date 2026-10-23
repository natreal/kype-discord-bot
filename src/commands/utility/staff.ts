/**
 * `/staff` — the server's staff roster, grouped by power level.
 *
 *   /staff list                              — every bound role, grouped by power level
 *   /staff config class class: [name:] [reset:]  — rename a power level
 *   /staff config role  label:  [name:] [reset:]  — rename one bound role
 *
 * The roster is not a second source of truth: it reads exactly what `/roles bind`
 * wrote, so a role appears the moment it is bound and disappears the moment it is
 * unbound. A server therefore never maintains two staff lists that can disagree.
 *
 * Grouping is by *power level*, not by Discord role position, because the power level
 * is what the bot actually honours. Two roles bound to `moderator` sit under one
 * heading, and the heading is what an operator renames — a factor that made
 * "Administrator" unreadable on a real server ("what does that mean here?") becomes
 * "Server Leads" once, everywhere.
 *
 * A consequence worth naming: a role's own Discord name is never used as a heading.
 * A heading is always a power-level name unless someone deliberately relabelled it,
 * which keeps the roster readable as a hierarchy instead of a list of Discord roles in
 * an arbitrary order.
 */
import {
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";

import { defineSlashCommand } from "../define.js";
import type { CommandExecutionContext } from "../context.js";
import { brandedEmbed, errorEmbed, readRename, type RenameInput } from "../../utils/presenters.js";
import { hasGodAccess } from "../../services/authorization/index.js";
import {
  classLabel,
  type Permission,
  type PermissionClassDefinition,
  type RoleClassBinding,
} from "../../services/authorization/index.js";

/** A server's roster can be large; cap it to stay well inside embed limits. */
const MAX_ROLES_SHOWN = 45;

/**
 * Reading the roster is a management surface, not a public one: it reveals which roles
 * hold which bot powers, which is reconnaissance for anyone deciding what to attack.
 */
const READ_REQUIREMENT = {
  discord: [PermissionFlagsBits.ManageGuild],
  custom: ["server.settings"] as readonly Permission[],
};

/** One power level heading plus the roles filed under it. */
interface StaffGroup {
  readonly definition: PermissionClassDefinition;
  readonly roles: { readonly roleId: string; readonly label: string | null }[];
}

export default defineSlashCommand({
  meta: {
    name: "staff",
    description: "Show the server's staff roster, grouped by power level.",
    category: "utility",
    usage: "/staff list|config",
    examples: [
      "/staff list",
      "/staff config class class:administrator name:Server Leads",
      "/staff config role label:@Admin name:Leads",
      "/staff config class class:administrator reset:true",
    ],
  },
  permissions: READ_REQUIREMENT,
  data: new SlashCommandBuilder()
    .setName("staff")
    .setDescription("Show the server's staff roster, grouped by power level.")
    .addSubcommand((sub) =>
      sub.setName("list").setDescription("List every staff role, grouped by power level."),
    )
    .addSubcommandGroup((group) =>
      group
        .setName("config")
        .setDescription("Rename how staff roles and power levels appear.")
        .addSubcommand((sub) =>
          sub
            .setName("class")
            .setDescription("Rename a power level's heading for the whole server.")
            .addStringOption((option) =>
              option
                .setName("class")
                .setDescription("The power level to rename.")
                .setRequired(true)
                .setAutocomplete(true),
            )
            .addStringOption((option) =>
              option.setName("name").setDescription("The new heading.").setMaxLength(64),
            )
            .addBooleanOption((option) =>
              option.setName("reset").setDescription("Restore the default heading instead."),
            ),
        )
        .addSubcommand((sub) =>
          sub
            .setName("role")
            .setDescription("Rename one bound role inside its power level.")
            .addRoleOption((option) =>
              option.setName("label").setDescription("The bound role to rename.").setRequired(true),
            )
            .addStringOption((option) =>
              option.setName("name").setDescription("The new name.").setMaxLength(64),
            )
            .addBooleanOption((option) =>
              option.setName("reset").setDescription("Restore the role's own name instead."),
            ),
        ),
    ),

  autocomplete: async (interaction, context) => {
    const focused = interaction.options.getFocused(true);
    if (focused.name !== "class" || !interaction.guild) {
      await interaction.respond([]);
      return;
    }
    const query = focused.value.trim().toLowerCase();
    const classes = await context.permissionClasses.list(interaction.guild.id);
    await interaction.respond(
      classes
        .filter(
          (definition) =>
            query.length === 0 ||
            definition.key.includes(query) ||
            classLabel(definition).toLowerCase().includes(query),
        )
        .slice(0, 25)
        .map((definition) => ({
          name: `${classLabel(definition)} — ${definition.key}`,
          value: definition.key,
        })),
    );
  },

  execute: async (interaction, context) => {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    if (!interaction.guild) {
      await interaction.editReply({
        embeds: [errorEmbed("Staff", "This command only works inside a server.")],
      });
      return;
    }

    if (interaction.options.getSubcommandGroup(false) === "config") {
      await handleConfig(interaction, context);
      return;
    }
    await replyWithRoster(interaction, context);
  },
});

/** Replies with the roster: one embed field per power level that has bound roles. */
async function replyWithRoster(
  interaction: ChatInputCommandInteraction,
  context: CommandExecutionContext,
): Promise<void> {
  const guild = interaction.guild;
  if (!guild) {
    return;
  }

  // Both reads are needed together, and the roster is a single reply: fetching in
  // parallel keeps a large server's `/staff` to one round trip.
  const [classes, bindings] = await Promise.all([
    context.permissionClasses.list(guild.id),
    context.permissionClasses.listBindings(guild.id),
  ]);

  const groups = groupByClass(classes, bindings);
  if (groups.length === 0) {
    await interaction.editReply({
      embeds: [
        errorEmbed(
          "Staff",
          "No role holds a power level yet. Bind one with `/roles bind` — it will appear " +
            "here immediately.",
        ),
      ],
    });
    return;
  }

  const embed = brandedEmbed(`Staff — ${guild.name}`);
  let shown = 0;
  let total = 0;
  let hidden = 0;

  for (const staffGroup of groups) {
    total += staffGroup.roles.length;
    const visible = staffGroup.roles.slice(0, Math.max(0, MAX_ROLES_SHOWN - shown));
    shown += visible.length;
    hidden += staffGroup.roles.length - visible.length;
    if (visible.length === 0) {
      continue;
    }

    const lines = visible.map((entry) => {
      const memberCount = guild.roles.cache.get(entry.roleId)?.members.size;
      const name =
        entry.label === null ? `<@&${entry.roleId}>` : `**${entry.label}** — <@&${entry.roleId}>`;
      return memberCount === undefined ? name : `${name} · ${memberCount} member(s)`;
    });

    embed.addFields({
      // `classLabel` applies a server-wide rename, so a heading renamed under
      // `/staff config class` is honoured here.
      name: `${classLabel(staffGroup.definition)} — ${visible.length} role(s)`,
      value: lines.join("\n"),
    });
  }

  embed.setFooter({
    text:
      hidden > 0
        ? `${total} staff role(s) · showing ${shown} — ${hidden} more are not shown`
        : `${total} staff role(s) across ${groups.length} power level(s)`,
  });

  await interaction.editReply({ embeds: [embed] });
}

/**
 * @returns the bindings grouped per power level, highest priority first.
 *
 * Presentation lives entirely in `classLabel`, so a server-wide rename and a per-role
 * label are resolved in one place. A binding whose class no longer exists is skipped
 * rather than shown under its raw key: the class is gone, so the role grants nothing
 * here and listing it would imply a power level it does not hold.
 */
function groupByClass(
  classes: readonly PermissionClassDefinition[],
  bindings: readonly RoleClassBinding[],
): StaffGroup[] {
  const byKey = new Map(classes.map((definition) => [definition.key, definition]));
  const labelByRole = new Map<string, string | null>();
  const rolesByKey = new Map<string, Set<string>>();

  for (const binding of bindings) {
    if (!byKey.has(binding.classKey)) {
      continue;
    }
    // One label per role: a role bound to several classes keeps its own name in each
    // group instead of showing a different label per heading.
    if (!labelByRole.has(binding.roleId)) {
      labelByRole.set(binding.roleId, binding.label);
    }
    const roles = rolesByKey.get(binding.classKey) ?? new Set<string>();
    roles.add(binding.roleId);
    rolesByKey.set(binding.classKey, roles);
  }

  return [...rolesByKey.entries()]
    .map(([classKey, roleIds]) => {
      const definition = byKey.get(classKey);
      if (!definition) {
        return null;
      }
      return {
        definition,
        roles: [...roleIds]
          .map((roleId) => ({ roleId, label: labelByRole.get(roleId) ?? null }))
          .sort((left, right) => left.roleId.localeCompare(right.roleId)),
      };
    })
    .filter((group): group is StaffGroup => group !== null)
    .sort((left, right) => right.definition.priority - left.definition.priority);
}

/**
 * Routes `/staff config class` and `/staff config role`.
 *
 * Renames are presentation only, so they are audited but never require the ability to
 * grant a power level (`canGrantClass`): the operator cannot escalate anything by
 * relabelling a heading they can already read.
 */
async function handleConfig(
  interaction: ChatInputCommandInteraction,
  context: CommandExecutionContext,
): Promise<void> {
  const subcommand = interaction.options.getSubcommand();
  if (subcommand === "class") {
    await renameClass(interaction, context);
    return;
  }
  if (subcommand === "role") {
    await renameRole(interaction, context);
    return;
  }
  await interaction.editReply({
    embeds: [errorEmbed("Staff", `Unknown option \`${subcommand}\`.`)],
  });
}

/**
 * @returns the rename requested by the current `/staff config` invocation.
 *
 * Thin adapter over the shared `readRename`: this command spells the two options
 * `name` / `reset`, and the validation rules live in one place so `/roles` and `/staff`
 * cannot drift apart on what a valid name is.
 */
function renameFrom(interaction: ChatInputCommandInteraction): RenameInput {
  return readRename(
    interaction.options.getString("name"),
    interaction.options.getBoolean("reset") ?? false,
  );
}

/** Renames (or resets) a power level's heading. */
async function renameClass(
  interaction: ChatInputCommandInteraction,
  context: CommandExecutionContext,
): Promise<void> {
  const guild = interaction.guild;
  const classKey = interaction.options.getString("class", true);
  if (!guild) {
    return;
  }

  const classes = await context.permissionClasses.list(guild.id);
  const definition = classes.find((entry) => entry.key === classKey) ?? null;
  if (!definition) {
    await interaction.editReply({
      embeds: [
        errorEmbed(
          "Staff",
          `Unknown power level \`${classKey}\`. Run \`/roles classes\` to see the available ones.`,
        ),
      ],
    });
    return;
  }

  const rename = renameFrom(interaction);
  if ("error" in rename) {
    await interaction.editReply({ embeds: [errorEmbed("Staff", rename.error)] });
    return;
  }

  await context.permissionClasses.setClassDisplayName(guild.id, definition.key, rename.name);
  await recordRename(context, interaction, {
    action: "staff.class.renamed",
    targetType: "permission-class",
    targetId: definition.key,
    details: { classKey: definition.key, name: rename.name, previous: definition.displayName },
  });

  await interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setTitle(rename.name === null ? "Heading restored" : "Heading renamed")
        .setDescription(
          [
            `**Power level:** \`${definition.key}\``,
            `**Heading:** ${classLabel({ ...definition, displayName: rename.name ?? undefined })}`,
            "",
            "Permissions are unchanged — this only changes the heading `/staff` shows.",
          ].join("\n"),
        ),
    ],
  });
}

/** Renames (or resets) one bound role's label. */
async function renameRole(
  interaction: ChatInputCommandInteraction,
  context: CommandExecutionContext,
): Promise<void> {
  const guild = interaction.guild;
  const roleId = interaction.options.getRole("label", true).id;
  if (!guild) {
    return;
  }

  const rename = renameFrom(interaction);
  if ("error" in rename) {
    await interaction.editReply({ embeds: [errorEmbed("Staff", rename.error)] });
    return;
  }

  const bound = (await context.permissionClasses.listBindings(guild.id)).filter(
    (binding) => binding.roleId === roleId,
  );
  if (bound.length === 0) {
    await interaction.editReply({
      embeds: [
        errorEmbed(
          "Staff",
          `<@&${roleId}> holds no power level, so it does not appear under \`/staff\`. ` +
            "Bind it first with `/roles bind`.",
        ),
      ],
    });
    return;
  }

  await context.permissionClasses.setBindingLabel(guild.id, roleId, rename.name);
  await recordRename(context, interaction, {
    action: "staff.role.renamed",
    targetType: "role",
    targetId: roleId,
    details: {
      classKeys: bound.map((binding) => binding.classKey),
      name: rename.name,
      previous: bound[0]?.label ?? null,
    },
  });

  const headings = await headingsFor(
    context,
    guild.id,
    bound.map((binding) => binding.classKey),
  );
  await interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setTitle(rename.name === null ? "Role name restored" : "Role renamed")
        .setDescription(
          [
            `**Role:** <@&${roleId}>`,
            `**Shown as:** ${rename.name ?? "its own Discord name"}`,
            `**Under power level(s):** ${headings.join(", ")}`,
          ].join("\n"),
        ),
    ],
  });
}

/** @returns the display headings for a set of class keys, in the order given. */
async function headingsFor(
  context: CommandExecutionContext,
  guildId: string,
  classKeys: readonly string[],
): Promise<string[]> {
  const classes = await context.permissionClasses.list(guildId);
  const byKey = new Map(classes.map((definition) => [definition.key, definition]));
  return classKeys.map((key) => {
    const definition = byKey.get(key);
    return definition ? classLabel(definition) : key;
  });
}

/** Records a rename in the audit trail: a label change is still a config change. */
async function recordRename(
  context: CommandExecutionContext,
  interaction: ChatInputCommandInteraction,
  entry: {
    readonly action: string;
    readonly targetType: string;
    readonly targetId: string;
    readonly details: Record<string, unknown>;
  },
): Promise<void> {
  const god = hasGodAccess(interaction.user.id);
  await context.audit.record({
    guildId: interaction.guildId ?? "unknown",
    action: entry.action,
    category: "authorization",
    severity: "privileged",
    actorId: interaction.user.id,
    actorKind: god ? "god" : "user",
    targetType: entry.targetType,
    targetId: entry.targetId,
    outcome: "success",
    details: entry.details,
  });
}
