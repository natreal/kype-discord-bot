/**
 * Setup resource identity service.
 *
 * Setup must never identify a resource by its name: administrators rename
 * channels, two guilds can both have a `#welcome`, and a renamed `#logs` would
 * otherwise be recreated as a duplicate. The `setup_resources` table stores the
 * Discord ID per `(guildId, key)`, and this service is the only component that
 * reads or writes it.
 *
 * Resolution strategy (the idempotency contract):
 *
 *   1. look up the stored Discord ID for `(guildId, key)`;
 *   2. verify that the resource still exists on Discord;
 *   3. if it does → reuse it;
 *   4. if it does not → adopt a resource with the expected name (covers a channel
 *      that was deleted and recreated by hand), otherwise create a new one;
 *   5. persist the resulting Discord ID, repairing stale state.
 *
 * Every persistence path tolerates failure: a database error is logged and
 * swallowed, because the Discord resource does exist and the next run will adopt
 * it by name. Turning a successful setup into a reported failure would help nobody.
 */
import type { CategoryChannel, Guild, Role, TextChannel } from "discord.js";

import { DiscordApiError, ValidationError } from "../../utils/errors.js";
import type { Logger } from "../../services/logger/index.js";
import type {
  SetupResourceDefinition,
  SetupResourceRecord,
  SetupResourceType,
  TrackedResolution,
} from "../setup.types.js";
import { isSetupResourceType } from "../setup.types.js";

/** Minimal persistence port, so the service is testable without PostgreSQL. */
export interface SetupResourceRepository {
  list(guildId: string): Promise<SetupResourceRecord[]>;
  find(guildId: string, key: string): Promise<SetupResourceRecord | null>;
  remember(record: SetupResourceRecord): Promise<void>;
  forget(guildId: string, key: string): Promise<void>;
}

/** Discord-side operations, injected so tests can simulate a live guild. */
export interface SetupResourceDiscordAdapter {
  findChannelById(channelId: string): Promise<CategoryChannel | TextChannel | null>;
  findChannelByName(
    name: string,
    parentId: string | null,
  ): Promise<CategoryChannel | TextChannel | null>;
  createChannel(
    definition: SetupResourceDefinition,
    parentId: string | null,
  ): Promise<CategoryChannel | TextChannel>;
  findRoleById(roleId: string): Promise<Role | null>;
  findRoleByName(name: string): Promise<Role | null>;
  createRole(definition: SetupResourceDefinition): Promise<Role>;
}

export interface SetupResourceServiceOptions {
  readonly guild: Guild;
  readonly repository: SetupResourceRepository;
  readonly discord: SetupResourceDiscordAdapter;
  readonly logger: Logger;
  /**
   * Milliseconds to wait before adopting a concurrent run's resource after a
   * failed creation attempt.
   *
   * Discord rejects a duplicate channel name, but the *other* run may not have
   * persisted its ID yet. Defaults to 0 so unit tests stay fast; the production
   * wiring sets a small value.
   */
  readonly raceWaitMs?: number;
}

/** Default wait used by the production wiring. */
export const DEFAULT_RACE_WAIT_MS = 250;

/** A stored reference whose Discord resource no longer exists. */
export interface StaleResource {
  readonly key: string;
  readonly type: SetupResourceType;
  readonly discordId: string;
  readonly name: string | null;
}

export class SetupResourceService {
  private readonly guild: Guild;
  private readonly repository: SetupResourceRepository;
  private readonly discord: SetupResourceDiscordAdapter;
  private readonly logger: Logger;
  private readonly raceWaitMs: number;

  public constructor(options: SetupResourceServiceOptions) {
    this.guild = options.guild;
    this.repository = options.repository;
    this.discord = options.discord;
    this.logger = options.logger.child(`setup-resources:${options.guild.id}`);
    this.raceWaitMs = options.raceWaitMs ?? 0;
  }

  /** @returns every stored resource identity for the guild. */
  public list(): Promise<SetupResourceRecord[]> {
    return this.repository.list(this.guild.id);
  }

  /** @returns the stored identity for `key`, or `null`. */
  public find(key: string): Promise<SetupResourceRecord | null> {
    return this.repository.find(this.guild.id, key);
  }

  /** @returns the stored Discord ID for `key`, or `null`. */
  public async resolve(key: string): Promise<string | null> {
    const record = await this.repository.find(this.guild.id, key);
    return record?.discordId ?? null;
  }

  /**
   * Resolves and persists the channel described by `definition`.
   *
   * Roles take a separate path (`ensureRoleDefinition`) because Discord exposes them
   * through a different API; keeping the two explicit avoids a union type leaking
   * into every caller.
   */
  public ensure<TChannel extends CategoryChannel | TextChannel = TextChannel>(
    definition: SetupResourceDefinition,
    parentId: string | null = null,
  ): Promise<TrackedResolution<TChannel>> {
    return this.resolveChannel(definition, parentId) as Promise<TrackedResolution<TChannel>>;
  }

