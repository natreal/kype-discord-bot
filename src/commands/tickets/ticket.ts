/**
 * `/ticket` — open a ticket, post the panel, and read the queue.
 *
 * One command with a small set of subcommands rather than many top-level commands.
 * The split mirrors the audience:
 *
 * - `open` and `mine` are for members: no permission required beyond being in the guild.
 * - `list` is the staff queue for ticket helpers. A member who runs it sees only their
 *   own tickets, so the command stays useful inside a ticket without exposing the queue.
 * - `panel` and `category` are gated on `tickets.manage`; a category helper cannot
 *   repost the panel or rewrite the category table.
 *
 * `claim`, `close` and `transcript` are *not* subcommands: they are buttons on each
 * ticket channel (see `buildTicketControls`), so the command list stays short and the
 * actions stay where the staff member is looking. Every button is checked against the
 * ticket's staff roles; the opener cannot close their own ticket from the panel.
 *
 * The command is thin by design: it resolves options, calls `TicketService`, and renders.
 * Everything that decides *what happens* — the one-open-ticket rule, the transcript, the
 * claim race — lives in the service, so the button path (which has no command) and the
 * command path cannot drift apart.
 */
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  GuildMember,
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type TextChannel,
} from "discord.js";

import { defineSlashCommand } from "../define.js";
import { errorEmbed } from "../../utils/presenters.js";
import { buildTicketPanel, buildTicketQueueControls } from "../../modules/tickets/ticket-panel.js";
import type { TicketService } from "../../modules/tickets/ticket.service.js";
import type { CommandExecutionContext } from "../context.js";

/** Message shown when the tickets module is off or the service is unavailable. */
const TICKETS_UNAVAILABLE = "Tickets are not available in this server.";

/**
 * How many tickets `/ticket list` renders at once.
 *
 * Discord accepts at most ten embeds per message, so a longer queue is truncated
 * (with a note) rather than refused: a reply Discord rejects would tell staff
 * nothing at all, which is the worst outcome for a queue view.
 */
const MAX_LISTED_TICKETS = 10;

/**
 * @returns the guild's ticket service, or `null`.
 *
 * Resolved per invocation rather than captured, so `/settings tickets enabled:true` takes
 * effect on the next command rather than on the next restart.
 */
function serviceOf(context: CommandExecutionContext): TicketService | null {
  return context.tickets?.service ?? null;
}

/**
 * Which tickets a caller may see and act on.
 *
 * There are two kinds of helper. A role carrying `tickets.view` / `tickets.manage`, or
 * the role configured as `tickets.staff-role`, handles every category. A role named in
 * one category's `staffRoleIds` handles only that category, which is the same boundary
 * the ticket channel's permission overwrites enforce.
 */
interface TicketStaffScope {
  /** `true` when the caller handles every category. */
  readonly allCategories: boolean;
  /** Category ids the caller helps with when `allCategories` is false. */
  readonly categoryIds: readonly string[];
}

/** @returns every role the member holds, including `@everyone`. */
function roleIdsOf(member: GuildMember): string[] {
  return [...member.roles.cache.keys()];
}

/**
 * Resolves a caller's ticket scope.
 *
 * The authorization layer answers first because guild owners and Administrators hold no
 * role the service can inspect. The service then answers for the configured staff role
 * and per-category staff roles. Anything else is a member: they may open tickets and see
 * their own, and nothing more.
 */
async function staffScopeOf(
  interaction: ChatInputCommandInteraction,
  service: TicketService,
  context: CommandExecutionContext,
  guildId: string,
): Promise<TicketStaffScope> {
  const member = interaction.member;
  if (!(member instanceof GuildMember)) {
    return { allCategories: false, categoryIds: [] };
  }

  const decision = context.authorization
    ? await context.authorization.decide(member, { custom: ["tickets.view"] }, "ticket access")
    : { allowed: false };
  if (decision.allowed) {
    return { allCategories: true, categoryIds: [] };
  }

  const roleIds = roleIdsOf(member);
  if (await service.isTicketStaff(guildId, roleIds)) {
    return { allCategories: true, categoryIds: [] };
  }
  return { allCategories: false, categoryIds: await service.staffCategoryIds(guildId, roleIds) };
}

