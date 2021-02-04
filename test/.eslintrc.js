module.exports = {
  extends: [
    'plugin:@typescript-eslint/recommended',
    'prettier/@typescript-eslint',
    'plugin:prettier/recommended',
  ],
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2018,
    sourceType: 'module',
    project: './tsconfig.json',
    tsconfigRootDir: __dirname,
  },
  "plugins": ["no-only-tests"],
  rules: {
    indent: ["error", 4],
    "no-only-tests/no-only-tests": "error",
    "@typescript-eslint/no-non-null-assertion": ["off"],
    "@typescript-eslint/ban-ts-comment": ["off"]
  },
};
