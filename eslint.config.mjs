// ESLint：packages 里 TypeScript / JSON 的静态检查（原来那套插件市场审核规则随插件包一起去掉了）
import { defineConfig } from "eslint/config";
import json from "@eslint/json";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig([
  {
    ignores: ["**/node_modules/**", "**/dist/**", "**/.snapshots/**", "**/*.d.ts", "**/test/**", "**/*.mjs", "**/*.config.*"],
  },
  ...tseslint.configs.recommended,
  {
    files: ["packages/**/*.ts"],
    languageOptions: { globals: { ...globals.browser, ...globals.node }, parserOptions: { projectService: true } },
    // 要在有类型信息时才准确的规则：统一按 warning 提示，不挡构建
    rules: Object.fromEntries([
      "@typescript-eslint/no-unsafe-member-access", "@typescript-eslint/no-unsafe-argument", "@typescript-eslint/no-unsafe-assignment",
      "@typescript-eslint/no-unsafe-call", "@typescript-eslint/no-unsafe-return", "@typescript-eslint/no-unnecessary-type-assertion",
      "@typescript-eslint/no-base-to-string", "@typescript-eslint/unbound-method", "@typescript-eslint/no-misused-promises",
      "@typescript-eslint/no-floating-promises", "@typescript-eslint/no-this-alias", "@typescript-eslint/no-redundant-type-constituents",
      "no-control-regex",
      // 升级前这几条也只是提示（原来那套市场审核规则里它们同样是 Warning），别让它们挡构建
      "@typescript-eslint/no-explicit-any", "@typescript-eslint/no-unused-vars", "@typescript-eslint/no-unused-expressions",
    ].map(r => [r, "warn"])),
  },
  { files: ["packages/**/*.json"], language: "json/json", ...json.configs.recommended },
  // tsconfig 允许注释
  { files: ["packages/**/tsconfig*.json"], language: "json/jsonc", ...json.configs.recommended },
]);
