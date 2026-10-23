/**
 * gzip and deflate helpers.
 *
 * `node:zlib` covers both with a stable API on every Node.js the bot supports, so
 * this is a thin, typed wrapper rather than an implementation. It exists so the
 * GitHub archive reader and the scanner do not each repeat
 * `promisify(zlib.gunzip)`.
 *
 * GitHub answers a tarball request with `application/x-gzip` even when the client
 * advertises `zstd` (verified against `codeload.github.com`), so no zstd codec is
 * needed to read an archive.
 */
import { gunzipSync, inflateRawSync } from "node:zlib";

/**
 * @returns the inflated bytes of a gzip member.
 *
 * Throws a plain `Error` on corrupt input; the caller folds that into the
 * snapshot's failure path, where a truncated download is retried rather than
 * rendered.
 */
export function gunzipBytes(data: Uint8Array): Uint8Array {
  return new Uint8Array(gunzipSync(data));
}

/**
 * @returns the inflated bytes of a raw DEFLATE stream.
 *
 * Used for the `\0<deflate>` bodies GitHub writes for files above its inline
 * limit inside a tarball, and for the tarball itself when it is not gzipped.
 */
export function inflateRawBytes(data: Uint8Array): Uint8Array {
  return new Uint8Array(inflateRawSync(data));
}
