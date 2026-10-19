-- V7 (additive): global AI provider settings, editable at runtime by the owner.
--
-- A single-row table ("key" = "global") so the deployment's AI provider can be
-- configured from Discord instead of `.env`. Additive only: no existing table is
-- altered, and it is deliberately separate from the pre-existing (guild-scoped)
-- `ai_settings` table.

CREATE TABLE "ai_provider_settings" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "baseUrl" TEXT,
    "apiKey" TEXT,
    "modelFast" TEXT,
    "modelSmart" TEXT,
    "dailyTokenBudget" INTEGER NOT NULL DEFAULT 0,
    "requestTimeoutMs" INTEGER NOT NULL DEFAULT 20000,
    "defaultTrigger" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_provider_settings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ai_provider_settings_key_key" ON "ai_provider_settings"("key");
