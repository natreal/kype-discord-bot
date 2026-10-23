/**
 * AnyPS5 scan tests.
 *
 * The project publishes its implementation statistics from `tools/progress.py`, and
 * the bot must never disagree with them. These tests pin the agreement:
 *
 *   1. **the port reproduces `progress.py` on a real file.** `libSceAc3Enc`'s own
 *      `Export.cpp` — seven exports, all stubs — must scan as 0 done / 7 todo, the
 *      numbers upstream reports for it;
 *   2. **"done" is not "implemented".** A function that only returns a constant is
 *      counted as done *and* inert, transitively through a wrapper, exactly as the
 *      Python does;
 *   3. **comments and literals cannot fake a call.** A stub name inside a comment
 *      does not make the enclosing function a stub;
 *   4. **the rules come from the script.** If `tools/progress.py` stops declaring a
 *      rule the scan relies on, the scan refuses to guess instead of counting with a
 *      stale pattern.
 */
import { describe, expect, it } from "vitest";

import {
  DEFINITION_SOURCE,
  ScriptDriftError,
  readScanRules,
  scanArchive,
  supportedShaders,
} from "../../src/services/anyps5/archive-scan.js";
import { scanLibrary, toScanText } from "../../src/services/anyps5/scan.js";
import { parseProgressSnapshot } from "../../src/services/anyps5/progress.js";
import { AC3_EXPORT, ISA_LIST, MIX_EXPORT, OPCODE_HEADER, PROGRESS_SCRIPT } from "../fixtures/anyps5.js";
import { buildTarGz } from "../helpers/tar.js";

describe("scan rules", () => {
  it("extracts the definition pattern and the stub name from progress.py", () => {
    const rules = readScanRules(PROGRESS_SCRIPT);

    expect(rules.stub).toBe("NotImplemented_nid_no_patch");
    // Compared character for character against the pattern the port implements: a
    // silent divergence would make every later count meaningless.
    expect(rules.definition.source).toBe(DEFINITION_SOURCE);
  });

  it("refuses to scan when progress.py renames the stub helper", () => {
    const drifted = PROGRESS_SCRIPT.replace(
      'STUB = "NotImplemented_nid_no_patch"',
      'STUB = "SomeOtherStub"',
    );

    expect(() => readScanRules(drifted)).not.toThrow();
    expect(() => scanArchive(buildTarGz([]), drifted, OPCODE_HEADER, ISA_LIST)).toThrow(
      ScriptDriftError,
    );
  });

  it("refuses to scan when the definition pattern changes upstream", () => {
    const drifted = PROGRESS_SCRIPT.replace("APS5_VABI", "APS5_ABI");

    expect(() => scanArchive(buildTarGz([]), drifted, OPCODE_HEADER, ISA_LIST)).toThrow(
      ScriptDriftError,
    );
  });

  it("reports a missing declaration instead of defaulting it", () => {
    expect(() => readScanRules(PROGRESS_SCRIPT.replace(/^STUB = .*$/m, ""))).toThrow(
      /no longer declares STUB/,
    );
  });
});

describe("library scanning", () => {
  it("counts the real libSceAc3Enc file as seven unimplemented exports", () => {
    const group = scanLibrary("libSceAc3Enc", [{ path: "Export.cpp", text: AC3_EXPORT }]);

    expect(group.name).toBe("libSceAc3Enc");
    expect(group.label).toBe("Ac3Enc");
    expect(group.done).toBe(0);
    expect(group.todo).toBe(7);
    expect(group.todoNames).toContain("sceAc3EncCreateEncoder");
    expect(group.inertNames).toEqual([]);
  });

  it("separates implemented, inert and forwarded-inert functions", () => {
    const group = scanLibrary("libSceAcMix", [{ path: "Export.cpp", text: MIX_EXPORT }]);

    // SetUp returns a constant, Forwarded only calls that constant, Live does work,
    // Missing reaches the stub through a helper, Commented only mentions it and is
    // therefore a constant return too — inert, as upstream counts it.
    expect(group.doneNames).toEqual(
      ["sceMixCommented", "sceMixForwarded", "sceMixLive", "sceMixSetUp"].sort(),
    );
    expect(group.todoNames).toEqual(["sceMixMissing"]);
    expect(group.inertNames).toEqual(
      ["sceMixCommented", "sceMixForwarded", "sceMixSetUp"].sort(),
    );
    expect(group.done).toBe(4);
    expect(group.todo).toBe(1);
  });

  it("skips tests directories, as upstream does", () => {
    const group = scanLibrary("libSceAcMix", [
      { path: "tests/Export.cpp", text: MIX_EXPORT },
      { path: "Export.cpp", text: AC3_EXPORT },
    ]);

    expect(group.done).toBe(0);
    expect(group.todo).toBe(7);
  });

  it("blanks comments but collapses a literal to one token", () => {
    const text = toScanText('// stub\nconst char* s = "NotImplemented_nid_no_patch";\nint x = 1;\n');

    expect(text).not.toContain("//");
    // A literal becomes the bare word `LITERAL`, exactly as `progress.py`'s `code()`
    // does, so a stub's name inside a string can never be read as a call.
    expect(text).toContain("const char* s = LITERAL;");
    expect(text).toContain("int x = 1;");
  });
});

