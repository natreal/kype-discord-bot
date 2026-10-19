-- Command deployment: per-guild record of the last published slash-command payload.
--
-- Additive only: no existing table, column or constraint is modified, so V1–V5
-- data and behavior are untouched.
--
-- Why this table exists at all: automatic deployment on startup and on
-- `guildCreate` needs to know *which* servers still need a deployment without
-- calling Discord once per guild on every boot. `fingerprint` is a hash of the
-- payload (names, descriptions and options), so an edited option is detected and
-- not only an added or removed command. A guild with no row is treated as "never
-- deployed", which is exactly right for a server that just installed the bot.

-- CreateTable
CREATE TABLE "command_deployments" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "commandCount" INTEGER NOT NULL DEFAULT 0,
    "source" TEXT NOT NULL DEFAULT 'startup',
    "deployedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "command_deployments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "command_deployments_guildId_key" ON "command_deployments"("guildId");

-- CreateIndex
CREATE INDEX "command_deployments_guildId_deployedAt_idx" ON "command_deployments"("guildId", "deployedAt");

-- AddForeignKey
ALTER TABLE "command_deployments" ADD CONSTRAINT "command_deployments_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "guilds"("id") ON DELETE CASCADE ON UPDATE CASCADE;
