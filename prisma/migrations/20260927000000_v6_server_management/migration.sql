-- V6 "server management": scheduler, roles, tickets, reports, welcome, automation.
--
-- Generated with `prisma migrate diff` and reviewed by hand. Every table is
-- additive: no V4/V5 table is altered, so this migration cannot break a running
-- instance and rolling it back is a plain DROP.

CREATE TABLE "scheduled_tasks" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "recurrence" JSONB,
    "dedupeKey" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scheduled_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_grants" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "menuId" TEXT,
    "grantedBy" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "revokedBy" TEXT,

    CONSTRAINT "role_grants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_menus" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "messageId" TEXT,
    "key" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "mode" TEXT NOT NULL,
    "behaviour" TEXT NOT NULL DEFAULT 'toggle',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "role_menus_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_menu_options" (
    "id" TEXT NOT NULL,
    "menuId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "emoji" TEXT,
    "description" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "role_menu_options_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ticket_categories" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "emoji" TEXT,
    "description" TEXT,
    "parentId" TEXT,
    "staffRoleIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "pingRoleIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "prompt" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ticket_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tickets" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "categoryId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "openerId" TEXT NOT NULL,
    "claimedById" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "priority" TEXT NOT NULL DEFAULT 'normal',
    "subject" TEXT,
    "firstResponseAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "closedById" TEXT,
    "closeReason" TEXT,
    "messageCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ticket_transcripts" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "format" TEXT NOT NULL DEFAULT 'markdown',
    "messageCount" INTEGER NOT NULL DEFAULT 0,
    "checksum" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ticket_transcripts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reports" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "reporterId" TEXT NOT NULL,
    "targetUserId" TEXT,
    "targetMessageId" TEXT,
    "targetChannelId" TEXT,
    "summary" TEXT NOT NULL,
    "priority" TEXT NOT NULL DEFAULT 'normal',
    "status" TEXT NOT NULL DEFAULT 'open',
    "claimedById" TEXT,
    "resolution" TEXT,
    "resolvedById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "welcome_settings" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "welcomeChannelId" TEXT,
    "welcomeMessage" TEXT NOT NULL DEFAULT 'Welcome {user} to {guild}!',
    "welcomeDmEnabled" BOOLEAN NOT NULL DEFAULT false,
    "welcomeDmMessage" TEXT NOT NULL DEFAULT 'Welcome to {guild}, {user}!',
    "leaveChannelId" TEXT,
    "leaveMessage" TEXT NOT NULL DEFAULT '{user} left {guild}.',
    "autoRoleIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "unverifiedRoleId" TEXT,
    "rulesMessage" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "welcome_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rules_acknowledgements" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "roleId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rules_acknowledgements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "automation_rules" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "trigger" JSONB NOT NULL,
    "conditions" JSONB NOT NULL DEFAULT '[]',
    "actions" JSONB NOT NULL DEFAULT '[]',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" TEXT NOT NULL,
    "fireCount" INTEGER NOT NULL DEFAULT 0,
    "lastFiredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "automation_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "temporary_channels" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "temporary_channels_pkey" PRIMARY KEY ("id")
);

-- CreateIndex

CREATE INDEX "scheduled_tasks_status_dueAt_idx" ON "scheduled_tasks"("status", "dueAt");
CREATE INDEX "scheduled_tasks_guildId_status_idx" ON "scheduled_tasks"("guildId", "status");
CREATE UNIQUE INDEX "scheduled_tasks_guildId_dedupeKey_key" ON "scheduled_tasks"("guildId", "dedupeKey");
CREATE INDEX "role_grants_guildId_userId_status_idx" ON "role_grants"("guildId", "userId", "status");
CREATE INDEX "role_grants_guildId_status_expiresAt_idx" ON "role_grants"("guildId", "status", "expiresAt");
CREATE INDEX "role_menus_guildId_enabled_idx" ON "role_menus"("guildId", "enabled");
CREATE UNIQUE INDEX "role_menus_guildId_key_key" ON "role_menus"("guildId", "key");
CREATE INDEX "role_menu_options_menuId_position_idx" ON "role_menu_options"("menuId", "position");
CREATE UNIQUE INDEX "role_menu_options_menuId_roleId_key" ON "role_menu_options"("menuId", "roleId");
CREATE INDEX "ticket_categories_guildId_enabled_idx" ON "ticket_categories"("guildId", "enabled");
CREATE UNIQUE INDEX "ticket_categories_guildId_key_key" ON "ticket_categories"("guildId", "key");
CREATE INDEX "tickets_guildId_status_idx" ON "tickets"("guildId", "status");
CREATE INDEX "tickets_guildId_categoryId_status_idx" ON "tickets"("guildId", "categoryId", "status");
CREATE INDEX "tickets_guildId_openerId_idx" ON "tickets"("guildId", "openerId");
CREATE UNIQUE INDEX "tickets_guildId_number_key" ON "tickets"("guildId", "number");
CREATE UNIQUE INDEX "ticket_transcripts_ticketId_key" ON "ticket_transcripts"("ticketId");
CREATE INDEX "ticket_transcripts_guildId_createdAt_idx" ON "ticket_transcripts"("guildId", "createdAt");
CREATE INDEX "reports_guildId_status_priority_idx" ON "reports"("guildId", "status", "priority");
CREATE INDEX "reports_guildId_reporterId_idx" ON "reports"("guildId", "reporterId");
CREATE UNIQUE INDEX "reports_guildId_number_key" ON "reports"("guildId", "number");
CREATE UNIQUE INDEX "welcome_settings_guildId_key" ON "welcome_settings"("guildId");
CREATE UNIQUE INDEX "rules_acknowledgements_guildId_userId_key" ON "rules_acknowledgements"("guildId", "userId");
CREATE INDEX "automation_rules_guildId_enabled_idx" ON "automation_rules"("guildId", "enabled");
CREATE UNIQUE INDEX "automation_rules_guildId_name_key" ON "automation_rules"("guildId", "name");
CREATE INDEX "temporary_channels_guildId_status_expiresAt_idx" ON "temporary_channels"("guildId", "status", "expiresAt");

ALTER TABLE "scheduled_tasks" ADD CONSTRAINT "scheduled_tasks_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "guilds"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "role_grants" ADD CONSTRAINT "role_grants_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "guilds"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "role_menus" ADD CONSTRAINT "role_menus_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "guilds"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "role_menu_options" ADD CONSTRAINT "role_menu_options_menuId_fkey" FOREIGN KEY ("menuId") REFERENCES "role_menus"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ticket_categories" ADD CONSTRAINT "ticket_categories_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "guilds"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "guilds"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "ticket_categories"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ticket_transcripts" ADD CONSTRAINT "ticket_transcripts_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "guilds"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "reports" ADD CONSTRAINT "reports_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "guilds"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "welcome_settings" ADD CONSTRAINT "welcome_settings_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "guilds"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "rules_acknowledgements" ADD CONSTRAINT "rules_acknowledgements_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "guilds"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "automation_rules" ADD CONSTRAINT "automation_rules_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "guilds"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "temporary_channels" ADD CONSTRAINT "temporary_channels_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "guilds"("id") ON DELETE CASCADE ON UPDATE CASCADE;

