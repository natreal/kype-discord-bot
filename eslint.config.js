// ESLint flat configuration (ESLint 10) with typed linting for `src/`.
//
// Files outside `src/` (scripts, tests, config files) are linted without
// type information because they are excluded from the application tsconfig.

import js from "@eslint/js";
import prettier from "eslint-config-prettier/flat";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "coverage/**",
      "src/generated/**",
      "prisma/migrations/**",
    ],
  },

  // Baseline rules for every JavaScript/TypeScript file in the repository.
  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
    },
    rules: {
      "no-console": "error",
      eqeqeq: ["error", "smart"],
      "no-var": "error",
      "prefer-const": "error",
      "object-shorthand": ["error", "always"],
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },

  // Application code: full type-aware linting.
  {
    files: ["src/**/*.ts"],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/require-await": "error",
      "@typescript-eslint/restrict-template-expressions": [
        "error",
        { allowNumber: true, allowBoolean: true },
      ],
    },
  },

  // Scripts and tests: no type-aware rules (they are not part of tsconfig).
  {
    files: ["scripts/**/*.ts", "tests/**/*.ts", "vitest.config.ts", "prisma.config.ts"],
    rules: {
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-call": "off",
    },
  },

  // Prettier must come last so formatting-related rules stay disabled.
  prettier,
);
