const tsPlugin = require('@typescript-eslint/eslint-plugin');
const tsParser = require('@typescript-eslint/parser');
const prettierPlugin = require('eslint-plugin-prettier');
const prettierConfig = require('eslint-config-prettier');
const noOnlyTestsPlugin = require('eslint-plugin-no-only-tests');
const globals = require('globals');

module.exports = [
    {
        ignores: [
            '**/dist/**',
            '**/reports/**',
            '**/coverage/**',
            '**/node_modules/**',
            '**/dashboard/**', // Avoid linting the dashboard subproject here
            '**/.idea/**',
            '**/.vscode/**',
            'eslint.config.js',
            '**/*.json',
            'docs/**',
        ],
    },
    {
        // Disable type-aware linting for config and non-TS files
        files: ['*.config.js', '*.config.mjs', '**/*.json', '**/*.js', '**/*.jsx'],
        languageOptions: {
            parserOptions: {
                project: null,
            },
        },
    },
    {
        files: ['**/*.ts', '**/*.tsx'],
        ignores: ['*.config.js', '*.config.mjs'],
        languageOptions: {
            parser: tsParser,
            parserOptions: {
                ecmaVersion: 2018,
                sourceType: 'module',
                project: './tsconfig.json',
                tsconfigRootDir: __dirname,
            },
            globals: {
                ...globals.node,
                ...globals.jest,
            },
        },
        plugins: {
            '@typescript-eslint': tsPlugin,
            prettier: prettierPlugin,
            'no-only-tests': noOnlyTestsPlugin,
        },
        rules: {
            ...tsPlugin.configs.recommended.rules,
            ...prettierConfig.rules,
            'prettier/prettier': 'error',
            '@typescript-eslint/no-non-null-assertion': 'off',
            '@typescript-eslint/no-unused-vars': [
                'warn',
                {
                    argsIgnorePattern: '^_',
                    varsIgnorePattern: '^_',
                },
            ],
            '@typescript-eslint/no-require-imports': 'off',
        },
    },
    {
        // Relaxed rules for test files
        files: ['**/test/**/*.ts', '**/*.test.ts', '**/*.spec.ts'],
        languageOptions: {
            parserOptions: {
                project: './test/tsconfig.json',
                tsconfigRootDir: __dirname,
            },
        },
        rules: {
            'no-only-tests/no-only-tests': 'error',
            '@typescript-eslint/no-explicit-any': 'off',
            '@typescript-eslint/no-unused-vars': [
                'warn',
                {
                    argsIgnorePattern: '^_',
                    varsIgnorePattern: '^_',
                },
            ],
            '@typescript-eslint/no-empty-function': 'off',
            '@typescript-eslint/no-require-imports': 'off',
            '@typescript-eslint/no-var-requires': 'off',
            '@typescript-eslint/ban-ts-comment': 'off',
        },
    },
    {
        // Relaxed rules for tools
        files: ['**/tools/**/*.ts'],
        rules: {
            '@typescript-eslint/no-explicit-any': 'off',
            '@typescript-eslint/no-unused-vars': [
                'warn',
                {
                    argsIgnorePattern: '^_',
                    varsIgnorePattern: '^_',
                },
            ],
            '@typescript-eslint/no-empty-function': 'off',
            '@typescript-eslint/no-require-imports': 'off',
        },
    },
];
