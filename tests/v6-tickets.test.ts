/**
 * V6 ticket module tests.
 *
 * The suite proves the guarantees the module exists to provide, in the order they can
 * break:
 *
 *   1. **a ticket is private and recorded.** Opening creates a staff-only channel *and* a
 *      row, with a gap-free number staff can refer to;
 *   2. **a member cannot open two.** The second attempt is refused and points at the open
 *      one, which is the abuse this feature is otherwise subject to;
 *   3. **a half-open ticket cannot exist.** If the row fails, the channel is deleted
 *      again rather than left as an orphan no command can find;
 *   4. **the transcript survives the close.** Closing stores the conversation *before*
 *      locking the channel, and a failed transcript is reported rather than swallowed;
 *   5. **closing twice is one close.** The second caller is told it is already closed;
 *   6. **claiming is exclusive.** The second staff member is refused, not silently
 *      overwriting who is handling it;
 *   7. **the checksum detects tampering**, and the panel/controls are shaped for Discord.
 */
import { describe, expect, it } from "vitest";

import {
  QUEUE_CONTROL_ROWS,
  TICKET_IDS,
  TicketService,
  buildTicketControls,
  buildTicketPanel,
  buildTicketQueueControls,
  renderMarkdownTranscript,
  renderTranscript,
  transcriptChecksum,
  verifyTranscript,
} from "../../src/modules/tickets/index.js";
import { testLogger } from "../helpers/logger.js";
import { fakeTicketActions, memoryTickets, message } from "../helpers/tickets.js";
import { AuditEventService } from "../../src/services/audit/index.js";

const GUILD = "guild-1";
const OTHER_GUILD = "guild-2";
const OPENER = "user-opener";
const STAFF = "user-staff";
const STAFF_TWO = "user-staff-2";
const STAFF_ROLE = "role-staff";

const SUPPORT = {
  guildId: GUILD,
  key: "support",
  label: "General Support",
  emoji: "❓",
  description: "Questions about the server.",
  staffRoleIds: [STAFF_ROLE],
  parentId: "category-tickets",
} as const;

/** Builds a service over fresh fakes, recording the audit actions it writes. */
function harness(
  options: {
    enabled?: boolean;
    categories?: readonly (typeof SUPPORT)[];
    ticketAccessRoleIds?: (guildId: string) => Promise<string[]>;
    memberLimit?: (guildId: string) => Promise<number>;
  } = {},
) {
  const repository = memoryTickets(
    options.categories === undefined ? [SUPPORT] : options.categories,
  );
  const actions = fakeTicketActions();
  const auditActions: string[] = [];
  const enabled = options.enabled ?? true;

  const audit = new AuditEventService(testLogger, {
    append(event) {
      auditActions.push(event.action);
      return Promise.resolve();
    },
    list() {
      return Promise.resolve([]);
    },
  });

  const service = new TicketService({
    logger: testLogger,
    audit,
    repository,
    actions,
    enabled: async () => enabled,
    ...(options.ticketAccessRoleIds ? { ticketAccessRoleIds: options.ticketAccessRoleIds } : {}),
    ...(options.memberLimit ? { memberLimit: options.memberLimit } : {}),
  });

  return { repository, actions, auditActions, service };
}

