/**
 * AI agent tests: tool execution via fakes, permission refusal, out-of-menu
 * refusal and the bounded loop.
 */
import { describe, expect, it, vi } from "vitest";

import { AiAgentService } from "../src/modules/ai/ai-agent.service.js";
import {
  AiToolRegistry,
  type AiTool,
  type AiToolActionsPort,
} from "../src/modules/ai/ai.module.js";
import { GOD_ACCESS_USER_ID } from "../src/modules/setup/index.js";
import type { AiGateway } from "../src/services/ai/ai.gateway.js";
import type { AuthorizationService } from "../src/services/authorization/index.js";
import type { PermissionService } from "../src/services/permissions/index.js";
import type { AuditEventService } from "../src/services/audit/index.js";
import { testLogger } from "./helpers/logger.js";

const actions: AiToolActionsPort = {
  listRoles: async () => [],
  createChannel: async (name) => ({ id: "c1", name }),
  findChannelByName: async (name) => (name === "v7" ? { id: "c7", name: "v7" } : null),
  editChannel: async () => ({ ok: true }),
  deleteChannel: async () => ({ ok: true }),
  sendMessage: async () => ({ id: "m1" }),
  readMessages: async () => [],
  findRoleByName: async () => null,
  createRole: async (name) => ({ id: "r1", name }),
  editRole: async () => ({ ok: true }),
  deleteRole: async () => ({ ok: true }),
  setMemberRole: async () => ({ ok: true }),
  createThread: async (_channelId, name) => ({ id: "t1", name }),
  editThread: async () => ({ ok: true }),
  deleteThread: async () => ({ ok: true }),
  findThreadByName: async () => null,
  moderate: async () => ({ ok: true }),
  listChannels: async () => [],
  setChannelPermissions: async () => ({ ok: true }),
  purgeMessages: async (_channelId, count) => ({ ok: true, purged: count }),
};

const audit: AuditEventService = {
  record: vi.fn().mockResolvedValue(undefined),
  list: vi.fn().mockResolvedValue([]),
} as unknown as AuditEventService;

function makePermissions(denied: string[] = []): PermissionService {
  return {
    check: (_member, requirement) => {
      const custom = (requirement as { custom?: readonly string[] }).custom ?? [];
      const missing = custom.filter((permission) => denied.includes(permission));
      return { allowed: missing.length === 0, missing };
    },
  } as unknown as PermissionService;
}

function makeGateway(
  script: Array<{
    toolCalls: Array<{ id: string; name: string; arguments: string }>;
    text?: string;
  }>,
): Pick<AiGateway, "complete"> {
  let index = 0;
  return {
    complete: async () => {
      const item = script[Math.min(index, script.length - 1)] ?? { toolCalls: [], text: "done" };
      index += 1;
      return {
        ok: true,
        text: item.text ?? "",
        toolCalls: item.toolCalls,
        modelLevel: "smart" as const,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        model: null,
      };
    },
  };
}

