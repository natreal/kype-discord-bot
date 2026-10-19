/**
 * Member onboarding service.
 *
 * The whole module answers one question: *what should happen when somebody
 * joins?* The `members` configuration section already declares the answer —
 * auto-roles to grant and a welcome message to post — but until this service
 * existed nothing read it, so a server that configured an auto-role saw a new
 * member arrive with no role, and a welcome channel that never received a line.
 *
 * Design choices worth stating, because they are decisions rather than
 * consequences:
 *
 * - **Configuration is read live, per join.** A `/settings` change takes effect
 *   on the very next member, with no restart, exactly as it does everywhere else
 *   in the platform.
 * - **A failure never blocks the join.** Discord cannot be asked to grant a role
 *   the bot does not outrank, so each role is attempted independently and the
 *   outcome is reported rather than thrown. One unmanageable role must not stop
 *   the welcome message, and a missing welcome channel must not stop the roles.
 * - **Welcome is opt-in on both toggles.** `welcomeEnabled` *and* a configured
 *   `welcomeChannelId` are both required: an enabled account with no channel is
 *   the classic half-configured state, and silently posting nowhere is worse than
 *   doing nothing.
 */
import type { Logger } from "../../services/logger/index.js";
import type { AuditEventService } from "../../services/audit/index.js";
import type { GuildConfig } from "../../services/config/index.js";
import type {
  GuildMemberOnboardingActions,
  MemberJoinOutcome,
  MemberJoinRequest,
} from "./members.types.js";

/** How `members` config is read; injected so a test needs no database. */
export type MemberConfigReader = (guildId: string) => Promise<GuildConfig["members"]>;

/** Collaborators the service needs, all injected. */
export interface MemberOnboardingServiceDeps {
  readonly logger: Logger;
  readonly actions: GuildMemberOnboardingActions;
  /** Reads the guild's live `members` section. */
  readonly settings: MemberConfigReader;
  /** Optional: audit trail for grants and welcomes. */
  readonly audit?: AuditEventService;
}

export class MemberOnboardingService {
  private readonly logger: Logger;
  private readonly actions: GuildMemberOnboardingActions;
  private readonly settings: MemberConfigReader;
  private readonly audit: AuditEventService | undefined;
  /** Roles skipped by the most recent `applyAutoRoles`, for the outcome. */
  private lastSkipped: { roleId: string; detail: string }[] = [];

  public constructor(deps: MemberOnboardingServiceDeps) {
    this.logger = deps.logger;
    this.actions = deps.actions;
    this.settings = deps.settings;
    this.audit = deps.audit;
  }

  /**
   * Applies the guild's onboarding to one member.
   *
   * Never throws: the `guildMemberAdd` handler must be able to log a join and run
   * anti-raid whether or not onboarding succeeded, so every failure is captured
   * in the returned outcome and logged.
   */
  public async onboard(request: MemberJoinRequest): Promise<MemberJoinOutcome> {
    const config = await this.settings(request.guildId).catch((error) => {
      this.logger.warn("Could not read members configuration for a new member", {
        guildId: request.guildId,
        userId: request.userId,
        error: String(error),
      });
      return null;
    });

    if (!config) {
      return { rolesApplied: [], rolesSkipped: [], welcomed: false };
    }

    const rolesApplied = await this.applyAutoRoles(request, config);
    const rolesSkipped = this.lastSkipped;
    const welcomed = await this.sendWelcome(request, config);

    return { rolesApplied, rolesSkipped, welcomed };
  }

  /** Grants every configured auto-role the bot is allowed to manage. */
  private async applyAutoRoles(
    request: MemberJoinRequest,
    config: GuildConfig["members"],
  ): Promise<string[]> {
    this.lastSkipped = [];
    if (config.autoRoleIds.length === 0) {
      return [];
    }

    const applied: string[] = [];
    for (const roleId of config.autoRoleIds) {
      if (!(await this.actions.canManageRole(roleId))) {
        // Reported, not thrown: a role above the bot's highest, deleted, or owned
        // by an integration is a configuration mistake the operator can fix, and
        // the member still deserves every other role.
        this.lastSkipped.push({ roleId, detail: "role is not manageable by the bot" });
        this.logger.warn("Skipped an auto-role the bot cannot manage", {
          guildId: request.guildId,
          userId: request.userId,
          roleId,
        });
        continue;
      }

      const result = await this.actions.addRole(
        request.userId,
        roleId,
        `Auto-role on join (${request.userId})`,
      );
      if (result.ok) {
        applied.push(roleId);
      } else {
        this.lastSkipped.push({ roleId, detail: result.detail ?? "unknown" });
        this.logger.warn("Failed to apply an auto-role", {
          guildId: request.guildId,
          userId: request.userId,
          roleId,
          detail: result.detail,
        });
      }
    }

    if (applied.length > 0) {
      await this.record(request, "members.autorole.applied", { roleIds: applied });
    }
    return applied;
  }

  /** Posts the configured welcome message, when both the toggle and channel are set. */
  private async sendWelcome(
    request: MemberJoinRequest,
    config: GuildConfig["members"],
  ): Promise<boolean> {
    if (!config.welcomeEnabled || config.welcomeChannelId === null) {
      return false;
    }

    const content = renderWelcome(config.welcomeMessage, request);
    const result = await this.actions.postWelcome(config.welcomeChannelId, content);
    if (!result.ok) {
      this.logger.warn("Failed to post the welcome message", {
        guildId: request.guildId,
        userId: request.userId,
        channelId: config.welcomeChannelId,
        detail: result.detail,
      });
      return false;
    }

    await this.record(request, "members.welcome.posted", { channelId: config.welcomeChannelId });
    return true;
  }

  /** Records an audit event, tolerating an absent audit service. */
  private async record(
    request: MemberJoinRequest,
    action: string,
    details: Record<string, unknown>,
  ): Promise<void> {
    if (!this.audit) {
      return;
    }
    await this.audit.record({
      guildId: request.guildId,
      action,
      category: "members",
      severity: "info",
      actorId: null,
      actorKind: "system",
      targetType: "member",
      targetId: request.userId,
      details,
    });
  }
}

/**
 * Substitutes the placeholders a welcome message may use.
 *
 * Three are supported and deliberately few: `{user}` (a mention), `{guild}` and
 * `{count}`. Unknown braces are left untouched rather than blanked, so an
 * operator who typed `{not-a-thing}` sees it and fixes it instead of silently
 * losing text.
 */
export function renderWelcome(template: string, request: MemberJoinRequest): string {
  return template
    .replace(/\{user\}/g, `<@${request.userId}>`)
    .replace(/\{guild\}/g, request.guildName)
    .replace(/\{count\}/g, String(request.memberCount));
}
