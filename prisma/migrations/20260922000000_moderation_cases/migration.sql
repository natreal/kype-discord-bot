-- V4: moderation cases and their per-guild case numbering.
--
-- Additive only: no existing table, column or constraint is modified, so V1/V2/V3
-- data and behavior are untouched. A guild that never runs a moderation command
-- keeps exactly the rows it had before.
--
-- Why a dedicated history table rather than more `audit_events`:
-- `audit_events` answers "who changed the bot's state"; `/history` answers "what
-- happened to this member", which needs a stable, human-facing case number, an
-- expiry column a future sweeper can query, and before/after member state. The
-- audit trail is written from the same code path, so the two never disagree.

-- CreateTable
CREATE TABLE "moderation_cases" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "caseNumber" INTEGER NOT NULL,
    "action" TEXT NOT NULL,
    "targetId" TEXT,
    "targetType" TEXT NOT NULL DEFAULT 'member',
    "moderatorId" TEXT NOT NULL,
    "moderatorKind" TEXT NOT NULL DEFAULT 'user',
    "reason" TEXT,
    "durationMs" INTEGER,
    "expiresAt" TIMESTAMP(3),
    "before" JSONB,
    "after" JSONB,
    "details" JSONB,
    "relatedCaseNumber" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "moderation_cases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "guild_moderation_counters" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "value" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "guild_moderation_counters_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "moderation_cases_guildId_caseNumber_key" ON "moderation_cases"("guildId", "caseNumber");

-- CreateIndex
CREATE INDEX "moderation_cases_guildId_targetId_createdAt_idx" ON "moderation_cases"("guildId", "targetId", "createdAt");

-- CreateIndex
CREATE INDEX "moderation_cases_guildId_action_createdAt_idx" ON "moderation_cases"("guildId", "action", "createdAt");

-- CreateIndex
CREATE INDEX "moderation_cases_guildId_createdAt_idx" ON "moderation_cases"("guildId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "guild_moderation_counters_guildId_key" ON "guild_moderation_counters"("guildId");

-- AddForeignKey
ALTER TABLE "moderation_cases" ADD CONSTRAINT "moderation_cases_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "guilds"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guild_moderation_counters" ADD CONSTRAINT "guild_moderation_counters_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "guilds"("id") ON DELETE CASCADE ON UPDATE CASCADE;
