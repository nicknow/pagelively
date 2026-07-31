import tseslint from "typescript-eslint";

// Flat config (ESLint 9+). Keep it minimal: typescript-eslint recommended.
export default tseslint.config(
  {
    ignores: ["dist/", "coverage/", ".wrangler/", "node_modules/", "worker-configuration.d.ts"],
  },
  ...tseslint.configs.recommended,
);