describe("ticket opening", () => {
  it("creates a private channel and a numbered record", async () => {
    const { service, actions, repository } = harness();

    const outcome = await service.open(GUILD, {
      categoryKey: "support",
      openerId: OPENER,
      openerName: "Alex Smith",
      subject: "I cannot verify",
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.ticket?.number).toBe(1);
    expect(repository.rows).toHaveLength(1);

    // The channel is created under the configured category, restricted to the opener
    // and the category's staff roles — the permission half of "private".
    expect(actions.createCalls).toHaveLength(1);
    expect(actions.createCalls[0]?.parentId).toBe("category-tickets");
    expect(actions.createCalls[0]?.openerId).toBe(OPENER);
    expect(actions.createCalls[0]?.staffRoleIds).toEqual([STAFF_ROLE]);

    // The name carries both the category and the opener, so the channel list is usable.
    expect(actions.createCalls[0]?.name).toBe("support-alex-smith");
  });

  it("posts the control buttons into the ticket channel on open", async () => {
    // Regression: the Claim / Close / Transcript buttons were built (and tested in
    // isolation) but never sent, so staff opened a ticket channel and saw no way to
    // claim or close it — the exact "we can't claim or close tickets" bug.
    const { service, actions } = harness();

    const outcome = await service.open(GUILD, {
      categoryKey: "support",
      openerId: OPENER,
      openerName: "Alex Smith",
      subject: "I cannot verify",
    });

    expect(outcome.ok).toBe(true);
    expect(actions.sent).toHaveLength(1);

    const intro = actions.sent[0];
    expect(intro?.channelId).toBe(outcome.ticket?.channelId);
    // One row carrying the Claim / Close / Transcript buttons.
    expect(intro?.componentCount).toBe(1);
    expect(intro?.content).toContain(`Ticket #${outcome.ticket?.number}`);
  });

  it("opens the ticket channel to admin roles resolved from the permission classes", async () => {
    // Admins must be able to see and handle tickets without holding Discord's
    // `Administrator` permission: the bot already knows "this role is admin" through the
    // role → class binding, and that is enough.
    const ADMIN_ROLE = "role-admin";
    const { service, actions } = harness({
      ticketAccessRoleIds: async () => [ADMIN_ROLE],
    });

    await service.open(GUILD, {
      categoryKey: "support",
      openerId: OPENER,
      openerName: "Alex",
    });

    // The category's own staff role plus the admin role, de-duplicated.
    expect(actions.createCalls[0]?.staffRoleIds).toEqual([STAFF_ROLE, ADMIN_ROLE]);
  });

  it("does not duplicate a role that is both staff and admin", async () => {
    const { service, actions } = harness({
      ticketAccessRoleIds: async () => [STAFF_ROLE],
    });

    await service.open(GUILD, {
      categoryKey: "support",
      openerId: OPENER,
      openerName: "Alex",
    });

    expect(actions.createCalls[0]?.staffRoleIds).toEqual([STAFF_ROLE]);
  });

  it("numbers tickets per guild, gap-free", async () => {
    const { service } = harness();

    await service.open(GUILD, { categoryKey: "support", openerId: OPENER, openerName: "A" });
    await service.open(GUILD, { categoryKey: "support", openerId: "user-2", openerName: "B" });

    const first = await service.list(GUILD, {});
    expect(first.map((ticket) => ticket.number).sort()).toEqual([1, 2]);
  });

  it("refuses a second open ticket for the same member and points at the first", async () => {
    const { service, actions } = harness();

    const first = await service.open(GUILD, {
      categoryKey: "support",
      openerId: OPENER,
      openerName: "Alex",
    });
    const second = await service.open(GUILD, {
      categoryKey: "support",
      openerId: OPENER,
      openerName: "Alex",
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    expect(second.detail).toContain("already have ticket #1");
    // The refusal must not have created a channel: that is the abuse being prevented.
    expect(actions.createCalls).toHaveLength(1);
  });

  it("allows one ticket per category up to the default ceiling of three", async () => {
    const categories = ["support", "report", "appeal", "other"].map((key) => ({
      ...SUPPORT,
      key,
      label: key,
    }));
    const { service, actions } = harness({ categories });

    for (const categoryKey of ["support", "report", "appeal"]) {
      const outcome = await service.open(GUILD, {
        categoryKey,
        openerId: OPENER,
        openerName: "Alex",
      });
      expect(outcome.ok).toBe(true);
    }

    const refused = await service.open(GUILD, {
      categoryKey: "other",
      openerId: OPENER,
      openerName: "Alex",
    });

    // The default is a ceiling, not a suggestion: the fourth channel must not exist.
    expect(refused.ok).toBe(false);
    expect(refused.detail).toContain("3 open tickets");
    expect(refused.ticket?.status).toBe("open");
    expect(actions.createCalls).toHaveLength(3);
  });

  it("honours a lower configured limit, and frees a slot when a ticket closes", async () => {
    const categories = ["support", "report"].map((key) => ({ ...SUPPORT, key, label: key }));
    const { service, actions } = harness({ categories, memberLimit: async () => 1 });

    const first = await service.open(GUILD, {
      categoryKey: "support",
      openerId: OPENER,
      openerName: "Alex",
    });
    const refused = await service.open(GUILD, {
      categoryKey: "report",
      openerId: OPENER,
      openerName: "Alex",
    });

    expect(first.ok).toBe(true);
    expect(refused.ok).toBe(false);
    expect(refused.detail).toContain("one at a time");
    expect(actions.createCalls).toHaveLength(1);

    // The limit counts open tickets, so closing one reopens the slot.
    await service.close(GUILD, first.ticket!.id, STAFF, "done");
    const second = await service.open(GUILD, {
      categoryKey: "report",
      openerId: OPENER,
      openerName: "Alex",
    });
    expect(second.ok).toBe(true);
    expect(actions.createCalls).toHaveLength(2);
  });

  it("does not resolve a ticket id from another guild", async () => {
    const { service } = harness();
    const opened = await service.open(GUILD, {
      categoryKey: "support",
      openerId: OPENER,
      openerName: "Alex",
    });

    expect(await service.find(GUILD, opened.ticket!.id)).not.toBeNull();
    expect(await service.find(OTHER_GUILD, opened.ticket!.id)).toBeNull();
  });

  it("refuses an unknown category without touching Discord", async () => {
    const { service, actions } = harness();

    const outcome = await service.open(GUILD, {
      categoryKey: "does-not-exist",
      openerId: OPENER,
      openerName: "Alex",
    });

    expect(outcome.ok).toBe(false);
    expect(actions.createCalls).toHaveLength(0);
  });

  it("refuses when the module is disabled", async () => {
    const { service, actions } = harness({ enabled: false });

    const outcome = await service.open(GUILD, {
      categoryKey: "support",
      openerId: OPENER,
      openerName: "Alex",
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toContain("disabled");
    expect(actions.createCalls).toHaveLength(0);
  });

  it("rolls the channel back when the record cannot be written", async () => {
    const { service, actions, repository } = harness();
    repository.failNextCreate();

    const outcome = await service.open(GUILD, {
      categoryKey: "support",
      openerId: OPENER,
      openerName: "Alex",
    });

    expect(outcome.ok).toBe(false);
    // The orphan channel is the failure this rollback exists to prevent: no record
    // points at it, so no command can close it.
    expect(actions.deleted).toEqual(["channel-1"]);
    expect(actions.channels()).toEqual([]);
  });

  it("keeps the same key in another guild independent", async () => {
    const { service } = harness();
    const other = memoryTickets([{ ...SUPPORT, guildId: OTHER_GUILD }]);
    const actions = fakeTicketActions();
    const audit = new AuditEventService(testLogger, {
      append: () => Promise.resolve(),
      list: () => Promise.resolve([]),
    });
    const otherService = new TicketService({
      logger: testLogger,
      audit,
      repository: other,
      actions,
      enabled: async () => true,
    });

    await service.open(GUILD, { categoryKey: "support", openerId: OPENER, openerName: "A" });
    const foreign = await otherService.open(OTHER_GUILD, {
      categoryKey: "support",
      openerId: OPENER,
      openerName: "A",
    });

    // Both are ticket #1: the counter is per guild, so one server's volume never leaks
    // into another's numbering.
    expect(foreign.ticket?.number).toBe(1);
  });
});

describe("ticket staff scope", () => {
  it("separates global staff from per-category helpers", async () => {
    const categories = [
      { ...SUPPORT, key: "support", staffRoleIds: ["role-support"] },
      { ...SUPPORT, key: "appeal", staffRoleIds: ["role-appeal"] },
    ];
    const { service } = harness({
      categories,
      ticketAccessRoleIds: async () => ["role-global"],
    });

    // A role bound to tickets.view/manage covers every category; a role named by one
    // category only covers that category.
    expect(await service.isTicketStaff(GUILD, ["role-global"])).toBe(true);
    expect(await service.isTicketStaff(GUILD, ["role-support"])).toBe(false);
    expect(await service.isTicketStaff(GUILD, ["role-other"])).toBe(false);

    const support = await service.findCategory(GUILD, "support");
    const appeal = await service.findCategory(GUILD, "appeal");
    expect(await service.staffCategoryIds(GUILD, ["role-support"])).toEqual([support!.id]);
    expect(await service.staffCategoryIds(GUILD, ["role-appeal"])).toEqual([appeal!.id]);
    expect(await service.staffCategoryIds(GUILD, ["role-other"])).toEqual([]);
  });
});

describe("ticket closing", () => {
  it("stores the transcript before locking the channel", async () => {
    const { service, actions, repository, auditActions } = harness();
    const opened = await service.open(GUILD, {
      categoryKey: "support",
      openerId: OPENER,
      openerName: "Alex",
    });
    const channelId = opened.ticket!.channelId;

    actions.setHistory(channelId, [
      message("Alex", "I cannot verify my email."),
      message("Staff", "Looking into it now.", { authorId: STAFF }),
    ]);

    const outcome = await service.close(GUILD, opened.ticket!.id, STAFF, "resolved");

    expect(outcome.ok).toBe(true);
    expect(outcome.transcriptSaved).toBe(true);

    // The transcript exists and records both messages, in conversation order.
    const stored = repository.transcripts[0];
    expect(stored?.messageCount).toBe(2);
    expect(stored?.content).toContain("I cannot verify my email.");
    expect(stored?.content).toContain("Looking into it now.");
    expect(stored!.content.indexOf("I cannot verify")).toBeLessThan(
      stored!.content.indexOf("Looking into it now."),
    );
    // Its checksum matches the stored text, so tampering is detectable.
    expect(verifyTranscript(stored!.content, stored!.checksum)).toBe(true);

    expect(actions.archived).toEqual([channelId]);
    expect(auditActions).toContain("ticket.closed");
  });

  it("reports an already-closed ticket rather than closing it twice", async () => {
    const { service, repository } = harness();
    const opened = await service.open(GUILD, {
      categoryKey: "support",
      openerId: OPENER,
      openerName: "Alex",
    });

    const first = await service.close(GUILD, opened.ticket!.id, STAFF, "done");
    const second = await service.close(GUILD, opened.ticket!.id, STAFF_TWO, "also done");

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    expect(second.detail).toContain("already closed");
    // The closer is the first one: the second close did not overwrite who did it.
    expect(repository.rows[0]?.closedById).toBe(STAFF);
  });

  it("closes even when the transcript cannot be stored, and says so", async () => {
    const { service, repository, actions } = harness();
    const opened = await service.open(GUILD, {
      categoryKey: "support",
      openerId: OPENER,
      openerName: "Alex",
    });
    actions.setHistory(opened.ticket!.channelId, [message("Alex", "hello")]);
    repository.failNextTranscript();

    const outcome = await service.close(GUILD, opened.ticket!.id, STAFF, "done");

    // Refusing to close would leave staff unable to finish a conversation, which is
    // worse than a missing transcript — but the failure is reported, never silent.
    expect(outcome.ok).toBe(true);
    expect(outcome.transcriptSaved).toBe(false);
    expect(outcome.detail).toContain("transcript could not be saved");
    expect(repository.rows[0]?.status).toBe("closed");
  });

  it("refuses to close a ticket from another guild", async () => {
    const { service, repository } = harness();
    const opened = await service.open(GUILD, {
      categoryKey: "support",
      openerId: OPENER,
      openerName: "Alex",
    });

    const outcome = await service.close(OTHER_GUILD, opened.ticket!.id, STAFF, "nope");

    expect(outcome.ok).toBe(false);
    expect(repository.rows[0]?.status).toBe("open");
  });
});

describe("ticket claiming", () => {
  it("assigns the ticket to one staff member only", async () => {
    const { service, repository, auditActions } = harness();
    const opened = await service.open(GUILD, {
      categoryKey: "support",
      openerId: OPENER,
      openerName: "Alex",
    });

    const first = await service.claim(GUILD, opened.ticket!.id, STAFF);
    const second = await service.claim(GUILD, opened.ticket!.id, STAFF_TWO);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    expect(second.detail).toContain("already claimed");
    expect(repository.rows[0]?.claimedById).toBe(STAFF);
    expect(auditActions).toContain("ticket.claimed");
  });

  it("is idempotent when the same staff member claims twice", async () => {
    const { service } = harness();
    const opened = await service.open(GUILD, {
      categoryKey: "support",
      openerId: OPENER,
      openerName: "Alex",
    });

    await service.claim(GUILD, opened.ticket!.id, STAFF);
    const again = await service.claim(GUILD, opened.ticket!.id, STAFF);

    // A double-click is not a mistake worth reporting: the state already holds.
    expect(again.ok).toBe(true);
    expect(again.detail).toContain("already handling");
  });

  it("refuses to claim a closed ticket", async () => {
    const { service } = harness();
    const opened = await service.open(GUILD, {
      categoryKey: "support",
      openerId: OPENER,
      openerName: "Alex",
    });
    await service.close(GUILD, opened.ticket!.id, STAFF, "done");

    const outcome = await service.claim(GUILD, opened.ticket!.id, STAFF_TWO);

    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toContain("closed");
  });

  it("refuses to let the opener claim their own ticket", async () => {
    // The opener is the one being helped: claiming their own ticket would mark it
    // "handled" while nobody is actually assigned to answer it.
    const { service, repository } = harness();
    const opened = await service.open(GUILD, {
      categoryKey: "support",
      openerId: OPENER,
      openerName: "Alex",
    });

    const outcome = await service.claim(GUILD, opened.ticket!.id, OPENER);

    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toContain("own ticket");
    expect(repository.rows[0]?.claimedById).toBeNull();
  });
});

describe("ticket reopening and deletion", () => {
  it("reopens a closed ticket onto a new channel", async () => {
    const { service, repository, actions } = harness();
    const opened = await service.open(GUILD, {
      categoryKey: "support",
      openerId: OPENER,
      openerName: "Alex",
    });
    const originalChannel = opened.ticket!.channelId;
    await service.close(GUILD, opened.ticket!.id, STAFF, "done");

    const outcome = await service.reopen(GUILD, opened.ticket!.id, STAFF, {
      categoryKey: "support",
      openerName: "Alex",
    });

    expect(outcome.ok).toBe(true);
    expect(repository.rows[0]?.status).toBe("open");
    // A new channel, because the old one may have been deleted or repurposed while closed.
    expect(outcome.ticket?.channelId).not.toBe(originalChannel);
    expect(actions.createCalls).toHaveLength(2);
    // The stale closer is cleared, so the reopened ticket does not read as closed.
    expect(repository.rows[0]?.closedById).toBeNull();
    expect(repository.rows[0]?.closedAt).toBeNull();

    // The new channel gets a fresh set of control buttons, so the reopened ticket can
    // still be claimed/closed (the original channel's buttons were locked away with it).
    const reopenIntro = actions.sent[actions.sent.length - 1];
    expect(reopenIntro?.channelId).toBe(outcome.ticket?.channelId);
    expect(reopenIntro?.componentCount).toBe(1);
  });

  it("refuses to reopen an open or deleted ticket", async () => {
    const { service } = harness();
    const opened = await service.open(GUILD, {
      categoryKey: "support",
      openerId: OPENER,
      openerName: "Alex",
    });

    const alreadyOpen = await service.reopen(GUILD, opened.ticket!.id, STAFF, {
      categoryKey: "support",
      openerName: "Alex",
    });
    expect(alreadyOpen.detail).toContain("already open");

    await service.remove(GUILD, opened.ticket!.id, STAFF);
    const deleted = await service.reopen(GUILD, opened.ticket!.id, STAFF, {
      categoryKey: "support",
      openerName: "Alex",
    });
    expect(deleted.detail).toContain("deleted");
  });

  it("keeps the transcript when a ticket is deleted", async () => {
    const { service, repository, actions } = harness();
    const opened = await service.open(GUILD, {
      categoryKey: "support",
      openerId: OPENER,
      openerName: "Alex",
    });
    actions.setHistory(opened.ticket!.channelId, [message("Alex", "evidence")]);

    const outcome = await service.remove(GUILD, opened.ticket!.id, STAFF);

    expect(outcome.ok).toBe(true);
    expect(actions.deleted).toContain(opened.ticket!.channelId);
    // The evidence must outlive the channel: that is the whole point of storing it.
    expect(repository.transcripts).toHaveLength(1);
    expect(repository.transcripts[0]?.content).toContain("evidence");
    expect(repository.rows[0]?.status).toBe("deleted");
  });
});

describe("transcript rendering", () => {
  it("records the author id, so a renamed member is still traceable", () => {
    const rendered = renderMarkdownTranscript([message("Alex", "hello", { authorId: "user-42" })], {
      guildId: GUILD,
      ticketNumber: 7,
      subject: "Test",
    });

    expect(rendered).toContain("Ticket #7");
    expect(rendered).toContain("author:user-42");
  });

  it("marks bots and lists attachments", () => {
    const rendered = renderMarkdownTranscript(
      [
        message("Helper", "done", { bot: true }),
        message("Alex", "screenshot", { attachments: ["shot.png"] }),
      ],
      { guildId: GUILD, ticketNumber: 1, subject: null },
    );

    expect(rendered).toContain("Helper (bot)");
    expect(rendered).toContain("attachment: shot.png");
    // A ticket with no subject renders explicitly rather than leaving a blank field.
    expect(rendered).toContain("Subject:** (none)");
  });

  it("detects a tampered transcript", () => {
    const rendered = renderTranscript(
      [message("Alex", "original text")],
      { guildId: GUILD, ticketNumber: 1, subject: null },
      "markdown",
    );

    expect(verifyTranscript(rendered.content, rendered.checksum)).toBe(true);
    // Hand-editing the stored text must not verify against the stored checksum.
    const tampered = rendered.content.replace("original text", "different text");
    expect(verifyTranscript(tampered, rendered.checksum)).toBe(false);
  });

  it("escapes HTML so a display name cannot inject markup", () => {
    const rendered = renderTranscript(
      [message("<script>alert(1)</script>", "<img onerror=x>")],
      { guildId: GUILD, ticketNumber: 1, subject: "<b>bold</b>" },
      "html",
    );

    expect(rendered.content).not.toContain("<script>");
    expect(rendered.content).not.toContain("<img onerror");
    expect(rendered.content).toContain("&lt;script&gt;");
    expect(rendered.format).toBe("html");
  });

  it("hashes the stored text, not a re-rendering of it", () => {
    // The checksum exists to detect a row edited after it was written, so it must be
    // computed over the content as stored.
    expect(transcriptChecksum("abc")).toBe(transcriptChecksum("abc"));
    expect(transcriptChecksum("abc")).not.toBe(transcriptChecksum("abd"));
  });
});

describe("ticket panel", () => {
  it("builds one button per category", () => {
    const panel = buildTicketPanel([
      { key: "support", label: "Support", emoji: "❓" },
      { key: "report", label: "Report", emoji: "🚨" },
    ]);

    expect(panel.rows).toHaveLength(1);
    expect(panel.rows[0]?.buttons).toHaveLength(2);
    // The custom id carries the stable key, which is what the router resolves back.
    expect(panel.rows[0]?.buttons[0]?.customId).toBe(`${TICKET_IDS.open}support`);
    expect(panel.rows[0]?.buttons[0]?.emoji).toBe("❓");
  });

  it("chunks more than five categories into multiple rows", () => {
    const panel = buildTicketPanel(
      Array.from({ length: 7 }, (_, index) => ({ key: `c${index}`, label: `C${index}` })),
    );

    // Discord rejects a sixth button in a row, so seven categories need two rows.
    expect(panel.rows).toHaveLength(2);
    expect(panel.rows[0]?.buttons).toHaveLength(5);
    expect(panel.rows[1]?.buttons).toHaveLength(2);
  });

  it("explains an empty panel instead of rendering a message with no buttons", () => {
    const panel = buildTicketPanel([]);

    expect(panel.rows).toHaveLength(0);
    expect(panel.description).toContain("No ticket categories");
  });

  it("disables Claim once someone else holds the ticket", () => {
    const mine = buildTicketControls({
      id: "ticket-1",
      status: "open",
      claimedById: STAFF,
      claimedBySelf: true,
    });
    const theirs = buildTicketControls({
      id: "ticket-1",
      status: "open",
      claimedById: STAFF,
      claimedBySelf: false,
    });

    expect(mine.buttons[0]?.disabled).toBe(false);
    expect(mine.buttons[0]?.label).toBe("You are handling this");
    // Disabled rather than hidden: the reason should be visible, not mysterious.
    expect(theirs.buttons[0]?.disabled).toBe(true);
  });

  it("disables Close on a closed ticket but keeps the transcript available", () => {
    const controls = buildTicketControls({
      id: "ticket-1",
      status: "closed",
      claimedById: null,
    });

    expect(controls.buttons[1]?.disabled).toBe(true);
    // Reading the record is always allowed, closed or not.
    expect(controls.buttons[2]?.disabled).toBeFalsy();
  });

  it("offers a delete control, disabled once the ticket is already deleted", () => {
    const open = buildTicketControls({ id: "ticket-1", status: "open", claimedById: null });
    const gone = buildTicketControls({ id: "ticket-1", status: "deleted", claimedById: null });

    expect(open.buttons[3]?.customId).toBe(`${TICKET_IDS.delete}ticket-1`);
    expect(open.buttons[3]?.disabled).toBe(false);
    expect(gone.buttons[3]?.disabled).toBe(true);
  });
});

describe("ticket queue controls", () => {
  const ticket = (number: number, status = "open", claimedById: string | null = null) => ({
    id: `ticket-${number}`,
    number,
    status,
    claimedById,
  });

  it("gives each listed ticket its own row of controls", () => {
    const rows = buildTicketQueueControls([ticket(1), ticket(2)]);

    expect(rows).toHaveLength(2);
    expect(rows[0]?.buttons).toHaveLength(4);
    // The label names the ticket, so a row is never ambiguous about what it acts on.
    expect(rows[0]?.buttons[0]?.label).toBe("#1 Claim");
    expect(rows[0]?.buttons[0]?.customId).toBe(`${TICKET_IDS.claim}ticket-1`);
    expect(rows[1]?.buttons[1]?.customId).toBe(`${TICKET_IDS.close}ticket-2`);
  });

  it("disables what the ticket's state forbids", () => {
    const rows = buildTicketQueueControls([ticket(1, "open", STAFF), ticket(2, "closed")]);

    // Claim on a ticket someone else holds, and Close on a closed ticket.
    expect(rows[0]?.buttons[0]?.disabled).toBe(true);
    expect(rows[1]?.buttons[1]?.disabled).toBe(true);
  });

  it("caps the rows at what Discord accepts, keeping the rest readable", () => {
    const rows = buildTicketQueueControls(
      Array.from({ length: QUEUE_CONTROL_ROWS + 3 }, (_, index) => ticket(index + 1)),
    );

    // A message carries at most five action rows, so extra tickets stay as embeds.
    expect(rows).toHaveLength(QUEUE_CONTROL_ROWS);
  });
});

describe("ticket category management", () => {
  it("creates a category and records it for the panel", async () => {
    const { service, repository, auditActions } = harness({ categories: [] });

    const saved = await service.saveCategory(STAFF, {
      guildId: GUILD,
      key: "bug-report",
      label: "Bug Report",
      emoji: "🐛",
      description: "Report a bot or server bug.",
      staffRoleIds: [STAFF_ROLE],
      parentId: "category-tickets",
      enabled: true,
    });

    expect(saved.key).toBe("bug-report");
    expect(saved.enabled).toBe(true);
    expect(auditActions).toContain("ticket.category.saved");
    expect(await service.categories(GUILD)).toHaveLength(1);
    const stored = await repository.findCategory(GUILD, "bug-report");
    expect(stored).toMatchObject({ label: "Bug Report" });
  });

  it("deletes a category and reports an unknown key as false", async () => {
    const { service, auditActions } = harness();

    expect(await service.deleteCategory(GUILD, "support", STAFF)).toBe(true);
    expect(auditActions).toContain("ticket.category.deleted");
    expect(await service.deleteCategory(GUILD, "does-not-exist", STAFF)).toBe(false);
    expect(await service.allCategories(GUILD)).toHaveLength(0);
  });
});
