-- V3: guild configuration sections, configuration revisions, permission
-- classes/role bindings and the structured audit trail.
--
-- Additive only: no existing table, column or constraint is modified, so V1/V2
-- data and behavior are untouched.

-- CreateTable
CREATE TABLE "guild_config_sections" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "section" TEXT NOT NULL,
    "value" JSONB NOT NULL DEFAULT '{}',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "guild_config_sections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "guild_config_revisions" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "section" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB NOT NULL,
    "actorId" TEXT,
    "actorKind" TEXT NOT NULL DEFAULT 'user',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "guild_config_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "permission_classes" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "permissions" JSONB NOT NULL DEFAULT '[]',
    "builtIn" BOOLEAN NOT NULL DEFAULT false,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "permission_classes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_permission_classes" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "classKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "role_permission_classes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_events" (
    "id" TEXT NOT NULL,
    "guildId" TEXT,
    "action" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'info',
    "actorId" TEXT,
    "actorKind" TEXT NOT NULL DEFAULT 'system',
    "targetType" TEXT,
    "targetId" TEXT,
    "outcome" TEXT NOT NULL DEFAULT 'success',
    "before" JSONB,
    "after" JSONB,
    "details" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "guild_config_sections_guildId_section_key" ON "guild_config_sections"("guildId", "section");

-- CreateIndex
CREATE INDEX "guild_config_revisions_guildId_createdAt_idx" ON "guild_config_revisions"("guildId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "permission_classes_guildId_key_key" ON "permission_classes"("guildId", "key");

-- CreateIndex
CREATE INDEX "permission_classes_guildId_priority_idx" ON "permission_classes"("guildId", "priority");

-- CreateIndex
CREATE UNIQUE INDEX "role_permission_classes_guildId_roleId_classKey_key" ON "role_permission_classes"("guildId", "roleId", "classKey");

-- CreateIndex
CREATE INDEX "role_permission_classes_guildId_roleId_idx" ON "role_permission_classes"("guildId", "roleId");

-- CreateIndex
CREATE INDEX "audit_events_guildId_createdAt_idx" ON "audit_events"("guildId", "createdAt");

-- CreateIndex
CREATE INDEX "audit_events_action_createdAt_idx" ON "audit_events"("action", "createdAt");

-- AddForeignKey
ALTER TABLE "guild_config_sections" ADD CONSTRAINT "guild_config_sections_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "guilds"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guild_config_revisions" ADD CONSTRAINT "guild_config_revisions_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "guilds"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "permission_classes" ADD CONSTRAINT "permission_classes_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "guilds"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permission_classes" ADD CONSTRAINT "role_permission_classes_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "guilds"("id") ON DELETE CASCADE ON UPDATE CASCADE;
