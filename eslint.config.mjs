import tseslint from "typescript-eslint";

export default tseslint.config({
  ignores: [
    "**/dist/**",
    "**/node_modules/**",
    "playwright-report/**",
    "test-results/**",
  ],
  files: ["**/*.{js,mjs,cjs,ts,tsx}"],
  languageOptions: {
    parser: tseslint.parser,
    parserOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
    },
  },
  rules: {},
});
