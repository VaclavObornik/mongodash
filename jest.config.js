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
      branches: 90,
      functions: 90,
      lines: 90,
      statements: 90,
    },
  },
  collectCoverageFrom: ['src/**/*.{js,ts}'],
  coverageDirectory: './reports/coverage',
  testRunner: 'jasmine2',
};
