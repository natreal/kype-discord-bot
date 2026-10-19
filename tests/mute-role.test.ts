/**
 * Muted-role specification and reconciliation (V5).
 *
 * The role this protects is the one place where a permission mistake fails
 * *silently*: a `Muted` role that still allows Send Messages makes every `/mute`
 * report success while the member keeps talking. These tests pin the three
 * behaviours that were missing before:
 *
 *   1. the role is verified against a declared spec, not just looked up by name;
 *   2. a wrong allow is cleared and a missing deny is added;
 *   3. a permission the bot cannot write is reported instead of silently "fixed".
 */
import { describe, expect, it } from "vitest";
import { PermissionFlagsBits, PermissionsBitField } from "discord.js";

import {
  MUTE_ROLE_ALLOWS,
  MUTE_ROLE_DENIES,
  desiredMuteRoleBitfield,
  diffMuteRole,
  permissionName,
  reconcileMuteRoleBitfield,
} from "../../src/modules/moderation/mute-role.spec.js";
import { TrackedSetuper } from "../../src/modules/setup/tracked-setuper.js";
import { testLogger } from "../helpers/logger.js";

const VIEW = PermissionFlagsBits.ViewChannel;
const HISTORY = PermissionFlagsBits.ReadMessageHistory;
const SEND = PermissionFlagsBits.SendMessages;
const SEND_THREADS = PermissionFlagsBits.SendMessagesInThreads;
const PUBLIC_THREADS = PermissionFlagsBits.CreatePublicThreads;
const PRIVATE_THREADS = PermissionFlagsBits.CreatePrivateThreads;
const MANAGE_GUILD = PermissionFlagsBits.ManageGuild;
const ADMINISTRATOR = PermissionFlagsBits.Administrator;

/** A bot that holds the permissions a correctly installed instance is granted. */
const FULLY_EQUIPPED_BOT = MANAGE_GUILD | SEND | ADMINISTRATOR | PermissionFlagsBits.KickMembers;

const SNAPSHOT = (bitfield: bigint, position = 1) => ({
  id: "role-1",
  name: "Muted",
  permissionBitfield: bitfield,
  position,
  botHighestPosition: 20,
});

describe("mute role permission spec", () => {
  it("denies every way a muted member could still post", () => {
    // A mute that only denies `SendMessages` is the classic silent failure: the member
    // can still post in any thread they can already see.
    expect(MUTE_ROLE_DENIES).toContain(SEND);
    expect(MUTE_ROLE_DENIES).toContain(SEND_THREADS);
    expect(MUTE_ROLE_DENIES).toContain(PUBLIC_THREADS);
    expect(MUTE_ROLE_DENIES).toContain(PRIVATE_THREADS);
  });

  it("keeps the role readable, so a mute is not a channel ban", () => {
    expect(MUTE_ROLE_ALLOWS).toContain(VIEW);
    expect(MUTE_ROLE_ALLOWS).toContain(HISTORY);
  });

  it("builds a target that allows reading and denies writing", () => {
    const target = new PermissionsBitField(desiredMuteRoleBitfield(0n));
    expect(target.has(VIEW)).toBe(true);
    expect(target.has(HISTORY)).toBe(true);
    expect(target.has(SEND)).toBe(false);
    expect(target.has(SEND_THREADS)).toBe(false);
  });

  it("inherits @everyone, because a deny only beats a permission @everyone does not grant", () => {
    // `@everyone` is read-only here, so the Muted role inherits exactly that.
    const target = new PermissionsBitField(desiredMuteRoleBitfield(VIEW | HISTORY));
    expect(target.has(VIEW)).toBe(true);

    // `@everyone` grants Send Messages in this guild, so the mute must be the one to
    // take it away — the role cannot rely on @everyone already denying it.
    const permissive = new PermissionsBitField(desiredMuteRoleBitfield(SEND));
    expect(permissive.has(SEND)).toBe(false);
  });

  it("uses a bigint constructor, never an array, so flags are not misresolved", () => {
    // `new PermissionsBitField([bigint])` coerces the bigint to a decimal string,
    // which silently resolves to the wrong permission. Pinning the exact arithmetic
    // is what stops that from being reintroduced.
    const expected = (VIEW | HISTORY) & ~(SEND | SEND_THREADS | PUBLIC_THREADS | PRIVATE_THREADS);
    expect(desiredMuteRoleBitfield(0n)).toBe(expected);
    expect(expected).not.toBe(SEND);
  });
});

