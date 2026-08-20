import { configs } from "@eslint/js";
import { node, jest } from "globals";

export default [
  {
    ignores: ["coverage/**"],
  },
  configs.recommended,
  {
    files: ["src/**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "commonjs",
      globals: node,
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
      globals: jest,
    },
  },
];