  /** Resolves and persists a managed role. */
  public ensureRoleDefinition(
    definition: SetupResourceDefinition,
  ): Promise<TrackedResolution<Role>> {
    return this.repository
      .find(this.guild.id, definition.key)
      .then((record) => this.ensureRole(definition, record?.discordId ?? null));
  }

  /**
   * Resolves and persists the channel described by `definition`.
   *
   * Expected conditions (missing permissions, a deleted channel, an unreachable
   * database) surface as thrown Discord/App errors that the calling setup action
   * converts into a failed entry. Only genuine programming errors — an unsupported
   * resource type — throw outright with a validation error.
   */
  private async resolveChannel(
    definition: SetupResourceDefinition,
    parentId: string | null,
  ): Promise<TrackedResolution<CategoryChannel | TextChannel>> {
    if (!isSetupResourceType(definition.type)) {
      throw new ValidationError(`Unsupported setup resource type: ${String(definition.type)}`, {
        key: definition.key,
      });
    }
    if (definition.type === "ROLE") {
      throw new ValidationError("Use ensureRoleDefinition() for role resources", {
        key: definition.key,
      });
    }

    const stored = await this.repository.find(this.guild.id, definition.key);
    const previousId = stored?.discordId ?? null;
    const previousName = stored?.name ?? null;

    // 1. Known identity: reuse the channel when it is still there.
    if (previousId) {
      const existing = await this.discord.findChannelById(previousId);
      if (existing) {
        // The administrator may have renamed the channel. Refreshing the stored
        // name keeps future name-based adoption accurate without touching Discord.
        if (previousName !== existing.name) {
          await this.remember(definition, existing.id, existing.name, false);
          this.logger.debug("Refreshed the stored name of a renamed resource", {
            key: definition.key,
            discordId: existing.id,
            name: existing.name,
          });
        }
        return {
          resource: existing,
          created: false,
          origin: "reused",
          repaired: false,
          previousId,
        };
      }

      // 2. Stale reference: the channel was deleted while the bot was away.
      this.logger.warn("Stored setup resource is missing on Discord; recovering", {
        key: definition.key,
        staleId: previousId,
        type: definition.type,
      });
      return this.recoverChannel(definition, parentId, previousId);
    }

    // 3. No usable ID, but the previous run recorded a name: the channel may have
    //    been recreated with a different name or moved to another category. Looking
    //    it up first is what prevents a duplicate after a hand-made change.
    if (
      previousName &&
      previousName.trim().toLowerCase() !== definition.name.trim().toLowerCase()
    ) {
      const renamed = await this.discord.findChannelByName(previousName, parentId);
      if (renamed) {
        await this.remember(definition, renamed.id, renamed.name, true);
        this.logger.info("Re-adopted a setup resource whose name changed", {
          key: definition.key,
          discordId: renamed.id,
          storedName: previousName,
        });
        return {
          resource: renamed,
          created: false,
          origin: "recovered",
          repaired: true,
          previousId: null,
          detail: `re-adopted the resource previously named "${previousName}"`,
        };
      }
    }

    // 4. No identity yet: adopt an existing channel before creating anything, so
    //    a server that already has `#welcome` never receives a second one.
    const adopted = await this.discord.findChannelByName(definition.name, parentId);
    if (adopted) {
      await this.remember(definition, adopted.id, adopted.name, false);
      this.logger.info("Adopted an existing resource during setup", {
        key: definition.key,
        discordId: adopted.id,
      });
      return {
        resource: adopted,
        created: false,
        origin: "reused",
        repaired: false,
        previousId: null,
        detail: "matched an existing resource by name",
      };
    }

    return this.createTracked(definition, parentId, null, "created");
  }

  /**
   * Recovers a channel whose stored ID is stale.
   *
   * Adoption by the expected name is preferred over creation: the administrator
   * may have deleted and manually recreated the channel, and recreating ours would
   * produce exactly the `#server-logs` / `#server-logs-2` duplication that setup
   * is required never to cause.
   */
  private async recoverChannel(
    definition: SetupResourceDefinition,
    parentId: string | null,
    previousId: string,
  ): Promise<TrackedResolution<CategoryChannel | TextChannel>> {
    const existing = await this.discord.findChannelByName(definition.name, parentId);
    if (existing) {
      await this.remember(definition, existing.id, existing.name, true);
      this.logger.info("Recovered setup resource by name", {
        key: definition.key,
        discordId: existing.id,
      });
      return {
        resource: existing,
        created: false,
        origin: "recovered",
        repaired: true,
        previousId,
        detail: "the stored reference was replaced by a resource with the expected name",
      };
    }

    return this.createTracked(definition, parentId, previousId, "recovered");
  }

