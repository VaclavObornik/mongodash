module.exports = {
    verbose: true,
    rootDir: './',
    roots: ['<rootDir>/src/', '<rootDir>/test/'],
    // preset: 'ts-jest',
    moduleNameMapper: {},
    transform: {
        '^.+\\.ts$': ['ts-jest', {
            diagnostics: false,
        }],
    },
    testEnvironment: 'node',
    testRunner: 'jest-circus/runner',
    testRegex: '/test/(?!testHelpers|\\.eslintrc).*\\.(ts|js)$',
    setupFilesAfterEnv: [],
    moduleFileExtensions: ['ts', 'js'],
    globalSetup: '<rootDir>/tools/check-db-connection.ts',
    coveragePathIgnorePatterns: ['/node_modules/'],
    coverageThreshold: {
        global: {
            branches: 85,
            functions: 85,
            lines: 90,
            statements: 90,
        },
    },
    collectCoverageFrom: ['src/**/*.{js,ts}'],
    coverageDirectory: './reports/coverage',
};
