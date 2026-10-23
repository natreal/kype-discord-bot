/**
 * A tiny tar writer and tar/gzip encoder, for the archive-scan tests.
 *
 * The production reader is tested against archives shaped exactly like GitHub's:
 * a `<repo>-<sha>/` root, `ustar` headers, and a GNU `L` long-name entry for the
 * paths longer than a hundred bytes (which the AnyPS5 tree really has). Building
 * those here keeps the test hermetic — no network, no fixture binary in the repo —
 * while still exercising the reader's real parsing.
 */
import { gzipSync } from "node:zlib";

/** One file to place in the archive. */
export interface TarSource {
  /** Path relative to the archive root (the root is added by `buildTarGz`). */
  readonly path: string;
  readonly content: string | Uint8Array;
}

/** The root directory GitHub gives an archive: `<repo>-<short sha>/`. */
export const ARCHIVE_ROOT = "AnyPS5-abc1234";

/**
 * @returns a gzipped tar image containing `files` under `ARCHIVE_ROOT`.
 *
 * @param longNames writes path names through a GNU `L` entry even when the name
 * would fit, so the reader's long-name path is exercised either way.
 */
export function buildTarGz(files: readonly TarSource[], options: { longNames?: boolean } = {}): Uint8Array {
  const blocks: Uint8Array[] = [];

  for (const file of files) {
    const name = `${ARCHIVE_ROOT}/${file.path}`;
    if (options.longNames === true || Buffer.byteLength(name) > 100) {
      blocks.push(header("././@LongLink", Buffer.byteLength(name) + 1, "L"));
      blocks.push(pad(Buffer.from(`${name}\0`, "utf8")));
    }
    const body = typeof file.content === "string" ? Buffer.from(file.content, "utf8") : Buffer.from(file.content);
    blocks.push(header(name.slice(0, 100), body.length, "0"));
    blocks.push(pad(body));
  }

  // Two zero blocks terminate a tar archive.
  blocks.push(new Uint8Array(1024));
  return new Uint8Array(gzipSync(Buffer.concat(blocks.map((block) => Buffer.from(block)))));
}

/** Builds one 512-byte `ustar` header. */
function header(name: string, size: number, type: string): Uint8Array {
  const block = new Uint8Array(512);
  writeString(block, 0, 100, name);
  writeOctal(block, 100, 8, 0o644);
  writeOctal(block, 108, 8, 0);
  writeOctal(block, 116, 8, 0);
  writeOctal(block, 124, 12, size);
  writeOctal(block, 136, 12, Math.floor(Date.now() / 1_000));
  // Checksum is computed over the header with its own field treated as spaces.
  for (let i = 148; i < 156; i += 1) {
    block[i] = 0x20;
  }
  block[156] = type.charCodeAt(0);
  writeString(block, 257, 6, "ustar");
  writeString(block, 263, 2, "00");
  const checksum = block.reduce((sum, byte) => sum + (byte ?? 0), 0);
  writeOctal(block, 148, 7, checksum);
  block[155] = 0x20;
  return block;
}

function writeString(block: Uint8Array, offset: number, length: number, value: string): void {
  const bytes = Buffer.from(value, "utf8").subarray(0, length);
  block.set(bytes, offset);
}

function writeOctal(block: Uint8Array, offset: number, length: number, value: number): void {
  const text = value.toString(8).padStart(length - 1, "0");
  writeString(block, offset, length - 1, text);
  block[offset + length - 1] = 0;
}

/** Pads a body to the next 512-byte boundary. */
function pad(body: Buffer): Uint8Array {
  const remainder = body.length % 512;
  const padding = remainder === 0 ? 0 : 512 - remainder;
  return new Uint8Array(Buffer.concat([body, Buffer.alloc(padding)]));
}