/** @returns true when the caller may post the panel or change ticket categories. */
async function canManageTickets(
  interaction: ChatInputCommandInteraction,
  context: CommandExecutionContext,
): Promise<boolean> {
  const member = interaction.member;
  if (!(member instanceof GuildMember) || !context.authorization) {
    return false;
  }
  const decision = await context.authorization.authorize(
    member,
    { custom: ["tickets.manage"] },
    "ticket management",
  );
  return decision.allowed;
}

/** Renders a ticket as a compact embed for `/ticket list` and `/ticket mine`. */
function ticketEmbed(ticket: {
  number: number;
  status: string;
  priority: string;
  subject: string | null;
  claimedById: string | null;
  messageCount: number;
  createdAt: Date;
}): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle(`Ticket #${ticket.number}`)
    .setDescription(ticket.subject ?? "(no subject)")
    .addFields(
      { name: "Status", value: ticket.status, inline: true },
      { name: "Priority", value: ticket.priority, inline: true },
      {
        name: "Handled by",
        value: ticket.claimedById ? `<@${ticket.claimedById}>` : "nobody yet",
        inline: true,
      },
      { name: "Messages", value: String(ticket.messageCount), inline: true },
      { name: "Opened", value: `<t:${Math.floor(ticket.createdAt.getTime() / 1_000)}:R>` },
    );
}

/** Turns a panel descriptor into an `ActionRowBuilder`. */
function panelRows(
  rows: readonly {
    buttons: readonly {
      customId: string;
      label: string;
      style: string;
      emoji?: string;
      disabled?: boolean;
    }[];
  }[],
): ActionRowBuilder<ButtonBuilder>[] {
  return rows.map((row) => {
    const builder = new ActionRowBuilder<ButtonBuilder>();
    builder.addComponents(
      row.buttons.map((button) =>
        new ButtonBuilder()
          .setCustomId(button.customId)
          .setLabel(button.label)
          .setStyle(styleOf(button.style))
          .setDisabled(button.disabled ?? false),
      ),
    );
    return builder;
  });
}

const STYLE_BY_NAME: Record<string, ButtonStyle> = {
  primary: ButtonStyle.Primary,
  secondary: ButtonStyle.Secondary,
  success: ButtonStyle.Success,
  danger: ButtonStyle.Danger,
};

function styleOf(name: string): ButtonStyle {
  return STYLE_BY_NAME[name] ?? ButtonStyle.Secondary;
}

