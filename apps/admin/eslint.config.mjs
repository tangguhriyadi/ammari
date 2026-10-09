import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // The e2e dev server's own distDir (next.config.ts) — same reasoning as ".next/**" above,
    // just a second build output directory, not source.
    ".next-e2e/**",
    // Playwright's own generated output (gitignored already) — the HTML report in particular
    // bundles third-party JS assets (e.g. CodeMirror, for the trace viewer) that trip
    // react-hooks/rules-of-hooks and other rules meant for our own source.
    "playwright-report/**",
    "test-results/**",
  ]),
]);

export default eslintConfig;
