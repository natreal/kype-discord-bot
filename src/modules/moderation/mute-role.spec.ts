/**
 * The `Muted` role specification (V5).
 *
 * Before this file the Muted role was **resolved by name on every use**
 * (`discord-member-actions.ts` looks up `"muted"` on each call) and its
 * permissions were never inspected. Two failures followed from that:
 *
 *   1. renaming the role to `Silenced` made every `/mute` refuse, even though the
 *      role worked perfectly — the bot lost track of a role it had adopted;
 *   2. a role named `Muted` that *allowed* Send Messages passed every check while
 *      silencing nobody, so a moderator saw "muted" and the member kept talking.
 *
 * So the role needs two things a name can never provide: a **persisted identity**
 * (the `moderation.muted` setup resource key) and a **declared specification** of
 * what it must deny. This file is that specification, and it is deliberately pure:
 * it turns a role's current permissions into concrete differences with no Discord
 * call anywhere, so the rules are unit-testable.
 *
 * The invariant this file protects is that `@everyone`'s *default* permissions are
 * part of the target bitfield. Discord computes a member's permissions as
 * `@everyone | roles`, so a role that denies Send Messages only works if `@everyone`
 * does not grant it elsewhere. Reconciling against the guild's real `@everyone`
 * bitfield is what makes the deny effective rather than decorative.
 */
import { PermissionsBitField, PermissionFlagsBits } from "discord.js";

/** The name the role is created with, and the fallback adoption hint. */
export const MUTE_ROLE_NAME = "muted";

/**
 * Permissions the Muted role must deny outright.
 *
 * Denying `SendMessages` covers every channel type at once — text channels, threads
 * (which are channels), announcements, forums — because the role has no per-channel
 * overwrite to reopen a path. `SendMessagesInThreads` is denied separately: a
 * member who can already read a thread keeps posting in it otherwise, which is the
 * most common "the mute did nothing" report. The thread-creation permissions stop a
 * muted member from starting a new thread to talk in instead.
 */
export const MUTE_ROLE_DENIES: readonly bigint[] = [
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.SendMessagesInThreads,
  PermissionFlagsBits.CreatePublicThreads,
  PermissionFlagsBits.CreatePrivateThreads,
];

/**
 * Permissions the Muted role must additionally allow.
 *
 * `ViewChannel` and `ReadMessageHistory` are deliberately *granted*: a muted member
 * must still be able to read, otherwise the mute doubles as a channel ban and hiding
 * the channel from them looks like a misconfiguration. Granting them on the role
 * also satisfies the one hard Discord constraint on role permissions — a role's
 * allowed bits must be a subset of its own deny bits' complement, and a bare
 * deny-only role is rejected as inconsistent.
 */
export const MUTE_ROLE_ALLOWS: readonly bigint[] = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.ReadMessageHistory,
];

/**
 * Human-readable names, in the order they are shown to an operator.
 *
 * Explicit strings rather than values derived from the bitfields above, because this
 * output is read by a server owner, not a developer, and `PermissionsBitField`
 * renders these as `SendMessagesInThreads`-style identifiers inside a sentence.
 */
export const MUTE_ROLE_DENY_LABELS: Readonly<Record<string, string>> = {
  SendMessages: "Send Messages",
  SendMessagesInThreads: "Send Messages in Threads",
  CreatePublicThreads: "Create Public Threads",
  CreatePrivateThreads: "Create Private Threads",
};

/** One concrete difference between a role and the specification. */
export interface MuteRoleDifference {
  /** `permission`: a permission bit differs. `position`: the role is too high. */
  readonly kind: "permission" | "position";
  /** Stable key, safe to log and to assert on in tests. */
  readonly code: string;
  /** Sentence shown to the operator. */
  readonly detail: string;
}

/** Everything the diff needs to know about a role. */
export interface MuteRoleSnapshot {
  readonly id: string;
  readonly name: string;
  /**
   * The role's own allowed bitfield, before `@everyone` is considered.
   *
   * Accepted as `number` as well as `bigint` because discord.js has shipped both: the
   * value is normalized through {@link toBitfield}, so a caller can pass
   * `role.permissions.bitfield` without knowing which shape it is.
   */
  readonly permissionBitfield: bigint | number;
  readonly position: number;
  /** The bot's highest role position; the role must sit strictly below it. */
  readonly botHighestPosition: number;
}