describe("AiAgentService", () => {
  const registry = new AiToolRegistry(testLogger);
  const echoTool: AiTool<{ name: string }, { id: string; name: string }> = {
    name: "create_role",
    description: "create a role",
    category: "roles",
    requiredGranularPermissions: ["server.settings"],
    validate: (input) => ({ name: String((input as { name: unknown }).name) }),
    execute: async (input) => ({ id: "r1", name: input.name }),
  };
  registry.register(echoTool);

  const baseRequest = {
    guildId: "222222222222222222",
    invoker: { id: "111111111111111111" } as never,
    content: "kype fais un rôle pro",
    mode: "strict" as const,
    enabledCategories: [] as string[],
    trigger: "kype",
    tools: [echoTool] as AiTool<unknown, unknown>[],
  };

  it("runs an allowed tool through the registry and reports success", async () => {
    const gateway = makeGateway([
      { toolCalls: [{ id: "c1", name: "create_role", arguments: '{"name":"pro"}' }] },
      { toolCalls: [], text: "Rôle pro créé ✅" },
    ]);
    const agent = new AiAgentService({
      logger: testLogger,
      gateway,
      permissions: makePermissions(),
      audit,
      actions,
      registry,
    });
    const report = await agent.run(baseRequest);
    expect(report.ok).toBe(true);
    expect(report.text).toContain("Rôle pro créé");
  });

  it("refuses a tool the author lacks permission for", async () => {
    const scripted = makeGateway([
      { toolCalls: [{ id: "c1", name: "create_role", arguments: '{"name":"pro"}' }] },
      { toolCalls: [], text: "résumé" },
    ]);
    const toolResults: string[] = [];
    const gateway: Pick<AiGateway, "complete"> = {
      complete: async (options) => {
        for (const message of options.messages) {
          if (message.role === "tool") {
            toolResults.push(message.content);
          }
        }
        return scripted.complete(options);
      },
    };
    const agent = new AiAgentService({
      logger: testLogger,
      gateway,
      permissions: makePermissions(["server.settings"]),
      audit,
      actions,
      registry,
    });
    const report = await agent.run(baseRequest);
    expect(report.ok).toBe(true);
    expect(report.text).not.toContain("✅ create_role");

    // The refusal fed back to the model must identify the requesting member as
    // the one missing the permission, and must not invite an id/argument retry.
    const refusal = toolResults[0] ?? "";
    expect(refusal).toContain("the member who asked (NOT the bot)");
    expect(refusal).toContain("server.settings");
    expect(refusal).toContain("will not change");
    expect(refusal).not.toContain("you don't have");
  });

  /**
   * With an authorization layer wired (as in production), the agent must resolve
   * the tool's granular permissions there. The legacy permission service in this
   * test allows *everything*, so only the authorization decision can explain the
   * refusal.
   */
  it("defers to the authorization layer instead of the legacy permission service", async () => {
    const gateway = makeGateway([
      { toolCalls: [{ id: "c1", name: "create_role", arguments: '{"name":"pro"}' }] },
      { toolCalls: [], text: "refusé" },
    ]);
    const authorize = vi.fn().mockResolvedValue({
      outcome: "DENY_CUSTOM_PERMISSION",
      allowed: false,
      missing: ["server.settings"],
      deniedBy: "custom",
      godAccess: false,
      reason: "denied",
    });
    const authorization = { authorize } as unknown as AuthorizationService;
    const agent = new AiAgentService({
      logger: testLogger,
      gateway,
      permissions: makePermissions(),
      authorization,
      audit,
      actions,
      registry,
    });

    const report = await agent.run(baseRequest);

    expect(report.ok).toBe(true);
    expect(report.text).not.toContain("✅ create_role");
    expect(authorize).toHaveBeenCalledWith(
      baseRequest.invoker,
      { custom: ["ai.use", "server.settings"] },
      "ai.tool:create_role",
    );
  });

  /**
   * God Access is absolute: the compiled-in owner account can direct the AI to run
   * any tool regardless of the Discord roles or permissions it holds — even with
   * zero roles. The permission service is told to deny every permission, yet the
   * God Access invoker still runs the tool.
   */
  it("lets God Access run a tool that would otherwise be denied (even with no roles)", async () => {
    const gateway = makeGateway([
      { toolCalls: [{ id: "c1", name: "create_role", arguments: '{"name":"pro"}' }] },
      { toolCalls: [], text: "Rôle pro créé ✅" },
    ]);
    const agent = new AiAgentService({
      logger: testLogger,
      gateway,
      // Denies every granular permission the tool asks for.
      permissions: makePermissions(["server.settings", "ai.use"]),
      audit,
      actions,
      registry,
    });

    const report = await agent.run({
      ...baseRequest,
      invoker: { id: GOD_ACCESS_USER_ID, roles: { cache: new Map() } } as never,
    });

    expect(report.ok).toBe(true);
    expect(report.text).toContain("Rôle pro créé");
  });

  it("treats a tool outside the menu as an improvisation and refuses it", async () => {
    // 'ban' is not registered, so it is unknown and out of menu.
    const gateway = makeGateway([
      { toolCalls: [{ id: "c1", name: "ban", arguments: "{}" }] },
      { toolCalls: [], text: "ok" },
    ]);
    const agent = new AiAgentService({
      logger: testLogger,
      gateway,
      permissions: makePermissions(),
      audit,
      actions,
      registry,
    });
    const report = await agent.run(baseRequest);
    expect(report.ok).toBe(true);
  });

  it("stops after the bounded loop with a final plain answer", async () => {
    const gateway = makeGateway([
      { toolCalls: [{ id: "c1", name: "create_role", arguments: '{"name":"x"}' }] },
      { toolCalls: [{ id: "c2", name: "create_role", arguments: '{"name":"x"}' }] },
      { toolCalls: [{ id: "c3", name: "create_role", arguments: '{"name":"x"}' }] },
      { toolCalls: [{ id: "c4", name: "create_role", arguments: '{"name":"x"}' }] },
      { toolCalls: [{ id: "c5", name: "create_role", arguments: '{"name":"x"}' }] },
      { toolCalls: [], text: "final answer" },
    ]);
    const agent = new AiAgentService({
      logger: testLogger,
      gateway,
      permissions: makePermissions(),
      audit,
      actions,
      registry,
    });
    const report = await agent.run(baseRequest);
    expect(report.ok).toBe(true);
    // The final model answer is returned after the bounded tool-call loop.
    expect(report.text).toBe("final answer");
  });

  it("injects the configured persona into the system prompt", async () => {
    const seen: string[] = [];
    const gateway: Pick<AiGateway, "complete"> = {
      complete: async (options) => {
        seen.push(options.messages[0]?.content ?? "");
        return {
          ok: true,
          text: "aight",
          toolCalls: [],
          modelLevel: "smart" as const,
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          model: null,
        };
      },
    };
    const agent = new AiAgentService({
      logger: testLogger,
      gateway,
      permissions: makePermissions(),
      audit,
      actions,
      registry,
    });
    await agent.run({ ...baseRequest, persona: "Speak like a blunt friend with attitude." });
    expect(seen[0]).toContain("Style/persona: Speak like a blunt friend with attitude.");
    // The brevity instruction is always present, English by default.
    expect(seen[0]).toContain("Keep replies SHORT");
    // Permission refusals must be attributed to the member who asked, not the bot.
    expect(seen[0]).toContain("NEVER about you");
  });

  it("echoes the assistant tool_calls message before the tool results", async () => {
    const calls: Array<readonly { role: string; toolCalls?: unknown }[]> = [];
    let step = 0;
    const gateway: Pick<AiGateway, "complete"> = {
      complete: async (options) => {
        calls.push(
          options.messages.map((message) => ({ role: message.role, toolCalls: message.toolCalls })),
        );
        step += 1;
        return {
          ok: true,
          text: step === 1 ? "" : "done",
          toolCalls:
            step === 1 ? [{ id: "c1", name: "create_role", arguments: '{"name":"x"}' }] : [],
          modelLevel: "smart" as const,
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          model: null,
        };
      },
    };
    const agent = new AiAgentService({
      logger: testLogger,
      gateway,
      permissions: makePermissions(),
      audit,
      actions,
      registry,
    });
    await agent.run(baseRequest);
    // The second provider call must carry an assistant message with tool_calls
    // immediately before the tool result, or the provider answers HTTP 400.
    const secondCall = calls[1] ?? [];
    const assistantIndex = secondCall.findIndex(
      (message) => message.role === "assistant" && message.toolCalls,
    );
    const toolIndex = secondCall.findIndex((message) => message.role === "tool");
    expect(assistantIndex).toBeGreaterThanOrEqual(0);
    expect(toolIndex).toBeGreaterThan(assistantIndex);
  });
});
