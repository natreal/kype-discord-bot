/**
 * A stand-in for one library of the AnyPS5 tree.
 *
 * `libSceAc3Enc/Export.cpp` is the project's real file, copied verbatim: seven
 * exports that all call `NotImplemented_nid_no_patch`, which is the canonical
 * "declared but not implemented" shape. Scanning it must produce `done: 0`,
 * `todo: 7` — the numbers `tools/progress.py` produces for it.
 *
 * `libSceAcMix` is written for this suite, in the same style, to cover the three
 * outcomes one file can produce at once:
 *
 * - `SetUp` is implemented and **inert**: it only returns a constant, which is
 *   exactly what the "behaviourally empty" statistic exists to expose;
 * - `Forwarded` is implemented but only calls an inert wrapper, so it must also be
 *   inert (the check is transitive, as upstream's is);
 * - `Live` touches its argument and returns a real value, so it must not be.
 */
export const AC3_EXPORT = `#include <cstdint>
#include <cstddef>
#include "SceTypes.hpp"
#include "prx/libc/include/General.hpp"

extern "C" {

int APS5_VABI sceAc3EncCreateEncoder() {
    NotImplemented_nid_no_patch(__func__);
    return 0;
}

int APS5_VABI sceAc3EncDeleteEncoder() {
    NotImplemented_nid_no_patch(__func__);
    return 0;
}

int APS5_VABI sceAc3EncEncode() {
    NotImplemented_nid_no_patch(__func__);
    return 0;
}

int APS5_VABI sceAc3EncEncodeAsync() {
    NotImplemented_nid_no_patch(__func__);
    return 0;
}

int APS5_VABI sceAc3EncFlush() {
    NotImplemented_nid_no_patch(__func__);
    return 0;
}

int APS5_VABI sceAc3EncIsEncoding() {
    NotImplemented_nid_no_patch(__func__);
    return 0;
}

int APS5_VABI sceAc3EncWaitEncode() {
    NotImplemented_nid_no_patch(__func__);
    return 0;
}

}`;

/** One library that covers implemented, inert, forwarded-inert and stub cases. */
export const MIX_EXPORT = `#include "SceTypes.hpp"

static int Constant() {
    return 0;
}

int APS5_VABI sceMixSetUp(void* self) {
    (void)self;
    return 0;
}

int APS5_VABI sceMixForwarded(void* self) {
    return Constant();
}

int APS5_VABI sceMixLive(int value) {
    if (value < 0) {
        return Constant();
    }
    return value + 1;
}

int APS5_VABI sceMixMissing(void* self) {
    Fail();
    return 0;
}

void Fail() {
    NotImplemented_nid_no_patch(__func__);
}

// A comment mentioning NotImplemented_nid_no_patch must not make Live a stub.
int APS5_VABI sceMixCommented(int value) {
    // NotImplemented_nid_no_patch(__func__);
    return value;
}
`;

/**
 * A minimal stand-in for `tools/progress.py`.
 *
 * Only the four declarations `readScanRules` extracts are reproduced, in the exact
 * form the real script writes them, so a drift test can mutate one and prove the
 * scanner refuses to guess.
 */
export const PROGRESS_SCRIPT = `import re

DEFINITION = re.compile(r"\\bAPS5_VABI\\s+(\\w+)\\s*\\([^;{]*\\)\\s*(?:noexcept\\s*)?(?:try\\s*)?\\{")
STUB = "NotImplemented_nid_no_patch"


def collect_shaders():
    enum = re.search(r"enum class RdnaOpcode[^{]*\\{(.*?)\\};", OPCODES.read_text(encoding="utf-8", errors="ignore"), re.S).group(1)
    for line in ISA.read_text(encoding="utf-8", errors="ignore").splitlines():
        if line and not line.startswith("#"):
            name, encoding = line.split()
`;

/** The RDNA opcode enum, as the project declares it (sentinels included). */
export const OPCODE_HEADER = `namespace RdnaDecoder {

enum class RdnaOpcode : std::uint16_t {
  Invalid = 0,
  SMovB32,
  VAddF32,
  VMovB32,
  SDebugBarrier,
  Count,
};

}`;

/** Two instruction encodings, one of which the enum does not name. */
export const ISA_LIST = `# name encoding
S_MOV_B32 SOP1
S_DEBUG_BARRIER SOP1
V_ADD_F32 VOP2
V_MOV_B32 VOP1
V_UNUSED_F32 VOP1
`;
