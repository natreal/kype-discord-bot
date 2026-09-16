import { stat } from "node:fs/promises";
import path from "node:path";

import { defineConfig } from "vitest/config";

// `import.meta.dirname` is the directory of this config file, which is the
// project root. It is used instead of `new URL(...)` because Vite may rewrite
// `import.meta.url` when it loads a config, which would silently shift the base.
const projectRoot = import.meta.dirname;

/**
 * The application targets Node.js ESM (`NodeNext`), so relative imports carry a
 * `.js` extension even though the sources are `.ts`. Neither Vite nor Vitest
 * resolves those on its own, so this plugin maps each relative `.js` specifier
 * onto its `.ts` counterpart.
 *
 * The project root is tried first because host tooling reports importer paths
 * relative to the workspace rather than to the project folder.
 */
function nodeNextTypeScriptResolution() {
  return {
    name: "node-next-typescript-resolution",
    enforce: "pre" as const,
    async resolveId(source: string, importer: string | undefined) {
      // Bare specifiers (`discord.js`, `node:fs`) must be left to Vite.
      if (!source.startsWith(".") || !source.endsWith(".js")) {
        return null;
      }

      const relative = source.replace(/\.js$/, ".ts");
      const fromDirectory = importer ? path.dirname(importer) : projectRoot;
      // Specifiers are written relative to the importing file, so leading `../`
      // segments must be removed before re-rooting them at the project folder.
      const withoutTraversal = relative.replace(/^(\.\.\/)+/, "");

      const candidates = [
        // As referenced from `tests/*.test.ts` (e.g. `../../src/...`).
        path.resolve(projectRoot, withoutTraversal),
        // As referenced from `tests/**` (e.g. `../helpers/config.js`).
        path.resolve(projectRoot, "tests", withoutTraversal),
        // As referenced from `src/**` (e.g. `./event.types.js`).
        path.resolve(fromDirectory, relative),
      ];

      for (const candidate of candidates) {
        if (candidate.startsWith(projectRoot) && (await fileExists(candidate))) {
          return candidate;
        }
      }

      return null;
    },
  };
}

async function fileExists(candidate: string): Promise<boolean> {
  try {
    const stats = await stat(candidate);
    return stats.isFile();
  } catch {
    return false;
  }
}

export default defineConfig({
  plugins: [nodeNextTypeScriptResolution()],
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 15_000,
    server: {
      // Vite must not externalize application modules: they are `.ts` files that
      // need transformation, and Node.js cannot execute them directly.
      deps: {
        inline: [/src\//, /tests\//],
      },
    },
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.ts"],
      exclude: ["src/generated/**", "src/**/index.ts"],
    },
  },
});
