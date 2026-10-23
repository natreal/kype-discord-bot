/**
 * AI settings service tests: DB override wins over `.env`, and the API key is
 * never returned in the clear through the redacted view.
 */
import { describe, expect, it } from "vitest";

import {
  AiSettingsService,
  AI_PROVIDER_SETTINGS_KEY,
  type AiProviderSettingsRepository,
  type AiProviderSettingsRow,
} from "../src/services/ai/ai-settings.service.js";
import { testLogger } from "./helpers/logger.js";

function memRepo(): AiProviderSettingsRepository {
  let row: AiProviderSettingsRow | null = null;
  return {
    async get(key) {
      return key === AI_PROVIDER_SETTINGS_KEY ? row : null;
    },
    async set(key, patch) {
      const next: AiProviderSettingsRow = {
        key,
        baseUrl: patch.baseUrl ?? row?.baseUrl ?? null,
        apiKey: patch.apiKey ?? row?.apiKey ?? null,
        modelFast: patch.modelFast ?? row?.modelFast ?? null,
        modelSmart: patch.modelSmart ?? row?.modelSmart ?? null,
        dailyTokenBudget: patch.dailyTokenBudget ?? row?.dailyTokenBudget ?? 0,
        requestTimeoutMs: patch.requestTimeoutMs ?? row?.requestTimeoutMs ?? 20_000,
        defaultTrigger: patch.defaultTrigger ?? row?.defaultTrigger ?? null,
        persona: patch.persona ?? row?.persona ?? null,
      };
      row = next;
      return next;
    },
  };
}

const env = {
  baseUrl: "http://localhost:11434/v1",
  apiKey: "env-key",
  modelFast: "llama3",
  modelSmart: undefined,
  dailyTokenBudget: 0,
  requestTimeoutMs: 20_000,
  defaultTrigger: "kype",
  persona: undefined,
};

describe("AiSettingsService", () => {
  it("falls back to .env defaults when nothing is stored", async () => {
    const service = new AiSettingsService({ logger: testLogger, repository: memRepo(), env });
    const config = await service.get();
    expect(config.baseUrl).toBe("http://localhost:11434/v1");
    expect(config.apiKey).toBe("env-key");
  });

  it("lets a stored value override the .env default", async () => {
    const repo = memRepo();
    const service = new AiSettingsService({ logger: testLogger, repository: repo, env });
    await service.update({ baseUrl: "https://api.openai.com/v1", modelFast: "gpt-4o-mini" });
    const config = await service.get();
    expect(config.baseUrl).toBe("https://api.openai.com/v1");
    expect(config.modelFast).toBe("gpt-4o-mini");
    // Untouched fields keep the env defaults.
    expect(config.apiKey).toBe("env-key");
  });

  it("never exposes the API key through the redacted view", async () => {
    const service = new AiSettingsService({ logger: testLogger, repository: memRepo(), env });
    await service.update({ apiKey: "very-secret" });
    const redacted = await service.getRedacted();
    expect(redacted.apiKeySet).toBe(true);
    expect(JSON.stringify(redacted)).not.toContain("very-secret");
    expect(JSON.stringify(redacted)).not.toContain("env-key");
  });

  it("persists and returns the persona (and redacts nothing extra)", async () => {
    const service = new AiSettingsService({ logger: testLogger, repository: memRepo(), env });
    await service.update({ persona: "Talk like a laid-back friend." });
    const config = await service.get();
    expect(config.persona).toBe("Talk like a laid-back friend.");
    const redacted = await service.getRedacted();
    expect(redacted.persona).toBe("Talk like a laid-back friend.");
  });

  it("stores the .env timeout when a patch does not name one", async () => {
    // The regression: configuring *any* other setting created a row at the column
    // default (20s). Since a stored value beats `.env` in `get()`, raising
    // `AI_REQUEST_TIMEOUT_MS` then had no effect and every request timed out.
    const repo = memRepo();
    const service = new AiSettingsService({
      logger: testLogger,
      repository: repo,
      env: { ...env, requestTimeoutMs: 60_000 },
    });

    await service.update({ baseUrl: "https://example.test/v1" });

    expect((await service.get()).requestTimeoutMs).toBe(60_000);
  });

  it("honours an explicit timeout, so the owner can retune it from Discord", async () => {
    const repo = memRepo();
    const service = new AiSettingsService({ logger: testLogger, repository: repo, env });

    await service.update({ requestTimeoutMs: 120_000 });

    expect((await service.get()).requestTimeoutMs).toBe(120_000);
    expect((await service.get()).baseUrl).toBe("http://localhost:11434/v1");
  });
});
