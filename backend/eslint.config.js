const js = require("@eslint/js");
const { node, jest } = require("globals");

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
      globals: {
        ...node,
        logger: "readonly",
      },
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
    files: ["src/**/__tests__/**/*.js", "src/**/*.test.js"],
    languageOptions: {
      globals: jest,
    },
  },
];
