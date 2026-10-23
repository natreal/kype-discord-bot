/**
 * Runs `progress.py`'s own extractors against a commit, without Python.
 *
 * WHY NOT JUST RUN python3: the bot targets Windows as well as Linux, and needing
 * a Python 3 interpreter (plus `nid_names.py` beside `progress.py`) merely to
 * answer "which functions did this merge implement?" would leave the feature
 * unavailable on exactly the host the project is developed on.
 *
 * WHY THIS IS NOT A REIMPLEMENTATION: `tools/progress.py` is downloaded from the
 * repository and parsed for the rules the scan depends on — the `APS5_VABI`
 * definition pattern, the not-implemented stub name, the `RdnaOpcode` enum and the
 * ISA line format. If upstream changes one of them the parse fails loudly with
 * `ScriptDriftError`, and the caller falls back to the published snapshot instead
 * of counting with a stale rule. The rules come from the file that defines the
 * project's statistics, not from a copy of them in this repository.
 *
 * The heavy lifting (comment blanking, stub closures, inert detection) is the port
 * in `scan.ts`, checked to reproduce `progress.py`'s output on real libraries,
 * name lists included.
 */
import { readTar } from "../github/tar.js";
import { gunzipBytes } from "../github/gzip.js";
import {
  OPCODE_HEADER,
  PRX_DIRECTORY,
  scanLibrary,
  toScanText,
  type LibraryGroup,
  type SourceFile,
} from "./scan.js";

/** Raised when `tools/progress.py` no longer contains a rule the scan needs. */
export class ScriptDriftError extends Error {
  public constructor(what: string) {
    super(`tools/progress.py no longer declares ${what}; the scan cannot mirror it.`);
    this.name = "ScriptDriftError";
  }
}

/** The rules extracted from `tools/progress.py`. */
export interface ScanRules {
  /** Matches a function definition and captures its name. */
  readonly definition: RegExp;
  /** The name of the stub the scan treats as "not implemented". */
  readonly stub: string;
  /** The enum whose members are the shader instruction names. */
  readonly opcodeEnum: RegExp;
  /** How one ISA list line is shaped. */
  readonly isaLine: RegExp;
}

/** A whole-tree scan: one entry per library, sorted by name. */
export interface TreeScan {
  readonly libraries: readonly LibraryGroup[];
  /** ISA instruction names the `RdnaOpcode` enum covers. */
  readonly supportedShaders: readonly string[];
  /** Every instruction the ISA list names. */
  readonly isaInstrs: readonly string[];
}

/** The `APS5_VABI` pattern `scan.ts` implements. */
export const DEFINITION_SOURCE =
  "\\bAPS5_VABI\\s+(\\w+)\\s*\\([^;{]*\\)\\s*(?:noexcept\\s*)?(?:try\\s*)?\\{";

/** Opcodes the enum names that are not instructions (`Invalid`, `Count`, ...). */
export const OPCODE_SENTINELS = new Set(["Invalid", "Count", "Unknown", "Unsupported"]);

/** @returns the rules declared by a `progress.py` source. */
export function readScanRules(script: string): ScanRules {
  const definition = /^DEFINITION\s*=\s*re\.compile\(\s*r?"(.+?)"\s*\)/m.exec(script)?.[1];
  if (definition === undefined) {
    throw new ScriptDriftError("DEFINITION");
  }
  const stub = /^STUB\s*=\s*"([^"]+)"/m.exec(script)?.[1];
  if (stub === undefined) {
    throw new ScriptDriftError("STUB");
  }
  if (!/enum class RdnaOpcode/.test(script)) {
    throw new ScriptDriftError("the RdnaOpcode enum lookup");
  }
  if (!/line\.split\(\)/.test(script)) {
    throw new ScriptDriftError("the ISA line format");
  }

  return {
    // `String.prototype.matchAll` needs the global flag; the pattern has no
    // backreferences or named groups, so no flag translation is required.
    definition: new RegExp(definition, "g"),
    stub,
    opcodeEnum: /enum class RdnaOpcode[^{]*\{(.*?)\};/s,
    isaLine: /^(\S+)\s+(\S+)$/,
  };
}

