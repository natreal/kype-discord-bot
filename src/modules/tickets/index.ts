/**
 * Ticket module (V6).
 *
 * Private support channels with staff assignment, a stored transcript and a panel
 * members open tickets from. The feature set is the brief's: private channels, staff
 * assignment, transcripts, per-category staff roles — plus the diagnostics endpoint.
 */
export { DiscordTicketActions } from "./discord-ticket-actions.js";
export { PrismaTicketRepository } from "./tickets.repository.js";
export {
  DEFAULT_MEMBER_TICKET_LIMIT,
  TICKET_CLOSE_GRACE_MS,
  TRANSCRIPT_MESSAGE_LIMIT,
  TicketService,
  type GuildTicketActions,
  type TicketOutcome,
  type TicketServiceOptions,
  type TranscriptMessageInput,
} from "./ticket.service.js";
export {
  renderHtmlTranscript,
  renderMarkdownTranscript,
  renderTranscript,
  transcriptChecksum,
  verifyTranscript,
} from "./ticket-transcript.js";
export {
  QUEUE_CONTROL_ROWS,
  TICKET_IDS,
  buildTicketControls,
  buildTicketPanel,
  buildTicketQueueControls,
} from "./ticket-panel.js";
export type { PanelButton, PanelRow, TicketPanel } from "./ticket-panel.js";
export type {
  TicketActionResult,
  TicketCategoryDraft,
  TicketCategoryRecord,
  TicketDraft,
  TicketPriority,
  TicketQuery,
  TicketRecord,
  TicketRepository,
  TicketStatus,
  TicketTranscriptRecord,
  TranscriptMessage,
} from "./ticket.types.js";
