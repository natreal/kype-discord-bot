/**
 * `/ai` — assistant, keyword agent, memory and configuration.
 *
 * A thin command surface: every subcommand delegates to the process-wide `ai`
 * gateway, the guild-scoped `aiMemory`, or the guild configuration service. No
 * AI or Discord logic lives here — the subcommands translate options into a
 * service call and render the result. Usage is gated by `ai.use`; configuration
 * subcommands re-check `ai.configure` so a server can let members *use* the
 * assistant without letting them change its mode, trigger or budget.
 */
import {
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";

import { defineSlashCommand } from "../define.js";
import type { CommandExecutionContext } from "../context.js";
import { brandedEmbed, errorEmbed } from "../../utils/presenters.js";
import { formatBuildInfo } from "../../runtime/build-info.js";
import type { AiMode } from "../../modules/ai/tool-menu.js";
import { hasGodAccess } from "../../services/authorization/index.js";
import type { AiProviderSettingsPatch } from "../../services/ai/ai-settings.service.js";

const NO_AI = "IA non configurée — définis AI_BASE_URL (et AI_API_KEY) pour l'activer.";

export default defineSlashCommand({
  meta: {
    name: "ai",
    description: "Use or configure the AI assistant and keyword agent.",
    category: "ai",
    usage: "/ai ask|summarize|trigger|mode|tools|memory|status|enable|disable",
    examples: ["/ai ask question:Qui est le bot ?", "/ai status"],
  },
  permissions: { custom: ["ai.use"] },
  data: new SlashCommandBuilder()
    .setName("ai")
    .setDescription("Use or configure the AI assistant and keyword agent.")
    .addSubcommand((sub) =>
      sub
        .setName("ask")
        .setDescription("Ask the assistant a question.")
        .addStringOption((option) =>
          option.setName("question").setDescription("The question.").setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("summarize")
        .setDescription("Summarize a channel.")
        .addChannelOption((option) =>
          option.setName("channel").setDescription("Channel to summarize.").setRequired(true),
        )
        .addIntegerOption((option) =>
          option.setName("limit").setDescription("Number of messages (default 25).").setRequired(false),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("trigger")
        .setDescription("Set the server's keyword trigger (default: kype).")
        .addStringOption((option) =>
          option.setName("word").setDescription("The new trigger word.").setRequired(true),
        )
        .addBooleanOption((option) =>
          option.setName("reset").setDescription("Reset to the global default.").setRequired(false),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("mode")
        .setDescription("Choose the agent mode (strict, large, custom).")
        .addStringOption((option) =>
          option
            .setName("value")
            .setDescription("strict | large | custom")
            .setRequired(true)
            .addChoices(
              { name: "strict", value: "strict" },
              { name: "large", value: "large" },
              { name: "custom", value: "custom" },
            ),
        ),
    )
    .addSubcommand((sub) =>
      sub.setName("tools").setDescription("List the tools active in the current mode."),
    )
    .addSubcommand((sub) =>
      sub
        .setName("memory")
        .setDescription("Manage guild memory.")
        .addStringOption((option) =>
          option
            .setName("action")
            .setDescription("remember | forget | list")
            .setRequired(true)
            .addChoices(
              { name: "remember", value: "remember" },
              { name: "forget", value: "forget" },
              { name: "list", value: "list" },
            ),
        )
        .addStringOption((option) =>
          option.setName("kind").setDescription("Memory kind.").setRequired(false),
        )
        .addStringOption((option) =>
          option.setName("key").setDescription("Memory key.").setRequired(false),
        )
        .addStringOption((option) =>
          option.setName("content").setDescription("Memory content (for remember).").setRequired(false),
        ),
    )
    .addSubcommand((sub) => sub.setName("status").setDescription("Show AI configuration and budget."))
    .addSubcommand((sub) => sub.setName("enable").setDescription("Enable the AI agent in this server."))
    .addSubcommand((sub) => sub.setName("disable").setDescription("Disable the AI agent in this server."))
    .addSubcommandGroup((group) =>
      group
        .setName("config")
        .setDescription("God Access: set global AI provider settings.")
        .addSubcommand((sub) =>
          sub.setName("show").setDescription("Show the current (redacted) provider settings."),
        )
        .addSubcommand((sub) =>
          sub
            .setName("set")
            .setDescription("Set a provider setting.")
            .addStringOption((option) =>
              option
                .setName("key")
                .setDescription("Which setting.")
                .setRequired(true)
                .addChoices(
                  { name: "baseUrl", value: "baseUrl" },
                  { name: "apiKey", value: "apiKey" },
                  { name: "modelFast", value: "modelFast" },
                  { name: "modelSmart", value: "modelSmart" },
                  { name: "defaultTrigger", value: "defaultTrigger" },
                  { name: "persona", value: "persona" },
                  { name: "dailyTokenBudget", value: "dailyTokenBudget" },
                ),
            )
            .addStringOption((option) =>
              option.setName("value").setDescription("The new value.").setRequired(false),
            )
            .addIntegerOption((option) =>
              option.setName("budget").setDescription("Daily token budget (0 = unlimited).").setRequired(false),
            ),
        )
        .addSubcommand((sub) =>
          sub.setName("test").setDescription("Ping the configured provider (/models)."),
        ),
    ),

  execute: async (interaction, context) => {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    // The whole `config` group is God Access only, checked before dispatch.
    const group = interaction.options.getSubcommandGroup();
    if (group === "config") {
      await handleConfig(interaction, context);
      return;
    }

    const sub = interaction.options.getSubcommand();

    switch (sub) {
      case "ask":
        await handleAsk(interaction, context);
        return;
      case "summarize":
        await handleSummarize(interaction, context);
        return;
      case "trigger":
        await handleTrigger(interaction, context);
        return;
      case "mode":
        await handleMode(interaction, context);
        return;
      case "tools":
        await handleTools(interaction, context);
        return;
      case "memory":
        await handleMemory(interaction, context);
        return;
      case "status":
        await handleStatus(interaction, context);
        return;
      case "enable":
      case "disable":
        await handleToggle(interaction, context, sub === "enable");
        return;
    }
  },
});

async function handleAsk(interaction: ChatInputCommandInteraction, context: CommandExecutionContext): Promise<void> {
  const question = interaction.options.getString("question", true);
  if (!context.ai?.isConfigured) {
    await interaction.editReply({ embeds: [errorEmbed("IA", NO_AI)] });
    return;
  }
  const result = await context.ai.complete({ messages: [{ role: "user", content: question }] }, "smart");
  await interaction.editReply({
    embeds: [brandedEmbed("Assistant").setDescription(result.ok ? result.text : `⛔ ${result.detail}`)],
  });
}

async function handleSummarize(
  interaction: ChatInputCommandInteraction,
  context: CommandExecutionContext,
): Promise<void> {
  if (!context.ai?.isConfigured) {
    await interaction.editReply({ embeds: [errorEmbed("IA", NO_AI)] });
    return;
  }
  const channelId = interaction.options.getChannel("channel", true).id;
  const limit = interaction.options.getInteger("limit") ?? 25;
  const result = await context.ai.complete(
    { messages: [{ role: "user", content: `Summarize channel <#${channelId}> (last ${limit} messages).` }] },
    "fast",
  );
  await interaction.editReply({
    embeds: [brandedEmbed("Résumé").setDescription(result.ok ? result.text : `⛔ ${result.detail}`)],
  });
}

async function handleTrigger(
  interaction: ChatInputCommandInteraction,
  context: CommandExecutionContext,
): Promise<void> {
  if (!(await canConfigure(interaction, context))) {
    return;
  }
  const guildId = interaction.guildId;
  if (!guildId) {
    return;
  }
  const word = interaction.options.getString("word", true);
  const reset = interaction.options.getBoolean("reset") ?? false;
  const current = await context.config.get(guildId);
  const trigger = reset ? null : word.trim();
  await context.config.update(guildId, { ai: { ...current.ai, trigger } });
  await interaction.editReply({
    embeds: [
      brandedEmbed("Déclencheur").setDescription(
        reset ? "Mot-clé réinitialisé (kype)." : `Mot-clé défini : \`${word}\``,
      ),
    ],
  });
}

async function handleMode(interaction: ChatInputCommandInteraction, context: CommandExecutionContext): Promise<void> {
  if (!(await canConfigure(interaction, context))) {
    return;
  }
  const guildId = interaction.guildId;
  if (!guildId) {
    return;
  }
  const mode = interaction.options.getString("value", true) as AiMode;
  const current = await context.config.get(guildId);
  await context.config.update(guildId, { ai: { ...current.ai, mode } });
  await interaction.editReply({
    embeds: [brandedEmbed("Mode").setDescription(`Mode défini : \`${mode}\``)],
  });
}

async function handleTools(interaction: ChatInputCommandInteraction, context: CommandExecutionContext): Promise<void> {
  if (!context.guildConfig) {
    return;
  }
  const ai = context.guildConfig.ai;
  const description =
    ai.mode === "custom"
      ? `Mode \`custom\` — catégories actives : ${ai.enabledCategories.join(", ") || "(aucune)"}.`
      : `Mode \`${ai.mode}\` actif.`;
  await interaction.editReply({ embeds: [brandedEmbed("Outils").setDescription(description)] });
}

async function handleMemory(interaction: ChatInputCommandInteraction, context: CommandExecutionContext): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId || !context.guildConfig) {
    return;
  }
  if (!context.guildConfig.ai.memoryEnabled) {
    await interaction.editReply({ embeds: [errorEmbed("Mémoire", "memoryEnabled est désactivé.")] });
    return;
  }
  if (!context.aiMemory) {
    await interaction.editReply({ embeds: [errorEmbed("Mémoire", "Mémoire non câblée.")] });
    return;
  }
  const action = interaction.options.getString("action", true);
  const kind = (interaction.options.getString("kind") ?? "note") as never;
  const key = interaction.options.getString("key") ?? "";
  const content = interaction.options.getString("content") ?? "";

  if (action === "list") {
    const result = await context.aiMemory.list(guildId);
    const lines =
      result.ok && result.value.length > 0
        ? result.value.map((note) => `• [${note.kind}] \`${note.key}\` — ${note.content.slice(0, 80)}`)
        : ["(vide)"];
    await interaction.editReply({ embeds: [brandedEmbed("Mémoire").setDescription(lines.join("\n"))] });
    return;
  }

  if (action === "forget") {
    const result = await context.aiMemory.forget(guildId, kind, key);
    await interaction.editReply({
      embeds: [brandedEmbed("Mémoire").setDescription(result.ok ? "Oublié." : `⛔ ${result.detail}`)],
    });
    return;
  }

  const result = await context.aiMemory.remember(guildId, kind, key, content);
  await interaction.editReply({
    embeds: [brandedEmbed("Mémoire").setDescription(result.ok ? "Mémorisé." : `⛔ ${result.detail}`)],
  });
}

async function handleStatus(interaction: ChatInputCommandInteraction, context: CommandExecutionContext): Promise<void> {
  const config = context.guildConfig;
  const budget = context.ai ? context.ai.budget() : { limit: 0, used: 0, remaining: 0 };
  const lines = [
    `**Configuré :** ${context.ai?.isConfigured ? "oui" : "non"}`,
    `**Base URL :** ${context.appConfig.ai.baseUrl ? "présente" : "absente"}`,
    `**Modèles :** \`${context.appConfig.ai.modelFast ?? "-"}\` / \`${context.appConfig.ai.modelSmart ?? "-"}\``,
    `**Budget :** ${budget.used} / ${budget.limit === 0 ? "∞" : budget.limit} jetons`,
    `**Version :** ${formatBuildInfo(context.appConfig.build)}`,
    ...(config?.ai
      ? [
          `**Activé (ce serveur) :** ${config.ai.enabled ? "oui" : "non"}`,
          `**Mode :** \`${config.ai.mode}\``,
          `**Mot-clé :** \`${config.ai.trigger ?? context.appConfig.ai.defaultTrigger}\``,
          `**Mémoire :** ${config.ai.memoryEnabled ? "on" : "off"}`,
        ]
      : []),
  ];
  await interaction.editReply({ embeds: [brandedEmbed("Statut IA").setDescription(lines.join("\n"))] });
}

/**
 * Enables or disables the keyword agent for this server (`ai.enabled`).
 *
 * Unlike `/ai config` (God Access, global provider settings), this is a
 * per-server switch guarded by the guild's `ai.configure` permission, so a
 * server's staff can turn the agent on for their own server without operator
 * involvement. The provider itself must still be configured for the agent to
 * actually reply.
 */
async function handleToggle(
  interaction: ChatInputCommandInteraction,
  context: CommandExecutionContext,
  enabled: boolean,
): Promise<void> {
  if (!(await canConfigure(interaction, context))) {
    return;
  }
  const guildId = interaction.guildId;
  if (!guildId) {
    return;
  }
  const current = await context.config.get(guildId);
  await context.config.update(guildId, { ai: { ...current.ai, enabled } });

  const trigger = current.ai.trigger ?? context.appConfig.ai.defaultTrigger;
  const description = enabled
    ? [
        "✅ L'IA est **activée** pour ce serveur.",
        context.ai?.isConfigured
          ? `Écris \`${trigger} …\` dans un salon pour me parler.`
          : "⚠️ Mais le fournisseur n'est pas encore configuré (base URL / clé).",
      ].join("\n")
    : "⛔ L'IA est **désactivée** pour ce serveur.";

  await interaction.editReply({ embeds: [brandedEmbed("IA").setDescription(description)] });
}

async function canConfigure(
  interaction: ChatInputCommandInteraction,
  context: CommandExecutionContext,
): Promise<boolean> {
  const member = interaction.guild?.members.cache.get(interaction.user.id);
  if (!member) {
    await interaction.editReply({ embeds: [errorEmbed("IA", "Impossible de résoudre le membre.")] });
    return false;
  }
  // Resolved through the authorization layer (role → class → permission), not
  // through `context.permissions`: the legacy service is synchronous and cannot
  // consult the guild's class mapping, so it cannot answer this question.
  const decision = await context.authorization.authorize(
    member,
    { custom: ["ai.configure"] },
    "ai.configure",
  );
  if (!decision.allowed) {
    await interaction.editReply({
      embeds: [errorEmbed("IA", "Il te faut la permission `ai.configure` pour configurer l'IA.")],
    });
    return false;
  }
  return true;
}

/**
 * God Access configuration menu (`/ai config`).
 *
 * The only place that can change the *global* provider settings. Every branch
 * first checks `hasGodAccess` and refuses anyone else, then delegates to the
 * settings service (which never leaks the API key) and reconfigures the live
 * gateway so the change applies immediately without a restart.
 */
async function handleConfig(
  interaction: ChatInputCommandInteraction,
  context: CommandExecutionContext,
): Promise<void> {
  if (!hasGodAccess(interaction.user.id)) {
    await interaction.editReply({
      embeds: [errorEmbed("God Access", "Ce menu est réservé au propriétaire du bot.")],
    });
    return;
  }
  if (!context.aiSettings) {
    await interaction.editReply({ embeds: [errorEmbed("IA", "Réglages IA non câblés.")] });
    return;
  }

  const action = interaction.options.getSubcommand();

  if (action === "show") {
    const redacted = await context.aiSettings.getRedacted();
    const lines = [
      `**Base URL :** ${redacted.baseUrl ?? "(aucune)"}`,
      `**Clé API :** ${redacted.apiKeySet ? "définie (`[redacted]`)" : "(aucune)"}`,
      `**Modèle fast :** ${redacted.modelFast ?? "-"}`,
      `**Modèle smart :** ${redacted.modelSmart ?? "-"}`,
      `**Budget journalier :** ${redacted.dailyTokenBudget === 0 ? "∞" : redacted.dailyTokenBudget}`,
      `**Mot-clé global :** ${redacted.defaultTrigger ?? "-"}`,
      `**Persona :** ${redacted.persona ?? "(par défaut)"}`,
    ];
    await interaction.editReply({ embeds: [brandedEmbed("IA (God Access)").setDescription(lines.join("\n"))] });
    return;
  }

  if (action === "test") {
    const ping = await context.ai?.ping();
    await interaction.editReply({
      embeds: [
        brandedEmbed("Test fournisseur").setDescription(
          ping && ping.ok ? "✅ Fournisseur joignable (/models ok)." : `⛔ ${ping?.detail ?? "non configuré"}`,
        ),
      ],
    });
    return;
  }

  // `set`
  const key = interaction.options.getString("key", true);
  const value = interaction.options.getString("value");
  const budget = interaction.options.getInteger("budget");

  const patch: AiProviderSettingsPatch = {};
  if (key === "apiKey") {
    patch.apiKey = value ?? null;
  } else if (key === "dailyTokenBudget") {
    patch.dailyTokenBudget = budget ?? 0;
  } else if (value !== undefined) {
    if (key === "baseUrl") patch.baseUrl = value;
    else if (key === "modelFast") patch.modelFast = value;
    else if (key === "modelSmart") patch.modelSmart = value;
    else if (key === "defaultTrigger") patch.defaultTrigger = value;
    else if (key === "persona") patch.persona = value;
  } else {
    await interaction.editReply({
      embeds: [errorEmbed("IA", `Fournis une valeur pour \`${key}\` (ou \`budget\` pour le budget).`)],
    });
    return;
  }

  await context.aiSettings.update(patch);

  // Apply to the live gateway immediately (no restart required).
  const effective = await context.aiSettings.get();
  context.ai?.reconfigure({
    baseUrl: effective.baseUrl,
    ...(effective.apiKey === undefined ? {} : { apiKey: effective.apiKey }),
    ...(effective.modelFast === undefined ? {} : { modelFast: effective.modelFast }),
    ...(effective.modelSmart === undefined ? {} : { modelSmart: effective.modelSmart }),
    dailyTokenBudget: effective.dailyTokenBudget,
  });

  // Never echo a typed API key back.
  const echoed = key === "apiKey" ? "`[redacted]`" : `\`${value ?? budget ?? ""}\``;
  await interaction.editReply({
    embeds: [brandedEmbed("IA mise à jour").setDescription(`**${key}** = ${echoed}`)],
  });
}