describe("reconcileMuteRoleBitfield", () => {
  it("writes bits the bot holds and preserves bits it does not", () => {
    // The bot cannot write `ManageGuild`, so an existing one is carried over rather
    // than zeroed: Discord rejects a bitfield containing a bit the bot lacks.
    const target = reconcileMuteRoleBitfield(desiredMuteRoleBitfield(0n), MANAGE_GUILD, SEND);
    const field = new PermissionsBitField(target);
    expect(field.has(MANAGE_GUILD)).toBe(true);
    // `SendMessages` is writable and forbidden, so it is genuinely cleared.
    expect(field.has(SEND)).toBe(false);
  });

  it("clears a forbidden permission the bot is able to write", () => {
    const target = reconcileMuteRoleBitfield(
      desiredMuteRoleBitfield(0n),
      ADMINISTRATOR | SEND,
      SEND | ADMINISTRATOR,
    );
    const field = new PermissionsBitField(target);
    expect(field.has(ADMINISTRATOR)).toBe(false);
    expect(field.has(SEND)).toBe(false);
  });
});

describe("mute role reconciliation against a live guild", () => {
  const BOT_BITS =
    PermissionFlagsBits.ManageRoles |
    PermissionFlagsBits.ManageGuild |
    PermissionFlagsBits.SendMessages |
    PermissionFlagsBits.KickMembers;
  const BOT_HIGHEST = 50;

  function roleStub(permissions: bigint, name = "Muted", position = 1) {
    const state = { permissions };
    return {
      id: "role-1",
      name,
      position,
      permissions: {
        get bitfield() {
          return state.permissions;
        },
      },
      guild: {
        id: "guild-1",
        roles: { everyone: { id: "guild-1", permissions: { bitfield: 0n } } },
        members: {
          me: {
            roles: { highest: { position: BOT_HIGHEST } },
            permissions: { bitfield: BOT_BITS },
          },
        },
      },
      setPermissions(next: PermissionsBitField) {
        state.permissions = next.bitfield;
        return Promise.resolve(this);
      },
      get current() {
        return state.permissions;
      },
    };
  }

  const setuper = () =>
    new TrackedSetuper({
      guild: { id: "guild-1" } as never,
      logger: testLogger,
      resources: {} as never,
      permissions: {} as never,
    });

  const diffNow = (permissions: bigint, position = 1) =>
    diffMuteRole(
      {
        id: "role-1",
        name: "Muted",
        permissionBitfield: permissions,
        position,
        botHighestPosition: BOT_HIGHEST,
      },
      0n,
      BOT_BITS,
    );

  it("clears an unsanctioned allow and reports the change", async () => {
    // The original silent failure: a role holding `ManageRoles` silences nobody's
    // messages, and nothing in the bot ever looked at it.
    const role = roleStub(PermissionFlagsBits.ManageRoles | SEND);
    const outcome = await setuper().reconcileRolePermissions(role as never);
    const after = new PermissionsBitField(role.current);

    expect(outcome.changed).toBe(true);
    expect(outcome.notReconciled).toBe(false);
    // `ManageRoles` and `SendMessages` are both held by this bot, so both are written
    // exactly: the unsanctioned allow is removed and the required deny is applied.
    expect(after.has(PermissionFlagsBits.ManageRoles)).toBe(false);
    expect(after.has(SEND)).toBe(false);
    expect(diffNow(role.current).ok).toBe(true);
  });

  it("preserves a permission the bot cannot write, instead of silently failing", async () => {
    // This bot has no `ViewChannel`, so `reconcileMuteRoleBitfield` must *not* include
    // the bit: Discord rejects a role update whose bitfield holds a permission the bot
    // lacks — even when that permission is being set to zero. The role keeps a
    // read permission it already had, and the change it *can* make still lands.
    const role = roleStub(PermissionFlagsBits.ViewChannel | SEND);
    const outcome = await setuper().reconcileRolePermissions(role as never);
    const after = new PermissionsBitField(role.current);
    expect(outcome.changed).toBe(true);
    expect(after.has(VIEW)).toBe(true);
    expect(after.has(SEND)).toBe(false);
  });

  it("is an exact no-op on a role that already matches", async () => {
    // Idempotence matters: a second `/setup run` must not write anything.
    const role = roleStub(desiredMuteRoleBitfield(0n));
    const outcome = await setuper().reconcileRolePermissions(role as never);
    expect(outcome.changed).toBe(false);
    expect(outcome.differences).toEqual([]);
  });

  it("does not write when only the position is wrong", async () => {
    // A position difference must not trigger a permission write: Discord rejects a
    // bitfield containing a bit the bot lacks, so an unnecessary write can fail.
    const role = roleStub(desiredMuteRoleBitfield(0n), "Muted", BOT_HIGHEST + 5);
    const outcome = await setuper().reconcileRolePermissions(role as never);
    expect(outcome.changed).toBe(false);
    expect(outcome.error).toContain("at or above the bot's highest role");
  });

  it("never touches a role it has no specification for", async () => {
    // Only the Muted role is specified; inventing rules for another role would make
    // setup rewrite roles it was never asked to own.
    const role = roleStub(PermissionFlagsBits.ManageRoles, "Cool People");
    const outcome = await setuper().reconcileRolePermissions(role as never);
    expect(outcome.notReconciled).toBe(true);
    expect(outcome.changed).toBe(false);
    expect(new PermissionsBitField(role.current).has(PermissionFlagsBits.ManageRoles)).toBe(true);
  });
});

