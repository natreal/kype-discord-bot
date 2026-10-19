-- V7 "AI assistant, keyword agent, roles-gated tools, guild memory".
--
-- Additive only: no existing table is altered, so upgrading a running instance
-- cannot break it and rolling back is a plain DROP. `ai_guild_memory` is the
-- single new table; the AI configuration fields (trigger, mode, categories,
-- memoryEnabled, autoActThreshold) are stored inside the existing
-- `guild_config_sections` JSON, not as columns, so there is no schema change for
-- them.

CREATE TABLE "ai_guild_memory" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_guild_memory_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ai_guild_memory_guildId_kind_key_key" ON "ai_guild_memory"("guildId", "kind", "key");

CREATE INDEX "ai_guild_memory_guildId_kind_idx" ON "ai_guild_memory"("guildId", "kind");

ALTER TABLE "ai_guild_memory" ADD CONSTRAINT "ai_guild_memory_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "guilds"("id") ON DELETE CASCADE ON UPDATE CASCADE;
