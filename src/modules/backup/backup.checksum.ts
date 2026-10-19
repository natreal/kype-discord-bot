/**
 * Checksum helpers for snapshots.
 *
 * A restore that half-applies a corrupt payload is worse than one that refuses:
 * the operator believes the server is back, and the missing half is only noticed
 * later. So every snapshot carries a SHA-256 over a *canonical* serialization, and
 * the restore verifies it before touching Discord.
 *
 * `canonicalJson` sorts object keys recursively. `JSON.stringify` preserves
 * insertion order, so two structurally identical payloads stored through different
 * code paths would otherwise hash differently and a legitimate snapshot would be
 * rejected.
 */
import { createHash } from "node:crypto";

import type { BackupPayload } from "./backup.types.js";

/** @returns a deterministic JSON string, with object keys sorted. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

/** @returns `value` with every object's keys in sorted order, recursively. */
function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sortValue(entry));
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
    return Object.fromEntries(entries.map(([key, entry]) => [key, sortValue(entry)]));
  }
  return value;
}

/** @returns the SHA-256 of a payload's canonical form. */
export function payloadChecksum(payload: BackupPayload): string {
  return createHash("sha256").update(canonicalJson(payload)).digest("hex");
}

/** @returns true when `payload` still hashes to `checksum`. */
export function verifyChecksum(payload: BackupPayload, checksum: string | null): boolean {
  if (checksum === null) {
    // A snapshot written before checksums existed is accepted: refusing it would
    // make an operator's own backups unrestorable for no security gain, since the
    // row is already scoped to their guild.
    return true;
  }
  return payloadChecksum(payload) === checksum;
}
