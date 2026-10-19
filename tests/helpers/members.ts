/**
 * In-memory collaborators for the member onboarding tests.
 *
 * Only the external system is faked: `MemberOnboardingService` under test is the
 * production one, and so is `renderWelcome`. The fake records every call, because
 * two of the module's guarantees are about *not* calling Discord — one
 * unmanageable role must not stop the others, and a disabled welcome must not
 * post anything.
 */
import type {
  GuildMemberOnboardingActions,
  MemberActionResult,
} from "../../src/modules/members/index.js";

/** State a test can combine and then assert against. */
export interface FakeMemberActions extends GuildMemberOnboardingActions {
  /** Role IDs granted per user, in order. */
  readonly granted: Map<string, string[]>;
  /** Channel IDs the welcome message was posted to, in order. */
  readonly welcomes: { channelId: string; content: string }[];
  /** Every `addRole` call, including failed ones, for exact assertions. */
  readonly attempts: { userId: string; roleId: string }[];
  /** Roles the bot is allowed to manage; anything else is skipped by the service. */
  setManageable(roleIds: readonly string[]): void;
  /** Makes `addRole` fail for a specific role, as Discord would for a bad hierarchy. */
  failRole(roleId: string, detail?: string): void;
  /** Makes `postWelcome` fail for a specific channel, as a deleted channel would. */
  failChannel(channelId: string, detail?: string): void;
}

/** Builds a fake adapter. One per test. */
export function fakeMemberActions(): FakeMemberActions {
  const manageable = new Set<string>();
  const failingRoles = new Map<string, string>();
  const failingChannels = new Map<string, string>();
  const granted = new Map<string, string[]>();
  const welcomes: { channelId: string; content: string }[] = [];
  const attempts: { userId: string; roleId: string }[] = [];

  return {
    granted,
    welcomes,
    attempts,

    setManageable(roleIds) {
      manageable.clear();
      for (const roleId of roleIds) {
        manageable.add(roleId);
      }
    },

    failRole(roleId, detail) {
      failingRoles.set(roleId, detail ?? "I am missing the required permission");
    },

    failChannel(channelId, detail) {
      failingChannels.set(channelId, detail ?? "it no longer exists");
    },

    async canManageRole(roleId) {
      return manageable.has(roleId);
    },

    async addRole(userId, roleId): Promise<MemberActionResult> {
      attempts.push({ userId, roleId });
      const failure = failingRoles.get(roleId);
      if (failure) {
        return { ok: false, detail: failure };
      }
      const roles = granted.get(userId) ?? [];
      if (!roles.includes(roleId)) {
        // Mirrors Discord: adding a role a member already holds is a no-op, not a
        // second grant. The service assumes each role is attempted once, but the
        // fake stays honest about the real outcome.
        roles.push(roleId);
      }
      granted.set(userId, roles);
      return { ok: true };
    },

    async postWelcome(channelId, content): Promise<MemberActionResult> {
      const failure = failingChannels.get(channelId);
      if (failure) {
        return { ok: false, detail: failure };
      }
      welcomes.push({ channelId, content });
      return { ok: true };
    },
  };
}

/**
 * Reads a `members` configuration section from a partial object, filling the
 * schema defaults. Keeps a test's intent visible: only the fields it cares about.
 */
export function membersConfig(
  overrides: Partial<{
    welcomeEnabled: boolean;
    welcomeChannelId: string | null;
    welcomeMessage: string;
    autoRoleIds: string[];
  }> = {},
): {
  welcomeEnabled: boolean;
  welcomeChannelId: string | null;
  welcomeMessage: string;
  autoRoleIds: string[];
} {
  return {
    welcomeEnabled: false,
    welcomeChannelId: null,
    welcomeMessage: "Welcome {user} to {guild}!",
    autoRoleIds: [],
    ...overrides,
  };
}
