-- Backup, incidents and verification: the three tables the schema declared but no
-- migration ever created.
--
-- All three models shipped with their services and commands, but `prisma migrate
-- status` reported "up to date" because the migrations folder had no file for them.
-- The gap only surfaced at runtime:
--
--   * `/backup create` failed with `The table public.backup_snapshots does not
--     exist`, which the interaction handler could only report as the generic
--     "Something went wrong" embed, because an absent table is an internal fault
--     rather than something a user did;
--   * anti-raid, anti-nuke and lockdown persistence had nowhere to write, so an
--     incident could not survive a restart and `expiresAt`-based recovery had no
--     row to read;
--   * a quarantined member's pending state was never recorded, so verification
--     could not be resumed or swept.
--
-- Additive only: no existing table, column or constraint is modified, so V1–V5
-- data and behavior are untouched.

-- CreateTable
CREATE TABLE "backup_snapshots" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'manual',
    "status" TEXT NOT NULL DEFAULT 'complete',
    "payload" JSONB NOT NULL DEFAULT '{}',
    "roleCount" INTEGER NOT NULL DEFAULT 0,
    "channelCount" INTEGER NOT NULL DEFAULT 0,
    "checksum" TEXT,
    "createdBy" TEXT NOT NULL DEFAULT 'system',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "backup_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "backup_snapshots_guildId_createdAt_idx" ON "backup_snapshots"("guildId", "createdAt");

-- AddForeignKey
ALTER TABLE "backup_snapshots" ADD CONSTRAINT "backup_snapshots_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "guilds"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "security_incidents" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "summary" TEXT NOT NULL,
    "details" JSONB NOT NULL DEFAULT '{}',
    "targetedIds" JSONB NOT NULL DEFAULT '[]',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "resolvedBy" TEXT,

    CONSTRAINT "security_incidents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "security_incidents_guildId_status_idx" ON "security_incidents"("guildId", "status");

-- CreateIndex
CREATE INDEX "security_incidents_guildId_startedAt_idx" ON "security_incidents"("guildId", "startedAt");

-- AddForeignKey
ALTER TABLE "security_incidents" ADD CONSTRAINT "security_incidents_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "guilds"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "verification_pending" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "roleId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "verifiedAt" TIMESTAMP(3),

    CONSTRAINT "verification_pending_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "verification_pending_guildId_userId_key" ON "verification_pending"("guildId", "userId");

-- CreateIndex
CREATE INDEX "verification_pending_guildId_status_idx" ON "verification_pending"("guildId", "status");

-- AddForeignKey
ALTER TABLE "verification_pending" ADD CONSTRAINT "verification_pending_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "guilds"("id") ON DELETE CASCADE ON UPDATE CASCADE;