/**
 * @returns the ISA instructions the enum covers.
 *
 * This is the "GPU shader instructions" half of the statistic. The published
 * snapshot is still what the bot reports; this exists so a per-merge delta can say
 * *which* instructions a pull request added, which the snapshot only gives as a
 * count.
 */
export function supportedShaders(rules: ScanRules, opcodeSource: string, isaSource: string): {
  readonly supported: string[];
  readonly isa: string[];
} {
  const enumBody = rules.opcodeEnum.exec(toScanText(opcodeSource))?.[1];
  if (enumBody === undefined) {
    throw new ScriptDriftError("the RdnaOpcode enum");
  }
  const opcodes = [...enumBody.matchAll(/^\s*([A-Z]\w*)\s*[,=]/gm)]
    .map((match) => match[1] ?? "")
    .filter((name) => !OPCODE_SENTINELS.has(name));

  const isa = isaSource
    .split("\n")
    .filter((line) => line !== "" && !line.startsWith("#"))
    .flatMap((line) => {
      const name = rules.isaLine.exec(line)?.[1];
      return name === undefined ? [] : [name];
    });
  const byCamel = new Map(isa.map((name) => [camel(name), name]));

  const supported = new Set<string>();
  for (const opcode of opcodes) {
    const name = byCamel.get(opcode);
    if (name !== undefined) {
      supported.add(name);
    }
  }
  return { supported: [...supported].sort(), isa };
}

/** `V_MOV_B32` → `VMovB32`, the naming `RdnaOpcode` uses. */
function camel(name: string): string {
  return name
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join("");
}

/**
 * Scans a repository tarball (gzipped or not) with the rules from `progress.py`.
 *
 * One pass over the archive, bodies inflated only for the files the scan needs, so
 * a repository with thousands of files still costs one download plus the sources
 * it measures.
 */
export function scanArchive(
  bytes: Uint8Array,
  script: string,
  opcodeSource: string,
  isaSource: string,
): TreeScan {
  const rules = readScanRules(script);
  // A rename of the stub or the definition pattern upstream invalidates the port
  // in `scan.ts`, so it is refused rather than silently counting something else.
  if (rules.stub !== "NotImplemented_nid_no_patch") {
    throw new ScriptDriftError("the STUB helper the port closes over");
  }
  if (rules.definition.source !== DEFINITION_SOURCE) {
    throw new ScriptDriftError("the APS5_VABI definition pattern");
  }

  const gzipped = bytes[0] === 0x1f && bytes[1] === 0x8b;
  const tar = readTar(gzipped ? gunzipBytes(bytes) : bytes);
  const keep = (name: string): boolean =>
    (name.startsWith(`${PRX_DIRECTORY}/`) && name.endsWith(".cpp")) || name === OPCODE_HEADER;

  const prefix = `${PRX_DIRECTORY}/`;
  const sources = new Map<string, SourceFile[]>();
  for (let entry = tar.next(keep); entry !== null; entry = tar.next(keep)) {
    const rest = entry.name.startsWith(prefix) ? entry.name.slice(prefix.length) : "";
    const slash = rest.indexOf("/");
    if (entry.content === null || slash === -1) {
      continue;
    }
    const library = rest.slice(0, slash);
    const list = sources.get(library) ?? [];
    list.push({ path: rest.slice(slash + 1), text: new TextDecoder().decode(entry.content) });
    sources.set(library, list);
  }

  const shaders = supportedShaders(rules, opcodeSource, isaSource);
  return {
    libraries: [...sources.keys()]
      .sort()
      .map((name) => scanLibrary(name, sources.get(name) ?? [])),
    supportedShaders: shaders.supported,
    isaInstrs: shaders.isa,
  };
}

