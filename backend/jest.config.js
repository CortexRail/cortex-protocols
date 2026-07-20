/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: "node",
  testMatch: ["**/__tests__/**/*.test.js"],
  globalSetup: "<rootDir>/src/__tests__/globalSetup.js",
  globalTeardown: "<rootDir>/src/__tests__/globalTeardown.js",
  collectCoverageFrom: ["src/**/*.js", "!src/index.js"],
  coverageDirectory: "coverage",
  coverageReporters: ["text", "lcov"],
  // Database suites share one Testcontainers database and use destructive cleanup.
  maxWorkers: 1,
  verbose: true,
};
