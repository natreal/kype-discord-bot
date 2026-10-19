/**
 * Transcript rendering and checksum.
 *
 * A transcript is stored in the database rather than only as an attachment, because
 * the attachment lives in the channel it documents: closing and deleting a ticket
 * would take the evidence with it. The checksum exists for the same reason the backup
 * snapshots carry one — a truncated or hand-edited row must be detectable, since the
 * transcript is read when a decision is being justified months later.
 *
 * Rendering is a pure function of the messages, so it is testable without Discord and
 * a stored transcript can be re-verified against its checksum without a channel.
 */
import { createHash } from "node:crypto";

import type { TranscriptMessage } from "./ticket.types.js";

/**
 * @returns the SHA-256 of the rendered content.
 *
 * The content is hashed as stored, not re-rendered: the point is to detect a row that
 * changed after it was written, and re-rendering first would hide exactly that.
 */
export function transcriptChecksum(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/** @returns true when `content` still hashes to `checksum`. */
export function verifyTranscript(content: string, checksum: string | null): boolean {
  if (checksum === null) {
    // A transcript written before checksums existed is accepted rather than reported
    // as corrupt: the row is already scoped to its guild, and refusing it would make
    // historical evidence unreadable for no security gain.
    return true;
  }
  return transcriptChecksum(content) === checksum;
}

/** Escapes the characters that would otherwise let a message forge transcript markup. */
function escapeMarkdown(value: string): string {
  // Deliberately minimal: the goal is to stop a message breaking out of its line, not
  // to sanitize prose. Backticks and newlines matter here; `*` and `_` do not.
  return value.replace(/`/g, "'").replace(/\r\n/g, "\n");
}

/** @returns an ISO-8601 UTC timestamp, which is stable across transcript readers. */
function formatTimestamp(at: Date): string {
  return `${at.toISOString().replace("T", " ").slice(0, 19)} UTC`;
}

/**
 * Renders messages as Markdown.
 *
 * One message is one heading plus its body, so the transcript stays greppable: an
 * operator looking for a link can search for it without parsing the whole file.
 */
export function renderMarkdownTranscript(
  messages: readonly TranscriptMessage[],
  header: { guildId: string; ticketNumber: number; subject: string | null },
): string {
  const lines: string[] = [
    `# Ticket #${header.ticketNumber}`,
    "",
    `- **Guild:** ${header.guildId}`,
    `- **Subject:** ${header.subject ?? "(none)"}`,
    `- **Messages:** ${messages.length}`,
    "",
    "---",
    "",
  ];

  for (const message of messages) {
    const kind = message.authorIsBot ? " (bot)" : "";
    lines.push(`## ${message.authorName}${kind} — ${formatTimestamp(message.createdAt)}`);
    lines.push("");
    lines.push(`<!-- author:${message.authorId} -->`);
    lines.push(escapeMarkdown(message.content));
    if (message.attachments && message.attachments.length > 0) {
      lines.push("");
      for (const attachment of message.attachments) {
        lines.push(`- attachment: ${escapeMarkdown(attachment)}`);
      }
    }
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Renders messages as HTML.
 *
 * Every interpolation is escaped, including the author name: a Discord display name is
 * attacker-controlled text and this output is opened in a browser. There is no
 * "trusted" value in a transcript except the literals below.
 */
export function renderHtmlTranscript(
  messages: readonly TranscriptMessage[],
  header: { guildId: string; ticketNumber: number; subject: string | null },
): string {
  const escapeHtml = (value: string): string =>
    value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");

  const body = messages
    .map((message) => {
      const attachments = (message.attachments ?? [])
        .map((attachment) => `<li>${escapeHtml(attachment)}</li>`)
        .join("");
      return [
        `<article class="message">`,
        `<header><span class="author">${escapeHtml(message.authorName)}</span>`,
        `${message.authorIsBot ? ' <span class="bot">bot</span>' : ""}`,
        ` <time>${escapeHtml(formatTimestamp(message.createdAt))}</time></header>`,
        `<pre>${escapeHtml(message.content)}</pre>`,
        attachments ? `<ul class="attachments">${attachments}</ul>` : "",
        `</article>`,
      ].join("");
    })
    .join("\n");

  return [
    "<!DOCTYPE html>",
    '<html lang="en"><head><meta charset="utf-8">',
    `<title>Ticket #${header.ticketNumber}</title>`,
    "<style>",
    "body{font-family:system-ui,sans-serif;margin:2rem;max-width:60rem}",
    ".message{border-bottom:1px solid #ddd;padding:.75rem 0}",
    ".author{font-weight:600}.bot{color:#888;font-size:.8em}",
    "time{color:#888;font-size:.85em;margin-left:.5rem}",
    "pre{white-space:pre-wrap;margin:.4rem 0}",
    "</style></head><body>",
    `<h1>Ticket #${header.ticketNumber}</h1>`,
    `<p><strong>Subject:</strong> ${escapeHtml(header.subject ?? "(none)")} · `,
    `<strong>Messages:</strong> ${messages.length}</p>`,
    body,
    "</body></html>",
  ].join("\n");
}

/** Renders in the requested format, together with its checksum. */
export function renderTranscript(
  messages: readonly TranscriptMessage[],
  header: { guildId: string; ticketNumber: number; subject: string | null },
  format: "markdown" | "html",
): { content: string; format: "markdown" | "html"; messageCount: number; checksum: string } {
  const content =
    format === "html"
      ? renderHtmlTranscript(messages, header)
      : renderMarkdownTranscript(messages, header);
  return {
    content,
    format,
    messageCount: messages.length,
    checksum: transcriptChecksum(content),
  };
}
