/**
 * Backup module (V5).
 *
 * Snapshots of a guild's structure and configuration, restorable after a nuke.
 * Backups are stored per guild and a restore refuses a snapshot whose embedded
 * guild does not match the target, so nothing is ever shared between servers.
 */
export {
  BACKUP_CONFIG_SECTIONS,
  BACKUP_RETENTION,
  BackupService,
  type BackupServiceOptions,
  type GuildBackupActions,
} from "./backup.service.js";
export { canonicalJson, payloadChecksum, verifyChecksum } from "./backup.checksum.js";
export { DiscordBackupActions } from "./discord-backup-actions.js";
export { PrismaBackupRepository } from "./prisma-backup.repository.js";
export type {
  BackupChannel,
  BackupConfig,
  BackupOverwrite,
  BackupPayload,
  BackupRecord,
  BackupRepository,
  BackupRole,
  BackupSummary,
  RestoreReport,
} from "./backup.types.js";
