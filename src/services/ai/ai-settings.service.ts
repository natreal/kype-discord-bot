/**
 * Global AI provider settings, editable at runtime by the owner.
 *
 * These exist because the provider must be configurable *from Discord* (God
 * Access) rather than by editing `.env`. `.env` remains the source of initial
 * defaults; a value persisted in `ai_provider_settings` overrides it at runtime.
 *
 * The API key is a credential: this module is the only boundary that returns a
 * *redacted* view (`[redacted]` / presence only). The raw value is handed
 * exclusively to the transport `AiProvider` when the gateway is (re)configured,
 * never back to a command or a log.
 */
import type { PrismaDatabaseClient } from "../database/index.js";
import { toDatabaseError } from "../database/index.js";
import type { Logger } from "../logger/index.js";
import type { AppConfig } from "../../config/config.js";

/** The single global row key. One row per deployment, by construction. */
export const AI_PROVIDER_SETTINGS_KEY = "global";

/** Values from the process environment (the `.env` defaults). */
export interface AiEnvDefaults {
  readonly baseUrl: string | undefined;
  readonly apiKey: string | undefined;
  readonly modelFast: string | undefined;
  readonly modelSmart: string | undefined;
  readonly dailyTokenBudget: number;
  readonly requestTimeoutMs: number;
  readonly defaultTrigger: string;
  readonly persona: string | undefined;
}

/** The *effective* provider settings, with defaults already applied. */
export interface AiProviderConfig {
  readonly baseUrl: string;
  readonly apiKey: string | undefined;
  readonly modelFast: string | undefined;
  readonly modelSmart: string | undefined;
  readonly dailyTokenBudget: number;
  readonly requestTimeoutMs: number;
  readonly defaultTrigger: string;
  readonly persona: string | undefined;
}

/** A view safe to render in Discord: the key is never present in the clear. */
export interface AiProviderConfigRedacted {
  readonly baseUrl: string | null;
  readonly apiKeySet: boolean;
  readonly modelFast: string | null;
  readonly modelSmart: string | null;
  readonly dailyTokenBudget: number;
  readonly requestTimeoutMs: number;
  readonly defaultTrigger: string | null;
  readonly persona: string | null;
}

/** Persistence port, implemented by `PrismaAiProviderSettingsRepository`. */
export interface AiProviderSettingsRepository {
  /** Reads the singleton row, or `null` when nothing has been set yet. */
  get(key: string): Promise<AiProviderSettingsRow | null>;
  /** Upserts the singleton row, returning the new state. */
  set(key: string, patch: AiProviderSettingsPatch): Promise<AiProviderSettingsRow>;
}

/** A mutable partial update (non-`readonly`, so callers can build it field-by-field). */
export type AiProviderSettingsPatch = {
  baseUrl?: string | null;
  apiKey?: string | null;
  modelFast?: string | null;
  modelSmart?: string | null;
  dailyTokenBudget?: number;
  requestTimeoutMs?: number;
  defaultTrigger?: string | null;
  persona?: string | null;
};

/** A row as stored (the API key is present here, in the clear). */
export interface AiProviderSettingsRow {
  readonly key: string;
  readonly baseUrl: string | null;
  readonly apiKey: string | null;
  readonly modelFast: string | null;
  readonly modelSmart: string | null;
  readonly dailyTokenBudget: number;
  readonly requestTimeoutMs: number;
  readonly defaultTrigger: string | null;
  readonly persona: string | null;
}

export interface AiSettingsServiceOptions {
  readonly logger: Logger;
  readonly repository: AiProviderSettingsRepository;
  /** The process defaults, read once from `AppConfig`. */
  readonly env: AiEnvDefaults;
}

export class AiSettingsService {
  private readonly logger: Logger;
  private readonly repository: AiProviderSettingsRepository;
  private readonly env: AiEnvDefaults;

  public constructor(options: AiSettingsServiceOptions) {
    this.logger = options.logger.child("ai:settings");
    this.repository = options.repository;
    this.env = options.env;
  }

  /**
   * Reads the effective config: a stored value wins, `.env` fills the gaps.
   *
   * The API key is returned here because the reconfigure path needs the raw
   * value; callers that merely *display* state must use {@link getRedacted}.
   *
   * A database failure (for example, the Migrations not yet applied) falls back
   * to the `.env` defaults rather than throwing: AI is optional, so a missing
   * table must never take the bot down at startup.
   */
  public async get(): Promise<AiProviderConfig> {
    let row: AiProviderSettingsRow | null = null;
    try {
      row = await this.repository.get(AI_PROVIDER_SETTINGS_KEY);
    } catch (error) {
      this.logger.warn("Could not read AI provider settings; falling back to .env", {
        reason: error instanceof Error ? error.message : String(error),
      });
    }

    return {
      baseUrl: row?.baseUrl ?? this.env.baseUrl ?? "",
      apiKey: row?.apiKey ?? this.env.apiKey,
      modelFast: row?.modelFast ?? this.env.modelFast,
      modelSmart: row?.modelSmart ?? this.env.modelSmart,
      dailyTokenBudget: row?.dailyTokenBudget ?? this.env.dailyTokenBudget,
      requestTimeoutMs: row?.requestTimeoutMs ?? this.env.requestTimeoutMs,
      defaultTrigger: row?.defaultTrigger ?? this.env.defaultTrigger,
      persona: row?.persona ?? this.env.persona,
    };
  }