  /**
   * Creates a channel while tolerating a concurrent resolver winning the race.
   *
   * Two setup runs can resolve the same key at the same time. The database's
   * `(guildId, key)` uniqueness is the durable guard, but the Discord-side check
   * lives here: if another run created the channel between our lookup and our
   * creation attempt, the loser re-reads the identity table, adopts the winner's ID
   * and reports `reused` instead of creating `#welcome-2`.
   */
  private async createTracked(
    definition: SetupResourceDefinition,
    parentId: string | null,
    previousId: string | null,
    from: "created" | "recovered",
  ): Promise<TrackedResolution<CategoryChannel | TextChannel>> {
    try {
      const created = await this.discord.createChannel(definition, parentId);
      await this.remember(definition, created.id, created.name, from === "recovered");
      if (from === "recovered") {
        this.logger.info("Recreated a missing setup resource", {
          key: definition.key,
          discordId: created.id,
        });
      }
      return {
        resource: created,
        created: true,
        origin: from,
        repaired: from === "recovered",
        previousId,
        ...(from === "recovered"
          ? { detail: "the stored resource was missing on Discord; a replacement was created" }
          : {}),
      };
    } catch (error) {
      // Wait for a concurrent writer to commit, then adopt its result. The pause
      // only exists to cover the window between Discord observing a create and the
      // other run persisting the new ID; it is skipped in tests.
      if (this.raceWaitMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.raceWaitMs));
      }
      const adopted = await this.adoptAfterRace(definition, parentId);
      if (adopted) {
        this.logger.info("Another setup run resolved this resource first; adopting it", {
          key: definition.key,
          discordId: adopted.id,
        });
        return {
          resource: adopted,
          created: false,
          origin: "reused",
          repaired: false,
          previousId,
          detail: "another setup run resolved this resource concurrently",
        };
      }
      throw error;
    }
  }

  /** Re-reads the identity table after a failed creation attempt. */
  private async adoptAfterRace(
    definition: SetupResourceDefinition,
    parentId: string | null,
  ): Promise<CategoryChannel | TextChannel | null> {
    const stored = await this.repository.find(this.guild.id, definition.key);
    if (stored?.discordId) {
      const byId = await this.discord.findChannelById(stored.discordId);
      if (byId) {
        return byId;
      }
    }
    return this.discord.findChannelByName(definition.name, parentId);
  }

  /** Ensures a managed role, using the same identity rules as channels. */
  private async ensureRole(
    definition: SetupResourceDefinition,
    previousId: string | null,
  ): Promise<TrackedResolution<Role>> {
    if (previousId) {
      const existing = await this.discord.findRoleById(previousId);
      if (existing) {
        return {
          resource: existing,
          created: false,
          origin: "reused",
          repaired: false,
          previousId,
        };
      }
      this.logger.warn("Stored setup role is missing on Discord; recovering", {
        key: definition.key,
        staleId: previousId,
      });
    }

    const existing = await this.discord.findRoleByName(definition.name);
    if (existing) {
      await this.remember(definition, existing.id, existing.name, previousId !== null);
      return {
        resource: existing,
        created: false,
        origin: previousId === null ? "reused" : "recovered",
        repaired: previousId !== null,
        previousId,
      };
    }

    try {
      const created = await this.discord.createRole(definition);
      await this.remember(definition, created.id, created.name, previousId !== null);
      return {
        resource: created,
        created: true,
        origin: previousId === null ? "created" : "recovered",
        repaired: previousId !== null,
        previousId,
      };
    } catch (error) {
      // Without this, a guild where the bot may not manage roles reports a bare
      // "the resource could not be resolved": the raw Discord failure was thrown past
      // every layer that could describe it, so the operator had no way to know which
      // permission was missing.
      throw new DiscordApiError(`Role "${definition.name}" could not be created`, {
        cause: error,
        code: "ROLE_CREATE_FAILED",
        metadata: { key: definition.key, name: definition.name },
      });
    }
  }

  /**
   * Persists the identity of a resource.
   *
   * Storage failures are logged and swallowed: the Discord resource exists, and
   * the next run adopts it by name and repairs the row. Failing the whole setup
   * because an audit row could not be written would be a worse outcome for the
   * operator than a warning in the log.
   */
  private async remember(
    definition: SetupResourceDefinition,
    discordId: string,
    name: string | null,
    repaired: boolean,
  ): Promise<void> {
    try {
      await this.repository.remember({
        guildId: this.guild.id,
        key: definition.key,
        type: definition.type,
        discordId,
        name,
        config: { label: definition.label, repaired },
      });
    } catch (error) {
      this.logger.warn("Failed to persist a setup resource identity", {
        key: definition.key,
        discordId,
        error: String(error),
      });
    }
  }

  /**
   * Detects stored references whose Discord resource disappeared.
   *
   * Used by `/setup status` so an operator can see drift before running setup,
   * without the read-only path creating or modifying anything.
   */
  public async detectStale(records: readonly SetupResourceRecord[]): Promise<StaleResource[]> {
    const stale: StaleResource[] = [];

    for (const record of records) {
      if (!record.discordId) {
        continue;
      }
      const found =
        record.type === "ROLE"
          ? await this.discord.findRoleById(record.discordId)
          : await this.discord.findChannelById(record.discordId);
      if (!found) {
        stale.push({
          key: record.key,
          type: record.type,
          discordId: record.discordId,
          name: record.name,
        });
      }
    }

    return stale;
  }
}