/** What reconciling a role against the specification would have to change. */
export interface MuteRoleDiff {
  /** True when the role already satisfies every requirement. */
  readonly ok: boolean;
  /** The permission the role would end up with. */
  readonly targetBitfield: bigint;
  /** True when the permission change is more than a no-op write. */
  readonly permissionChangeNeeded: boolean;
  /** True when the role must be moved below the bot's highest role. */
  readonly positionChangeNeeded: boolean;
  readonly differences: readonly MuteRoleDifference[];
  /** Denied permissions that are currently absent, as display names. */
  readonly missingDenies: readonly string[];
}

/**
 * Normalizes a permission bitfield to a bigint.
 *
 * discord.js hands back `PermissionsBitField.bitfield` as a **number** in some
 * versions and a bigint in others, and mixing the two throws
 * `TypeError: Cannot mix BigInt and other types`. Every bitfield that enters this
 * module passes through here, so the arithmetic below is unambiguous regardless of
 * which shape the library produced.
 */
export function toBitfield(value: bigint | number): bigint {
  return typeof value === "bigint" ? value : BigInt(value);
}

/**
 * Computes the permission bitfield the Muted role should hold.
 *
 * `everyoneBitfield` is the guild's `@everyone` permissions, and it matters: a deny
 * on this role only stops a permission that `@everyone` does not already grant, so
 * the target has to be computed against real guild state rather than a constant.
 */
export function desiredMuteRoleBitfield(everyoneBitfield: bigint | number): bigint {
  const field = new PermissionsBitField(toBitfield(everyoneBitfield));
  field.add([...MUTE_ROLE_ALLOWS]);
  field.remove([...MUTE_ROLE_DENIES]);
  return field.bitfield;
}

/**
 * Narrows a desired bitfield to the bits the bot is allowed to write.
 *
 * The second hard Discord constraint: a role update whose permission bitfield
 * contains a bit the bot itself does not hold is rejected, *even when that bit is
 * now zero*. That makes the two available actions asymmetric, and the choice is
 * deliberate:
 *
 * - bits the bot **holds** are written exactly, so a forbidden permission the bot
 *   can see is genuinely cleared;
 * - bits the bot **does not hold** are carried over from the role's current value
 *   and left alone. A bot without `ManageGuild` therefore cannot clear an existing
 *   `ManageGuild` from the Muted role — and equally cannot add one.
 *
 * The consequence is honest and reportable rather than silent: the role may keep an
 * allow the specification does not sanction, and {@link diffMuteRole} reports it, so
 * the operator learns to grant the bot the missing permission instead of the bot
 * appearing to succeed.
 */
export function reconcileMuteRoleBitfield(
  desired: bigint,
  currentBitfield: bigint | number,
  botBitfield: bigint | number,
): bigint {
  const bot = toBitfield(botBitfield);
  return (desired & bot) | (toBitfield(currentBitfield) & ~bot);
}

/**
 * Compares a role against the specification.
 *
 * The inversion that makes this read strangely is Discord's role model: a role's
 * `permissions` field is its **allow** list, and a bit that is *absent* is the deny.
 * `MUTE_ROLE_DENIES` therefore names the permissions that must be **unset** on the
 * role — so "the role denies Send Messages" is tested with `current.has(SEND) === false`,
 * not `true`. Getting this backwards is precisely how the original bug produced a
 * `Muted` role that silenced nobody while every check passed.
 *
 * Pure and synchronous so the diagnostic, the setup reconciliation and the tests all
 * reason from one function — there is exactly one definition of "the Muted role is
 * correct".
 */
