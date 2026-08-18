const js = require("@eslint/js");
const globals = require("globals");

module.exports = [
  {
    ignores: ["coverage/**"],
  },
  js.configs.recommended,
  {
    files: ["src/**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "commonjs",
      globals: globals.node,
    },
    rules: {
      "no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
    },
  },
  {
    files: ["src/__tests__/**/*.js"],
    languageOptions: {
      globals: globals.jest,
    },
  },
];
