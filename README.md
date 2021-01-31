# typescript-lib-starter

![Release](https://github.com/VaclavObornik/mongodash/workflows/Release/badge.svg)
[![Coverage Status](https://coveralls.io/repos/github/VaclavObornik/mongodash/badge.svg?branch=master)](https://coveralls.io/github/VaclavObornik/mongodash?branch=master)
[![Mutation testing badge](https://img.shields.io/endpoint?style=flat&url=https%3A%2F%2Fbadge-api.stryker-mutator.io%2Fgithub.com%2FVaclavObornik%2Fmongodash%2Fmaster)](https://dashboard.stryker-mutator.io/reports/github.com/VaclavObornik/mongodash/master)

This starter project will standardize coding and publishing for your library, and implements following features:

- :school_satchel: Include all packages for coding, linting, testing and building
- :art: Compile sass to css using node-sass, autoprefixer and postcss
- :inbox_tray: Build library to UMD and CommonJS modules
- :blue_book: Generate API documentation of your TypeScript files automatically
- :heavy_check_mark: Check your commit message when `git commit ...`
- :cl: Default CI scripts for GitHub Action, includes release and publish automatically
- :bookmark: Generate CHANGELOG.md according to your commits in CI publishing process
- :book: Publish your unit tests report to [coveralls.io](https://coveralls.io/) by CI
- :earth_asia: Publish API documentation, converage, demo and changelog to your gh-pages branch as your project site by CI
- :package: Release to NPM automatically by CI
 
## Start your library

1. Clone this repo:

    `git clone https://github.com/bndynet/typescript-lib-starter.git <your-location> --depth 1`

1. Initialize your library:

    `npm i && npm run init` and type your package informations

1. Now, you can code your library and bellow commands to start your work:

    ```bash
    npm start
    npm run lint
    npm run build
    npm run docs
    npm run test
    npm run test:watch
    npm run precommit
    ```

1. Commit your changes and push them to your REPO.

## Commit Message Guidelines

All commit message MUST follow https://github.com/angular/angular/blob/master/CONTRIBUTING.md#commit

Format as:

```
<type>(<scope>): <subject>
<BLANK LINE>
<body>
<BLANK LINE>
<footer>
```

Note: The **&lt;type&gt;** can be found in **./commitlint.config.js** file.

## GitHub Action

Add **NPM_TOKEN** in your repo -> **Settings** -> **Secrets**

**If you enabled GitHub Actions, the action will publish your package to GitHub Package Registry automatically.**