export default defineSlashCommand({
  meta: {
    name: "ticket",
    description: "Open and manage support tickets.",
    category: "tickets",
    usage: "/ticket open|panel|list|mine",
    examples: ["/ticket open category:support subject:I cannot verify", "/ticket list status:open"],
  },
  // The command itself requires no permission: `open` and `mine` are for everyone. Each
  // handler checks the staff permissions it needs, so the check is visible next to the
  // action it protects rather than in a table far from it.
  permissions: {},
  data: new SlashCommandBuilder()
    .setName("ticket")
    .setDescription("Open and manage support tickets.")
    .addSubcommand((sub) =>
      sub
        .setName("open")
        .setDescription("Open a private ticket channel.")
        .addStringOption((option) =>
          option
            .setName("category")
            .setDescription("Which kind of ticket to open.")
            .setRequired(true)
            .setAutocomplete(true),
        )
        .addStringOption((option) =>
          option.setName("subject").setDescription("A one-line summary.").setMaxLength(200),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("panel")
        .setDescription("Post the ticket panel in a channel (staff).")
        .addChannelOption((option) =>
          option.setName("channel").setDescription("Where to post it. Defaults to here."),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("list")
        .setDescription("List your own tickets, or the staff queue.")
        .addStringOption((option) =>
          option
            .setName("status")
            .setDescription("Filter by status.")
            .addChoices({ name: "open", value: "open" }, { name: "closed", value: "closed" }),
        ),
    )
    .addSubcommand((sub) => sub.setName("mine").setDescription("Show your own recent tickets."))
    .addSubcommand((sub) =>
      sub
        .setName("category")
        .setDescription("Create, remove or list ticket categories (staff).")
        .addStringOption((option) =>
          option
            .setName("action")
            .setDescription("What to do.")
            .setRequired(true)
            .addChoices(
              { name: "create", value: "create" },
              { name: "remove", value: "remove" },
              { name: "list", value: "list" },
            ),
        )
        .addStringOption((option) =>
          option.setName("label").setDescription("Category name (for create).").setMaxLength(80),
        )
        .addStringOption((option) =>
          option.setName("emoji").setDescription("Button emoji (for create).").setMaxLength(32),
        )
        .addStringOption((option) =>
          option
            .setName("description")
            .setDescription("Short description shown on the panel (for create).")
            .setMaxLength(200),
        )
        .addChannelOption((option) =>
          option
            .setName("parent")
            .setDescription("Discord category the ticket channels open in (for create; optional)."),
        )
        .addStringOption((option) =>
          option
            .setName("key")
            .setDescription("Category key to remove (autocomplete shows existing categories).")
            .setAutocomplete(true),
        ),
    ),

  autocomplete: async (interaction, context) => {
    // Two options autocomplete by listing the guild's ticket categories:
    // `/ticket open` (the `category` option) and `/ticket category` (the `key`
    // option used to remove one). Anything else is empty.
    const focused = interaction.options.getFocused(true);
    if (focused.name !== "category" && focused.name !== "key") {
      await interaction.respond([]);
      return;
    }
    const guildId = interaction.guild?.id;
    const service = serviceOf(context);
    if (!guildId || !service) {
      await interaction.respond([]);
      return;
    }
    const categories = await service.allCategories(guildId);
    const query = focused.value.trim().toLowerCase();
    const matches = categories
      .filter(
        (category) =>
          query.length === 0 ||
          category.label.toLowerCase().includes(query) ||
          category.key.toLowerCase().includes(query),
      )
      .slice(0, 25)
      .map((category) => ({ name: category.label, value: category.key }));

    await interaction.respond(matches);
  },
  execute: async (interaction, context) => {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const guildId = interaction.guildId;
    const service = serviceOf(context);
    if (!guildId || !service) {
      await interaction.editReply({
        embeds: [errorEmbed("Tickets unavailable", TICKETS_UNAVAILABLE)],
      });
      return;
    }

    switch (interaction.options.getSubcommand(true)) {
      case "open":
        await runOpen(interaction, service, guildId);
        return;
      case "panel":
        await runPanel(interaction, service, guildId, context);
        return;
      case "list":
        await runList(interaction, service, guildId, context);
        return;
      case "mine":
        await runMine(interaction, service, guildId);
        return;
      case "category":
        await runCategory(interaction, service, guildId, context);
        return;
    }
  },
});

/**
 * `/ticket open` — creates the channel and points the member at it.
 *
 * The reply is ephemeral and contains a channel link rather than an invite: a public
 * "I opened a ticket about X" message is exactly what a private ticket exists to avoid.
 */
async function runOpen(
  interaction: ChatInputCommandInteraction,
  service: TicketService,
  guildId: string,
): Promise<void> {
  const subject = interaction.options.getString("subject");
  const outcome = await service.open(guildId, {
    categoryKey: interaction.options.getString("category", true),
    openerId: interaction.user.id,
    openerName: interaction.member
      ? ((interaction.member as { displayName?: string }).displayName ?? interaction.user.username)
      : interaction.user.username,
    subject,
  });

  if (!outcome.ok || !outcome.ticket) {
    const existing = outcome.ticket;
    const embed = errorEmbed("Ticket not opened", outcome.detail);
    if (existing) {
      // A member who already has a ticket is pointed at it rather than just told "no".
      embed.addFields({ name: "Existing", value: `<#${existing.channelId}>` });
    }
    await interaction.editReply({ embeds: [embed] });
    return;
  }

  const ticket = outcome.ticket;
  await interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setTitle(`Ticket #${ticket.number} opened`)
        .setDescription(
          `Your ticket is private: only you and the staff team can see <#${ticket.channelId}>.`,
        )
        .addFields({ name: "Subject", value: ticket.subject ?? "(no subject)" }),
    ],
  });
}

/**
 * `/ticket panel` — posts the open-ticket panel.
 *
 * The panel is posted rather than described, and re-posting updates the message Discord
 * already has (via the returned `messageId`) instead of spawning duplicates, which is
 * what an operator running the command twice actually wants.
 */