describe("archive scanning", () => {
  const files = [
    { path: "tools/progress.py", content: PROGRESS_SCRIPT },
    { path: "core/libs/prx/libSceAc3Enc/Export.cpp", content: AC3_EXPORT },
    { path: "core/libs/prx/libSceAcMix/Export.cpp", content: MIX_EXPORT },
    {
      path: "core/shader/recompiler/RdnaDecoder/include/RdnaDecoder/RdnaOpcode.hpp",
      content: OPCODE_HEADER,
    },
    { path: "tools/rdna_isa.txt", content: ISA_LIST },
    { path: "README.md", content: "# AnyPS5" },
    // Long enough that the archive writer emits a GNU `L` entry for it, like GitHub.
    {
      path: "core/libs/prx/libSceAcMix/nested/dir/that/is/deep/Enough/For/A/Long/Name/Extra.cpp",
      content: `int APS5_VABI sceMixNestedExtra(int value) {\n    return 0;\n}\n`,
    },
  ];

  it("scans an archive shaped like GitHub's, long names included", () => {
    const scan = scanArchive(buildTarGz(files, { longNames: true }), PROGRESS_SCRIPT, OPCODE_HEADER, ISA_LIST);

    expect(scan.libraries.map((group) => group.name)).toEqual(["libSceAc3Enc", "libSceAcMix"]);
    const mixed = scan.libraries.find((group) => group.name === "libSceAcMix");
    // The deeply nested file belongs to the same library, so its exports count too.
    expect(mixed?.todo).toBe(1);
    expect(mixed?.done).toBeGreaterThanOrEqual(4);
  });

  it("counts only library sources, never the script or a document", () => {
    const scan = scanArchive(buildTarGz(files), PROGRESS_SCRIPT, OPCODE_HEADER, ISA_LIST);
    const names = scan.libraries.flatMap((group) => [...group.doneNames, ...group.todoNames]);

    expect(names).not.toContain("collect_shaders");
  });

  it("derives the shader statistic from the opcode enum and the ISA list", () => {
    const shaders = supportedShaders(readScanRules(PROGRESS_SCRIPT), OPCODE_HEADER, ISA_LIST);

    // `V_UNUSED_F32` is in the ISA list but not in the enum, so it stays unsupported.
    expect(shaders.supported).toEqual(["S_DEBUG_BARRIER", "S_MOV_B32", "V_ADD_F32", "V_MOV_B32"]);
    expect(shaders.isa).toHaveLength(5);
  });
});

describe("progress snapshot validation", () => {
  const snapshot = {
    libraries: {
      done: 5543,
      total: 11697,
      percent: 47.39,
      groups: [
        {
          name: "libSceAc3Enc",
          label: "Ac3Enc",
          done: 0,
          todo: 7,
          done_names: [],
          todo_names: ["sceAc3EncCreateEncoder"],
          inert_names: [],
        },
      ],
    },
    shaders: { done: 1166, total: 1166, percent: 100, groups: [] },
  };

  it("keeps the published numbers verbatim, including a shared-sources group", () => {
    const parsed = parseProgressSnapshot({
      ...snapshot,
      libraries: {
        ...snapshot.libraries,
        groups: [
          ...snapshot.libraries.groups,
          { name: "libSceAbstract", done: 0, todo: 0, shared_sources: "libSceAgc" },
        ],
      },
    });

    expect(parsed.libraries.done).toBe(5543);
    expect(parsed.libraries.percent).toBe(47.39);
    expect(parsed.libraries.groups[0]?.total).toBe(7);
    expect(parsed.libraries.groups[0]?.percent).toBe(0);
    expect(parsed.libraries.groups[1]?.sharedSources).toBe("libSceAgc");
  });

  it("rejects a percentage outside 0-100 instead of clamping it", () => {
    expect(() =>
      parseProgressSnapshot({ ...snapshot, libraries: { ...snapshot.libraries, percent: 120 } }),
    ).toThrow(/unexpected shape/);
  });

  it("rejects a snapshot missing a section", () => {
    expect(() => parseProgressSnapshot({ libraries: snapshot.libraries })).toThrow(
      /unexpected shape/,
    );
  });
});
