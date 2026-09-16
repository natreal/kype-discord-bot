/**
 * Process entry point.
 *
 * Deliberately tiny: it only boots the application. All wiring lives in
 * `src/app.ts` so that the bootstrap stays readable as the platform grows.
 */
import { main } from "./app.js";

await main();
