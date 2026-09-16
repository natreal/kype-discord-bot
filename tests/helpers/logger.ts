/**
 * Test helper: a silent logger with the same shape as the production logger.
 */
import { vi } from "vitest";

import type { Logger } from "../../src/services/logger/index.js";

/** Logger that records nothing; use `vi.mocked` on it when asserting calls. */
export const testLogger: Logger = {
  scope: "test",
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: () => testLogger,
  withContext: () => testLogger,
};
