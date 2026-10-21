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
    // homepage-deploy-regression.test.ts's own distDir (a real `next build` it drives directly,
    // not through next.config.ts) — same reasoning as ".next-e2e/**" above. Left out of this
    // list, a build this test leaves behind (e.g. after a failed run) gets linted as if it were
    // source, which it isn't.
    ".next-deploy-regression-test/**",
    // cron-auth-standalone.test.ts's own distDir, same reasoning.
    ".next-cron-auth-test/**",
    // Playwright's own generated output (gitignored already) — the HTML report in particular
    // bundles third-party JS assets (e.g. CodeMirror, for the trace viewer) that trip
    // react-hooks/rules-of-hooks and other rules meant for our own source.
    "playwright-report/**",
    "test-results/**",
  ]),
]);

export default eslintConfig;
