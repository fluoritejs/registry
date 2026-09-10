import js from "@eslint/js";
import globals from "globals";
import prettier from "eslint-config-prettier/flat";

export default [
  {
    ignores: [
      "node_modules/",
      "data/",
      "dist/",
      "fixtures/",
      "package-lock.json",
    ],
  },

  js.configs.recommended,
  prettier,

  {
    files: ["src/**/*.js", "test/**/*.js", "*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.node },
    },
    rules: {
      // Unused variables commonly indicate logic errors
      "no-unused-vars": [
        "error",
        {
          args: "none",
          caughtErrors: "none",
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
      // Allow while (true) { }
      "no-constant-condition": ["error", { checkLoops: false }],
      // Allow empty catch {} blocks
      "no-empty": ["error", { allowEmptyCatch: true }],
      // Returning a value from a constructor() implies a mistake
      "no-constructor-return": "error",
      // new Promise(async () => {}) implies a mistake
      "no-async-promise-executor": "warn",
      // x === x implies a mistake
      "no-self-compare": "error",
      // Using ${...} in a non-template-string implies a mistake
      "no-template-curly-in-string": "error",
      // Loops that only iterate once imply a mistake
      "no-unreachable-loop": "error",
      // Detect some untrusted code execution
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-new-func": "error",
      "no-script-url": "error",
      // Combinations of || and && are unreadable and may not do what you expect
      "no-mixed-operators": ["error", { groups: [["&&", "||"]] }],
      // Disallow async functions that don't need to be
      "require-await": "error",
    },
  },
];