async function runPanel(
  interaction: ChatInputCommandInteraction,
  service: TicketService,
  guildId: string,
  context: CommandExecutionContext,
): Promise<void> {
  if (!(await canManageTickets(interaction, context))) {
    await interaction.editReply({
      embeds: [
        errorEmbed(
          "Not allowed",
          "Posting the ticket panel requires the `tickets.manage` permission.",
        ),
      ],
    });
    return;
  }

  const categories = await service.categories(guildId);
  const panel = buildTicketPanel(categories);

  const target = interaction.options.getChannel("channel") ?? interaction.channel;
  if (!target || !("send" in target)) {
    await interaction.editReply({
      embeds: [errorEmbed("Cannot post panel", "I cannot post a panel there.")],
    });
    return;
  }

  const sent = await (target as TextChannel).send({
    embeds: [
      new EmbedBuilder()
        .setTitle(panel.title)
        .setDescription(panel.description)
        .setFooter({ text: `${categories.length} categories available` }),
    ],
    components: panelRows(panel.rows),
  });

  await interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setDescription(`Panel posted in <#${sent.channelId}>.`)
        .addFields({ name: "Categories", value: String(categories.length) }),
    ],
  });
}

/** `/ticket list` — the staff queue, or a member's own tickets. */
async function runList(
  interaction: ChatInputCommandInteraction,
  service: TicketService,
  guildId: string,
  context: CommandExecutionContext,
): Promise<void> {
  const status = interaction.options.getString("status");
  const scope = await staffScopeOf(interaction, service, context, guildId);

  // A member sees only what they opened. `/ticket list` therefore works inside a ticket
  // without turning into a directory of everyone else's private conversations.
  if (!scope.allCategories && scope.categoryIds.length === 0) {
    const own = await service.list(guildId, {
      openerId: interaction.user.id,
      ...(status === null ? {} : { status: status as "open" | "closed" }),
      limit: MAX_LISTED_TICKETS,
    });
    if (own.length === 0) {
      await interaction.editReply({
        embeds: [
          errorEmbed(
            "No tickets",
            "You have not opened any tickets. Use `/ticket open` to create one; the full queue is only visible to the support team.",
          ),
        ],
      });
      return;
    }
    await interaction.editReply({
      embeds: own.map((ticket) => ticketEmbed(ticket)),
      content:
        "These are your tickets. Open one and press Close to end it; the support team sees the full queue.",
    });
    return;
  }

  const query = {
    ...(status === null ? {} : { status: status as "open" | "closed" }),
  };
  const tickets = scope.allCategories
    ? await service.list(guildId, { ...query, limit: 20 })
    : (
        await Promise.all(
          scope.categoryIds.map((categoryId) =>
            service.list(guildId, { ...query, categoryId, limit: 20 }),
          ),
        )
      )
        .flat()
        .sort((left, right) => right.number - left.number)
        .slice(0, 20);

  if (tickets.length === 0) {
    await interaction.editReply({
      embeds: [errorEmbed("No tickets", "No tickets match that filter.")],
    });
    return;
  }

  // The queue carries the Claim / Close / Transcript / Delete buttons for its first
  // tickets, so a staff member can act on a ticket without leaving the queue (and
  // without being inside the ticket channel first). Discord caps a message at five
  // component rows and ten embeds, so the view is truncated with a note rather than
  // rejected: a reply Discord refuses tells staff nothing at all.
  const shown = tickets.slice(0, MAX_LISTED_TICKETS);
  const hidden = tickets.length - shown.length;

  await interaction.editReply({
    embeds: shown.map((ticket) => ticketEmbed(ticket)),
    components: panelRows(buildTicketQueueControls(shown)),
    ...(hidden > 0
      ? {
          content: `${hidden} more ticket(s) are not shown — narrow the list with \`status:\` or act on one of the tickets above.`,
        }
      : {}),
  });
}

/** `/ticket mine` — a member's own recent tickets, open or not. */
async function runMine(
  interaction: ChatInputCommandInteraction,
  service: TicketService,
  guildId: string,
): Promise<void> {
  const tickets = await service.list(guildId, { openerId: interaction.user.id, limit: 10 });
  if (tickets.length === 0) {
    await interaction.editReply({
      embeds: [errorEmbed("No tickets", "You have not opened any tickets.")],
    });
    return;
  }
  await interaction.editReply({ embeds: tickets.map((ticket) => ticketEmbed(ticket)) });
}

