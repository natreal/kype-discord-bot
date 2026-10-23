/**
 * A read-only tar reader for GitHub archives.
 *
 * `GET /repos/{owner}/{repo}/tarball/{ref}` returns a tar stream, and the one
 * thing that matters here is that it is **streamable**: entries arrive in
 * archive order, so `tools/progress.py` (declared early by the GitHub-generated
 * tar) can be read and its sources decompressed in the same pass, and the
 * archive can be abandoned once the last source it needs has been seen. That is
 * what makes measuring a repository with thousands of files cost one download
 * per needed source instead of the whole repository.
 *
 * Only the subset of the format GitHub emits is supported: ustar and GNU long
 * names (`L`), pax `path=` records, regular files, and bodies GitHub wraps for
 * large files (see `unwrapGithubBlob`).
 */
import { inflateRawBytes } from "./gzip.js";

/** One archive entry. */
export interface TarEntry {
  /** Path as stored in the archive, with GitHub's `<repo>-<ref>/` prefix removed. */
  readonly name: string;
  /** File bytes, inflated. `null` when the caller declined the entry. */
  readonly content: Uint8Array | null;
}

/** Read-only access to the entries of a tar image, in archive order. */
export interface TarArchive {
  /**
   * Reads the next entry.
   *
   * @param keep Passed the entry name *before* its body is read, so a caller can
   * decline the expensive ones. `true` keeps the body.
   * @returns the entry (`content === null` when declined), or `null` when the
   * archive is exhausted.
   */
  next(keep?: (name: string) => boolean): TarEntry | null;
}

const BLOCK = 512;

/**
 * @returns a reader over a tar image.
 *
 * The root prefix (`<repo>-<sha>/`) is derived from the first entry of *this*
 * archive, so two archives read in one process cannot inherit each other's.
 */
export function readTar(bytes: Uint8Array): TarArchive {
  const decoder = new TextDecoder();
  let offset = 0;
  let root: string | null = null;
  // Set by a GNU `L` entry, whose body names the *next* entry.
  let longName: string | null = null;
  // Set by a pax (`x`) entry, which carries `path=` records.
  let paxPath: string | null = null;
  let done = false;

  const readField = (start: number, length: number): string => {
    const slice = bytes.subarray(offset + start, offset + start + length);
    const end = slice.indexOf(0);
    return decoder.decode(end === -1 ? slice : slice.subarray(0, end));
  };

  const toPath = (name: string): string => {
    root ??= name.includes("/") ? `${name.slice(0, name.indexOf("/"))}/` : "";
    return name.startsWith(root) ? name.slice(root.length) : name;
  };

  const next = (keep?: (name: string) => boolean): TarEntry | null => {
    while (!done && offset + BLOCK <= bytes.length) {
      const header = offset;
      if (bytes[header] === 0) {
        // Two consecutive zero blocks end the archive.
        offset += BLOCK;
        if (offset + BLOCK > bytes.length || bytes[offset] === 0) {
          done = true;
          return null;
        }
        continue;
      }

      const rawName = readField(0, 100);
      const sizeField = readField(124, 12).trim();
      const size = Number.parseInt(sizeField === "" ? "0" : sizeField, 8);
      if (!Number.isFinite(size) || size < 0) {
        done = true;
        return null;
      }
      const type = String.fromCharCode(bytes[header + 156] ?? 0);
      const prefix = readField(257, 5) === "ustar" ? readField(345, 155) : "";
      const bodyStart = header + BLOCK;
      const bodyEnd = bodyStart + size;
      offset = bodyStart + Math.ceil(size / BLOCK) * BLOCK;

      if (type === "L" || type === "x") {
        const record = decoder.decode(bytes.subarray(bodyStart, bodyEnd));
        if (type === "L") {
          longName = record.replace(/\0+$/, "");
        } else {
          paxPath = /^\d+ path=(.*)$/m.exec(record)?.[1] ?? null;
        }
        continue;
      }

      const stored = longName ?? paxPath ?? (prefix === "" ? rawName : `${prefix}/${rawName}`);
      longName = null;
      paxPath = null;

      // Directories, links and metadata entries carry no file content.
      if (type !== "0" && type !== "\0" && type !== "") {
        continue;
      }

      const name = toPath(stored);
      if (keep?.(name) === false) {
        return { name, content: null };
      }
      return { name, content: unwrapGithubBlob(bytes.subarray(bodyStart, bodyEnd)) };
    }
    done = true;
    return null;
  };

  return { next };
}

/**
 * Strips GitHub's wrapper around large files.
 *
 * Files above GitHub's inline limit are stored in the tarball as either
 * `\0<base64>\0` or a raw DEFLATE stream wrapped the same way. Both are detected
 * by shape, because the tarball does not announce which encoding it chose.
 */
export function unwrapGithubBlob(raw: Uint8Array): Uint8Array {
  if (raw.length > 4 && raw[0] === 0) {
    if (raw[1] === 0x78) {
      try {
        return inflateRawBytes(raw.subarray(1));
      } catch {
        // Not a deflate stream after all: fall through to the base64 attempt.
      }
    }
    const text = new TextDecoder().decode(raw.subarray(1, raw.length - 1));
    if (/^[A-Za-z0-9+/=\r\n]+$/.test(text)) {
      const decoded = Buffer.from(text, "base64");
      if (decoded.length > 0) {
        return new Uint8Array(decoded);
      }
    }
  }
  return raw;
}
