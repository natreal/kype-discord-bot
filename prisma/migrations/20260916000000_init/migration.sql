-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "guilds" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "language" TEXT NOT NULL DEFAULT 'en',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "guilds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "guild_settings" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "modules" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "guild_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "moderation_settings" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "config" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "moderation_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "security_settings" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "lockdown" BOOLEAN NOT NULL DEFAULT false,
    "config" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "security_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "logging_settings" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "config" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "logging_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_settings" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "config" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ticket_settings" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "config" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ticket_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "automation_settings" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "config" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "automation_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "member_settings" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "config" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "member_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "setup_runs" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "created" INTEGER NOT NULL DEFAULT 0,
    "reused" INTEGER NOT NULL DEFAULT 0,
    "updated" INTEGER NOT NULL DEFAULT 0,
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "details" JSONB NOT NULL DEFAULT '[]',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "durationMs" INTEGER,

    CONSTRAINT "setup_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "guild_settings_guildId_key" ON "guild_settings"("guildId");

-- CreateIndex
CREATE UNIQUE INDEX "moderation_settings_guildId_key" ON "moderation_settings"("guildId");

-- CreateIndex
CREATE UNIQUE INDEX "security_settings_guildId_key" ON "security_settings"("guildId");

-- CreateIndex
CREATE UNIQUE INDEX "logging_settings_guildId_key" ON "logging_settings"("guildId");

-- CreateIndex
CREATE UNIQUE INDEX "ai_settings_guildId_key" ON "ai_settings"("guildId");

-- CreateIndex
CREATE UNIQUE INDEX "ticket_settings_guildId_key" ON "ticket_settings"("guildId");

-- CreateIndex
CREATE UNIQUE INDEX "automation_settings_guildId_key" ON "automation_settings"("guildId");

-- CreateIndex
CREATE UNIQUE INDEX "member_settings_guildId_key" ON "member_settings"("guildId");

-- CreateIndex
CREATE INDEX "setup_runs_guildId_startedAt_idx" ON "setup_runs"("guildId", "startedAt");

-- AddForeignKey
ALTER TABLE "guild_settings" ADD CONSTRAINT "guild_settings_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "guilds"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "moderation_settings" ADD CONSTRAINT "moderation_settings_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "guilds"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "security_settings" ADD CONSTRAINT "security_settings_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "guilds"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "logging_settings" ADD CONSTRAINT "logging_settings_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "guilds"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_settings" ADD CONSTRAINT "ai_settings_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "guilds"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_settings" ADD CONSTRAINT "ticket_settings_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "guilds"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "automation_settings" ADD CONSTRAINT "automation_settings_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "guilds"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member_settings" ADD CONSTRAINT "member_settings_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "guilds"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "setup_runs" ADD CONSTRAINT "setup_runs_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "guilds"("id") ON DELETE CASCADE ON UPDATE CASCADE;