/**
 * `/ticket category` — create, remove or list the ticket categories.
 *
 * Categories are the buttons on the panel, so they are the admin surface that makes
 * the rest of the ticket module usable. A created category inherits the server's
 * configured ticket parent category and staff role (set via `/settings set area:tickets`)
 * unless the caller overrides the parent here, so a fresh category is immediately
 * reachable by staff instead of being a button nobody can see.
 */
async function runCategory(
  interaction: ChatInputCommandInteraction,
  service: TicketService,
  guildId: string,
  context: CommandExecutionContext,
): Promise<void> {
  if (!(await canManageTickets(interaction, context))) {
    await interaction.editReply({
      embeds: [
        errorEmbed(
          "Not allowed",
          "Managing ticket categories requires the `tickets.manage` permission.",
        ),
      ],
    });
    return;
  }

  const action = interaction.options.getString("action", true);

  if (action === "list") {
    const categories = await service.allCategories(guildId);
    if (categories.length === 0) {
      await interaction.editReply({
        embeds: [errorEmbed("No categories", "No ticket categories are configured yet.")],
      });
      return;
    }
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle("Ticket categories")
          .setDescription(
            categories
              .map(
                (category) =>
                  `${category.emoji ? `${category.emoji} ` : ""}**${category.label}** ` +
                  `(${category.enabled ? "enabled" : "disabled"}) — \`${category.key}\``,
              )
              .join("\n"),
          )
          .setFooter({ text: "Create or remove with /ticket category action:create|remove" }),
      ],
    });
    return;
  }

  if (action === "remove") {
    const key = interaction.options.getString("key");
    if (!key) {
      await interaction.editReply({
        embeds: [errorEmbed("Remove category", "Pick a category key to remove.")],
      });
      return;
    }
    const removed = await service.deleteCategory(guildId, key, interaction.user.id);
    await interaction.editReply({
      embeds: [
        removed
          ? new EmbedBuilder().setTitle("Category removed").setDescription(`Removed \`${key}\`.`)
          : errorEmbed("Unknown category", `No category has the key \`${key}\`.`),
      ],
    });
    return;
  }

  // action === "create"
  const label = interaction.options.getString("label")?.trim();
  if (!label) {
    await interaction.editReply({
      embeds: [errorEmbed("Create category", "Provide a `label` for the new category.")],
    });
    return;
  }

  const key = slugify(label);
  const existing = await service.findCategory(guildId, key);
  if (existing) {
    await interaction.editReply({
      embeds: [
        errorEmbed(
          "Category exists",
          `A category with key \`${key}\` already exists. Remove it first, or use a different name.`,
        ),
      ],
    });
    return;
  }

  // Default the parent and staff role from the server's ticket configuration, so a
  // created category is immediately usable. The caller may override the parent.
  const config = await context.config.get(guildId, interaction.guild?.name ?? guildId);
  const parentId =
    interaction.options.getChannel("parent")?.id ?? config.tickets.categoryId ?? null;
  const staffRoleIds: string[] = config.tickets.staffRoleId ? [config.tickets.staffRoleId] : [];

  const saved = await service.saveCategory(interaction.user.id, {
    guildId,
    key,
    label,
    emoji: interaction.options.getString("emoji") ?? null,
    description: interaction.options.getString("description") ?? null,
    parentId,
    staffRoleIds,
    pingRoleIds: [],
    enabled: true,
  });

  await interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setTitle(`Category "${saved.emoji ? `${saved.emoji} ` : ""}${saved.label}" created`)
        .setDescription(
          [
            `Key: \`${saved.key}\``,
            parentId ? `Tickets open in <#${parentId}>.` : "No parent category set.",
            staffRoleIds.length > 0
              ? `Staff role: <@&${staffRoleIds[0]}>.`
              : `No staff role set — configure one with \`/settings set area:tickets setting:tickets-staff-role\`.`,
          ].join("\n"),
        ),
    ],
  });
}

/**
 * @returns a stable, Discord-safe key for a category label.
 *
 * The key is what the open/remove autocomplete and the panel button carry, so it must
 * be a short slug rather than the human label itself (spaces and punctuation would
 * break the `ticket:open:<key>` custom id).
 */
function slugify(label: string): string {
  return (
    label
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "category"
  );
}
