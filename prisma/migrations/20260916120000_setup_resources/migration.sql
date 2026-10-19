-- CreateEnum
CREATE TYPE "SetupResourceType" AS ENUM ('CATEGORY', 'TEXT_CHANNEL', 'VOICE_CHANNEL', 'ROLE');

-- CreateTable
CREATE TABLE "setup_resources" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "type" "SetupResourceType" NOT NULL,
    "discordId" TEXT,
    "name" TEXT,
    "config" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "setup_resources_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "setup_resources_guildId_key_key" ON "setup_resources"("guildId", "key");

-- CreateIndex
CREATE INDEX "setup_resources_guildId_type_idx" ON "setup_resources"("guildId", "type");

-- AddForeignKey
ALTER TABLE "setup_resources" ADD CONSTRAINT "setup_resources_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "guilds"("id") ON DELETE CASCADE ON UPDATE CASCADE;