  /** True when a base URL is present (the signal the gateway keys on). */
  public async isConfigured(): Promise<boolean> {
    const config = await this.get();
    return config.baseUrl.length > 0;
  }

  /**
   * A safe projection for `/ai config show` and diagnostics: the API key is
   * reduced to a presence boolean, so a secret can never leak into Discord.
   */
  public async getRedacted(): Promise<AiProviderConfigRedacted> {
    const config = await this.get();
    return {
      baseUrl: config.baseUrl || null,
      apiKeySet: Boolean(config.apiKey),
      modelFast: config.modelFast ?? null,
      modelSmart: config.modelSmart ?? null,
      dailyTokenBudget: config.dailyTokenBudget,
      requestTimeoutMs: config.requestTimeoutMs,
      defaultTrigger: config.defaultTrigger || null,
      persona: config.persona ?? null,
    };
  }

  /**
   * Merges a partial update into the stored row (DB writes only the touched
   * fields; `.env` keeps filling anything unset).
   */
  public async update(patch: AiProviderSettingsPatch): Promise<void> {
    await this.repository.set(AI_PROVIDER_SETTINGS_KEY, patch);
    this.logger.warn("AI provider settings updated", {
      baseUrl: patch.baseUrl === undefined ? "(unchanged)" : patch.baseUrl,
      apiKeySet: patch.apiKey !== undefined && patch.apiKey !== null && patch.apiKey.length > 0,
    });
  }
}

/** Builds the `AiEnvDefaults` from an `AppConfig`. */
export function envDefaultsFrom(config: AppConfig): AiEnvDefaults {
  return {
    baseUrl: config.ai.baseUrl,
    apiKey: config.ai.apiKey,
    modelFast: config.ai.modelFast,
    modelSmart: config.ai.modelSmart,
    dailyTokenBudget: config.ai.dailyTokenBudget,
    requestTimeoutMs: config.ai.requestTimeoutMs,
    defaultTrigger: config.ai.defaultTrigger,
    persona: config.ai.persona,
  };
}

export class PrismaAiProviderSettingsRepository implements AiProviderSettingsRepository {
  private readonly prisma: PrismaDatabaseClient;

  public constructor(prisma: PrismaDatabaseClient) {
    this.prisma = prisma;
  }

  public async get(key: string): Promise<AiProviderSettingsRow | null> {
    try {
      const row = await this.prisma.aiProviderSettings.findUnique({ where: { key } });
      return row ? toRow(row) : null;
    } catch (error) {
      throw toDatabaseError(error, "aiProviderSettings.get");
    }
  }

  public async set(key: string, patch: AiProviderSettingsPatch): Promise<AiProviderSettingsRow> {
    try {
      const row = await this.prisma.aiProviderSettings.upsert({
        where: { key },
        create: {
          key,
          baseUrl: patch.baseUrl ?? null,
          apiKey: patch.apiKey ?? null,
          modelFast: patch.modelFast ?? null,
          modelSmart: patch.modelSmart ?? null,
          dailyTokenBudget: patch.dailyTokenBudget ?? 0,
          requestTimeoutMs: patch.requestTimeoutMs ?? 20_000,
          defaultTrigger: patch.defaultTrigger ?? null,
          persona: patch.persona ?? null,
        },
        update: {
          ...(patch.baseUrl === undefined ? {} : { baseUrl: patch.baseUrl }),
          ...(patch.apiKey === undefined ? {} : { apiKey: patch.apiKey }),
          ...(patch.modelFast === undefined ? {} : { modelFast: patch.modelFast }),
          ...(patch.modelSmart === undefined ? {} : { modelSmart: patch.modelSmart }),
          ...(patch.dailyTokenBudget === undefined ? {} : { dailyTokenBudget: patch.dailyTokenBudget }),
          ...(patch.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: patch.requestTimeoutMs }),
          ...(patch.defaultTrigger === undefined ? {} : { defaultTrigger: patch.defaultTrigger }),
          ...(patch.persona === undefined ? {} : { persona: patch.persona }),
        },
      });
      return toRow(row);
    } catch (error) {
      throw toDatabaseError(error, "aiProviderSettings.set");
    }
  }
}

function toRow(row: {
  key: string;
  baseUrl: string | null;
  apiKey: string | null;
  modelFast: string | null;
  modelSmart: string | null;
  dailyTokenBudget: number;
  requestTimeoutMs: number;
  defaultTrigger: string | null;
  persona: string | null;
}): AiProviderSettingsRow {
  return {
    key: row.key,
    baseUrl: row.baseUrl,
    apiKey: row.apiKey,
    modelFast: row.modelFast,
    modelSmart: row.modelSmart,
    dailyTokenBudget: row.dailyTokenBudget,
    requestTimeoutMs: row.requestTimeoutMs,
    defaultTrigger: row.defaultTrigger,
    persona: row.persona,
  };
}


