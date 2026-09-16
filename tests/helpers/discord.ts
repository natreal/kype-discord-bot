/**
 * Minimal stubs for the Discord objects the permission service inspects.
 *
 * Only the members of `GuildMember` that the service actually reads are
 * implemented, so tests stay readable and do not need a gateway connection.
 */
import { PermissionsBitField, type GuildMember } from "discord.js";

export interface MemberStubOptions {
  /** Guild-owner ID. Defaults to a different ID than the member. */
  readonly ownerId?: string;
  readonly memberId?: string;
  /** Discord permissions granted to the member. */
  readonly permissions?: bigint | readonly bigint[];
}

/** Creates a `GuildMember`-shaped object usable by `PermissionService`. */
export function memberStub(options: MemberStubOptions = {}): GuildMember {
  const memberId = options.memberId ?? "111111111111111111";
  const permissions = new PermissionsBitField(options.permissions ?? []);

  return {
    id: memberId,
    permissions,
    guild: { ownerId: options.ownerId ?? "999999999999999999" },
  } as unknown as GuildMember;
}