export function diffMuteRole(
  snapshot: MuteRoleSnapshot,
  everyoneBitfield: bigint | number,
  botBitfield: bigint | number,
): MuteRoleDiff {
  const current = new PermissionsBitField(toBitfield(snapshot.permissionBitfield));
  const desiredBitfield = desiredMuteRoleBitfield(everyoneBitfield);
  const targetBitfield = reconcileMuteRoleBitfield(
    desiredBitfield,
    current.bitfield,
    botBitfield,
  );
  const bot = toBitfield(botBitfield);

  const differences: MuteRoleDifference[] = [];
  const missingDenies: string[] = [];
  const target = new PermissionsBitField(targetBitfield);

  for (const permission of MUTE_ROLE_DENIES) {
    const name = permissionName(permission);
    if (current.has(permission)) {
      missingDenies.push(name);
      differences.push({
        kind: "permission",
        code: `deny-missing:${name}`,
        detail:
          (bot & permission) !== 0n
            ? `\`@${snapshot.name}\` allows \`${name}\`, so the mute does not actually stop them; setup will remove it.`
            : `\`@${snapshot.name}\` allows \`${name}\`, and the bot lacks \`${name}\` so it cannot remove it itself. Grant the bot \`${name}\`, or clear that permission on the role by hand.`,
      });
    }
  }

  // A permission the specification does not sanction is reported whatever the bot can
  // do about it, because an unexpected allow on the Muted role is how it stops
  // silencing people. The distinction between "the bot will clear this" and "the bot
  // cannot clear this" is carried by the detail sentence, so the operator always knows
  // whether running setup again is enough.
  for (const permission of sanctionedMutePermissions(everyoneBitfield)) {
    const name = permissionName(permission);
    if (current.has(permission) && !hasBit(desiredBitfield, permission)) {
      differences.push({
        kind: "permission",
        code: `allow-unexpected:${name}`,
        detail:
          (bot & permission) !== 0n
            ? `\`@${snapshot.name}\` allows \`${name}\`, which the mute specification does not grant; setup will remove it.`
            : `\`@${snapshot.name}\` allows \`${name}\`, and the bot lacks \`${name}\` so it cannot remove it. Grant the bot \`${name}\` if that allow is not intended.`,
      });
    }
  }

  const permissionChangeNeeded = current.bitfield !== target.bitfield;
  const positionChangeNeeded = snapshot.position >= snapshot.botHighestPosition;
  if (positionChangeNeeded) {
    differences.push({
      kind: "position",
      code: "position-too-high",
      detail: `\`@${snapshot.name}\` sits at or above the bot's highest role, so the bot cannot assign it.`,
    });
  }

  return {
    ok: differences.length === 0,
    targetBitfield,
    permissionChangeNeeded,
    positionChangeNeeded,
    differences,
    missingDenies,
  };
}

/** @returns the display name of a single-permission bitfield. */
export function permissionName(permission: bigint): string {
  const [name] = new PermissionsBitField(permission).toArray();
  return name ?? String(permission);
}

/**
 * @returns true when `bitfield` contains `permission`.
 *
 * A raw bitwise test rather than `PermissionsBitField#has`, because every value here
 * is already a resolved bigint and the string-based lookup path is a source of the
 * exact misresolution this module exists to avoid.
 */
export function hasBit(bitfield: bigint, permission: bigint): boolean {
  return (bitfield & permission) !== 0n;
}

/**
 * @returns the permissions a correct Muted role is allowed to hold.
 *
 * Everything `@everyone` grants plus `ViewChannel`/`ReadMessageHistory`, minus the
 * denies. This is the allow-list the diff reports against, so an operator sees an
 * unexpected `ManageGuild` on the Muted role called out by name.
 *
 * The `.add()`/`.remove()` array overloads are safe here because discord.js resolves
 * each member through `PermissionsBitField.resolve()`, which handles a bigint
 * correctly. The *constructor* array form is not: `new PermissionsBitField([0x10000000n])`
 * coerces the bigint to the string `"10000000"` and resolves it as the decimal
 * `Administrator` bit. Every construction in this file therefore starts from a bigint.
 * `tests/mute-role.test.ts` pins both behaviours.
 */
function sanctionedMutePermissions(everyoneBitfield: bigint | number): readonly bigint[] {
  const denied = new Set<bigint>(MUTE_ROLE_DENIES);
  const field = new PermissionsBitField(toBitfield(everyoneBitfield));
  field.add([...MUTE_ROLE_ALLOWS]);
  return field
    .toArray()
    .map((name) => PermissionsBitField.resolve(name))
    .filter((bit) => !denied.has(bit));
}
