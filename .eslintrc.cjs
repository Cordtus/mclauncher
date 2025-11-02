/** @type {import('eslint').Linter.Config} */
module.exports = {
  root: true,
  env: { node: true, browser: true, es2022: true },
  parserOptions: { ecmaVersion: "latest", sourceType: "module" },
  extends: ["eslint:recommended", "plugin:import/recommended", "prettier"],
  rules: {
    "import/order": ["warn", { "newlines-between": "always" }]
  },
  ignorePatterns: ["dist", "build", "**/node_modules"]
};
