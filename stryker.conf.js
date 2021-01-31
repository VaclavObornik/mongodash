const os = require('os');

module.exports = {
  "$schema": "./node_modules/@stryker-mutator/core/schema/stryker-schema.json",
  "packageManager": "npm",
  "reporters": [
    "html",
    "clear-text",
    "progress",
    "dashboard"
  ],
  "testRunner": "jest",
  "coverageAnalysis": "all",
  "htmlReporter": {
    "baseDir": "reports/mutation/html-report"
  },
  "timeoutMS": 10000,
  "concurrency": os.cpus().length * 2
}
