module.exports = {
  verbose: true,
  rootDir: './',
  roots: ['<rootDir>/src/', '<rootDir>/test/'],
  preset: 'ts-jest',
  moduleNameMapper: {
    '.+\\.(css|styl|less|sass|scss|png|jpg|ttf|woff|woff2)$': 'jest-transform-stub',
  },
  globals: {
    'ts-jest': {
      diagnostics: false,
    },
  },
  testEnvironment: 'node',
  testRegex: '/test/(?!testHelpers|\.eslintrc).*\\.(ts|js)$',
  setupFilesAfterEnv: [],
  moduleFileExtensions: ['ts', 'js'],
  coveragePathIgnorePatterns: ['/node_modules/'],
  coverageThreshold: {
    global: {
      branches: 100,
      functions: 100,
      lines: 100,
      statements: 100,
    },
  },
  collectCoverageFrom: ['src/**/*.{js,ts}'],
  coverageDirectory: './reports/coverage',
  testRunner: 'jasmine2',
};