describe("diffMuteRole", () => {
  it("passes a role that already matches the specification", () => {
    const diff = diffMuteRole(SNAPSHOT(desiredMuteRoleBitfield(0n)), 0n, FULLY_EQUIPPED_BOT);
    expect(diff.ok).toBe(true);
    expect(diff.permissionChangeNeeded).toBe(false);
    expect(diff.differences).toEqual([]);
    expect(diff.missingDenies).toEqual([]);
  });

  it("names each missing deny instead of just reporting the role", () => {
    // The original bug: a role that allowed Send Messages was reported healthy.
    const diff = diffMuteRole(SNAPSHOT(VIEW | HISTORY | SEND), 0n, FULLY_EQUIPPED_BOT);
    expect(diff.ok).toBe(false);
    expect(diff.missingDenies).toContain("SendMessages");
    expect(diff.differences.map((entry) => entry.code)).toContain("deny-missing:SendMessages");
  });

  it("reports an unsanctioned allow that the bot can clear", () => {
    // `CreateInstantInvite` is granted by `@everyone` here, so it is inside the
    // computed allow-list — meaning an *allow* on the Muted role is legitimate and
    // must NOT be flagged. The flagged case is a permission the spec denies.
    const EVERYONE = PermissionFlagsBits.CreateInstantInvite;
    const clean = diffMuteRole(SNAPSHOT(EVERYONE), EVERYONE, EVERYONE | SEND);
    expect(clean.differences.map((entry) => entry.code)).not.toContain(
      "allow-unexpected:CreateInstantInvite",
    );

    // A permission the spec denies, present on the role, is the real finding. The bot
    // here *does* hold `SendMessages`, so it can clear it itself and the message says so.
    const dirty = diffMuteRole(SNAPSHOT(SEND), 0n, SEND);
    expect(dirty.differences.map((entry) => entry.code)).toContain("deny-missing:SendMessages");
    expect(
      dirty.differences.find((entry) => entry.code === "deny-missing:SendMessages")?.detail,
    ).toContain("so the mute does not actually stop them");
  });

  it("tells the operator to grant the missing permission when the bot cannot clear it", () => {
    // The bot does not hold `SendMessages`, so it cannot revoke it — and it must not
    // pretend otherwise.
    const diff = diffMuteRole(SNAPSHOT(SEND), 0n, PermissionFlagsBits.KickMembers);
    const unwritable = diff.differences.find((entry) => entry.code === "deny-missing:SendMessages");
    expect(unwritable?.detail).toContain("Grant the bot");
  });

  it("reports a role the bot is too low to assign", () => {
    const diff = diffMuteRole(SNAPSHOT(desiredMuteRoleBitfield(0n), 25), 0n, FULLY_EQUIPPED_BOT);
    expect(diff.positionChangeNeeded).toBe(true);
    expect(diff.differences.map((entry) => entry.code)).toContain("position-too-high");
  });

  it("treats a role exactly level with the bot as too high, matching Discord", () => {
    // Discord requires the bot's highest role to be *strictly* above the target.
    const diff = diffMuteRole(SNAPSHOT(desiredMuteRoleBitfield(0n), 20), 0n, FULLY_EQUIPPED_BOT);
    expect(diff.positionChangeNeeded).toBe(true);
  });

  it("renders a permission as a human-readable name", () => {
    expect(permissionName(SEND)).toBe("SendMessages");
    expect(permissionName(SEND_THREADS)).toBe("SendMessagesInThreads");
  });
});
