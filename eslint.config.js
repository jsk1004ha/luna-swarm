import tseslint from "typescript-eslint";

export default [
  {
    ignores: [
      "dist/**",
      "ui/dist/**",
      "node_modules/**",
      ".luna-swarm/**",
      ".omx/**",
      "benchmarks/**/results/**",
      "test/fixtures/**",
    ],
  },
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
      },
    },
    plugins: {
      "@typescript-eslint": tseslint.plugin,
    },
    rules: {
      "no-console": "error",
      "no-debugger": "error",
      "no-eval": "error",
      "no-implied-eval": "error",
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-require-imports": "error",
      "@typescript-eslint/ban-ts-comment": [
        "error",
        {
          "ts-check": false,
          "ts-expect-error": "allow-with-description",
          "ts-ignore": true,
          "ts-nocheck": true,
          minimumDescriptionLength: 3,
        },
      ],
    },
  },
];
