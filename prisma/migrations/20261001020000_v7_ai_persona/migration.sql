-- V7 (additive): a free-form persona/tone for the AI assistant.
--
-- Additive only: one nullable column on the existing single-row
-- `ai_provider_settings` table. The operator owns the wording, so no register is
-- hard-coded; the value is simply appended to the agent's system prompt.

ALTER TABLE "ai_provider_settings" ADD COLUMN "persona" TEXT;
