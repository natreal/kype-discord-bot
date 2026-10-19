/**
 * `/help` — command discovery driven help.
 *
 * Categories and entries are derived from the command registry, so the output can
 * never become stale. It is also the living proof that nested command discovery
 * works.
 */
import {
  ApplicationCommandOptionType,
  EmbedBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";

import { defineSlashCommand } from "../define.js";
import { COMMAND_CATEGORIES } from "../../config/constants.js";

export default defineSlashCommand({
  meta: {
    name: "help",
    description: "List the available commands, grouped by category.",
    category: "utility",
    usage: "/help [command:<name>]",
    examples: ["/help", "/help command:warn"],
  },
  botPermissions: ["core.use"],
  data: new SlashCommandBuilder()
    .setName("help")
    .setDescription("List the available commands, grouped by category.")
    .addStringOption((option) =>
      option
        .setName("command")
        .setDescription("Show the subcommands and options of one command.")
        .setAutocomplete(true),
    ),
  autocomplete: async (interaction, context) => {
    const focused = interaction.options.getFocused().toLowerCase();
    const matches = context.commands
      .list()
      .filter((command) => command.kind === "slash")
      .filter((command) => command.name.toLowerCase().includes(focused))
      .slice(0, 25)
      .map((command) => ({ name: `/${command.name}`, value: command.name }));
    await interaction.respond(matches);
  },
  execute: async (interaction, context) => {
    const { commands } = context;
    const requested = interaction.options.getString("command");

    // A named command gets its own detail card: subcommands, options and examples.
    // This is what the flat listing cannot show, and the reason `/help warn` used
    // to look identical to `/help`.
    if (requested) {
      const command = commands
        .list()
        .find((candidate) => candidate.kind === "slash" && candidate.name === requested);
      if (!command) {
        await interaction.reply({
          content: `No command named \`/${requested}\`. Try \`/help\` for the full list.`,
          ephemeral: true,
        });
        return;
      }

      const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle(`/${command.name}`)
        .setDescription(command.description)
        .setTimestamp();

      if (command.usage) {
        embed.addFields({ name: "Usage", value: `\`${command.usage}\`` });
      }

      const groups = describeOptions(command);
      if (groups.length > 0) {
        embed.addFields({ name: "Subcommands & options", value: groups.join("\n") });
      }

      const examples = (command as { examples?: readonly string[] }).examples ?? [];
      if (examples.length > 0) {
        embed.addFields({
          name: "Examples",
          value: examples.map((example) => `\`${example}\``).join("\n"),
        });
      }

      const required = describePermissions(command);
      if (required.length > 0) {
        embed.addFields({ name: "Required permissions", value: required.join("\n") });
      }

      embed.setFooter({ text: `Category: ${command.category}` });
      await interaction.reply({ embeds: [embed], ephemeral: true });
      return;
    }

    const grouped = new Map<string, string[]>();

    for (const command of commands.list()) {
      if (command.kind !== "slash") {
        continue;
      }
      const entries = grouped.get(command.category) ?? [];
      // Subcommand names are shown inline so the overview says what a command
      // *can* do without a second round trip: `/ticket list` beats `/ticket`.
      const subs = describeSubcommands(command);
      const suffix = subs.length > 0 ? ` \`${subs.join("|")}\`` : "";
      entries.push(`**/${command.name}**${suffix} — ${command.description}`);
      grouped.set(command.category, entries);
    }

    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle("Command reference")
      .setDescription(
        `The bot currently exposes ${commands.size} command(s).\n` +
          "Use `/help command:<name>` for subcommands, options and examples.",
      )
      .setTimestamp();

    for (const category of COMMAND_CATEGORIES) {
      const entries = grouped.get(category);
      if (entries && entries.length > 0) {
        embed.addFields({ name: capitalize(category), value: entries.sort().join("\n") });
      }
    }

    await interaction.reply({ embeds: [embed], ephemeral: true });
  },
});

/** @returns the subcommand names of a command, in declaration order. */
function describeSubcommands(command: { data: unknown }): string[] {
  return optionsOf(command)
    .filter((option) => option.type === ApplicationCommandOptionType.Subcommand)
    .map((option) => option.name);
}

/**
 * @returns human lines describing one command's subcommands and options.
 *
 * Recurses one level into subcommand groups, which is the deepest shape Discord
 * allows and the shape `/settings`, `/ticket` and `/security` already use.
 */
function describeOptions(command: { data: unknown }): string[] {
  const lines: string[] = [];
  for (const option of optionsOf(command)) {
    if (option.type === ApplicationCommandOptionType.Subcommand) {
      lines.push(withOptions(`\`${option.name}\``, option.description, option.options));
      continue;
    }
    if (option.type === ApplicationCommandOptionType.SubcommandGroup) {
      for (const nested of option.options ?? []) {
        lines.push(
          withOptions(`\`${option.name} ${nested.name}\``, nested.description, nested.options),
        );
      }
    }
  }
  return lines;
}

/** @returns one detail line, with its nested options appended when it has any. */
function withOptions(
  label: string,
  description: string,
  options: readonly BuiltOption[] | undefined,
): string {
  const rendered = (options ?? [])
    .map((option) => formatOption(option))
    .filter((entry) => entry.length > 0)
    .join(" ");
  return `${label} — ${description}${rendered ? `\n  ↳ ${rendered}` : ""}`;
}

/** @returns the raw option array of a command's builder, or an empty array. */
function optionsOf(command: { data: unknown }): readonly BuiltOption[] {
  const data = command.data as { options?: readonly BuiltOption[] } | undefined;
  return data?.options ?? [];
}

/** The subset of a built option this module reads. */
interface BuiltOption {
  readonly name: string;
  readonly description: string;
  readonly type: ApplicationCommandOptionType;
  readonly required?: boolean;
  readonly options?: readonly BuiltOption[];
}

/** @returns a readable `name:type` fragment, marked optional when it is. */
function formatOption(option: BuiltOption): string {
  if (
    option.type === ApplicationCommandOptionType.Subcommand ||
    option.type === ApplicationCommandOptionType.SubcommandGroup
  ) {
    return option.name;
  }
  return `${option.name}:${optionTypeName(option.type)}${option.required === true ? "" : "?"}`;
}

/** @returns the option type as a short, user-readable word. */
function optionTypeName(type: ApplicationCommandOptionType): string {
  switch (type) {
    case ApplicationCommandOptionType.String:
      return "text";
    case ApplicationCommandOptionType.Integer:
      return "number";
    case ApplicationCommandOptionType.Boolean:
      return "true|false";
    case ApplicationCommandOptionType.User:
      return "member";
    case ApplicationCommandOptionType.Channel:
      return "channel";
    case ApplicationCommandOptionType.Role:
      return "role";
    case ApplicationCommandOptionType.Mentionable:
      return "mention";
    case ApplicationCommandOptionType.Number:
      return "decimal";
    case ApplicationCommandOptionType.Attachment:
      return "file";
    default:
      return "value";
  }
}

/** @returns human lines naming the permissions a command demands. */
function describePermissions(command: { permissions?: unknown }): string[] {
  const permissions = command.permissions as
    | { discord?: readonly bigint[]; custom?: readonly string[] }
    | undefined;
  if (!permissions) {
    return [];
  }
  const lines: string[] = [];
  for (const custom of permissions.custom ?? []) {
    lines.push(`• \`${custom}\``);
  }
  for (const required of permissions.discord ?? []) {
    lines.push(`• Discord: \`${permissionName(required)}\``);
  }
  return lines;
}

/** @returns a readable name for a Discord permission bit. */
function permissionName(bit: bigint): string {
  for (const [name, value] of Object.entries(PermissionFlagsBits)) {
    if (value === bit) {
      return name.replace(/([a-z])([A-Z])/g, "$1 $2");
    }
  }
  return String(bit);
}

function capitalize(value: string): string {
  return value.length === 0 ? value : `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}`;
}
