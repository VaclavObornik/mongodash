## [1.7.1](https://github.com/VaclavObornik/mongodash/compare/v1.7.0...v1.7.1) (2025-12-27)


### Bug Fixes

* update user update handler to use docId instead of doc ([527307f](https://github.com/VaclavObornik/mongodash/commit/527307f344844f13fdd3ad2d8209193bd7e79f98))

# [1.7.0](https://github.com/VaclavObornik/mongodash/compare/v1.6.1...v1.7.0) (2025-12-27)


### Bug Fixes

* update README for improved task handler documentation ([1a3da53](https://github.com/VaclavObornik/mongodash/commit/1a3da53a973fccccdae2a556df23317d5187c9a1))


### Features

* add logo to header and update image references ([8ff1442](https://github.com/VaclavObornik/mongodash/commit/8ff144236f5742a1edf04d31ef7eb61a31995388))

## [1.6.1](https://github.com/VaclavObornik/mongodash/compare/v1.6.0...v1.6.1) (2025-12-27)


### Bug Fixes

* update docs for github ([20f7cfb](https://github.com/VaclavObornik/mongodash/commit/20f7cfb7bab22235259d12e302f698bad44eaa82))

# [1.6.0](https://github.com/VaclavObornik/mongodash/compare/v1.5.0...v1.6.0) (2025-12-27)


### Bug Fixes

* ensure post-commit hooks can only be registered within active transactions ([97dbd29](https://github.com/VaclavObornik/mongodash/commit/97dbd29763f1d8f97b1b0f85be99886840183a48))


### Features

* reactive  tasks ([601d3d3](https://github.com/VaclavObornik/mongodash/commit/601d3d3dfcc3f977451ccbe02714051b08c65067))

## [1.4.2](https://github.com/VaclavObornik/mongodash/compare/v1.4.1...v1.4.2) (2022-06-16)


### Bug Fixes

* bump minimist from 1.2.5 to 1.2.6 ([6d01a40](https://github.com/VaclavObornik/mongodash/commit/6d01a40cf96d6170e77d3461835c4ffd852fe466))

## [1.4.1](https://github.com/VaclavObornik/mongodash/compare/v1.4.0...v1.4.1) (2022-02-25)


### Bug Fixes

* **cronTask:** lower chance to stuck infinite task ([2ad6a1d](https://github.com/VaclavObornik/mongodash/commit/2ad6a1d774d76a225e68f0475d924059fa60c122))

# [1.4.0](https://github.com/VaclavObornik/mongodash/compare/v1.3.1...v1.4.0) (2022-01-29)


### Features

* **cronTask:** support of cronTaskCaller option to allow usage like correlationId ([a67226c](https://github.com/VaclavObornik/mongodash/commit/a67226cd20edb778baf5c3cf0b19f22110a8f811))

## [1.3.1](https://github.com/VaclavObornik/mongodash/compare/v1.3.0...v1.3.1) (2022-01-16)


### Bug Fixes

* bump debug from 4.3.2 to 4.3.3 ([beef1c2](https://github.com/VaclavObornik/mongodash/commit/beef1c201de003f8e2a399ba98a82fa40cfa6c3b))

# [1.3.0](https://github.com/VaclavObornik/mongodash/compare/v1.2.0...v1.3.0) (2021-12-15)


### Features

* added duration to CRON info ([5d5ff8e](https://github.com/VaclavObornik/mongodash/commit/5d5ff8e4a625002eaf3d6ba55b63051999d12381))

# [1.2.0](https://github.com/VaclavObornik/mongodash/compare/v1.1.1...v1.2.0) (2021-12-15)


### Features

* added onInfo option for convenient logging ([5f8c45a](https://github.com/VaclavObornik/mongodash/commit/5f8c45afcfbabb824310573d99231d42480a4ff5))
* typescript update ([37b466d](https://github.com/VaclavObornik/mongodash/commit/37b466db1f90d88d9f6f5aa40a616a26fb51a2ee))

## [1.1.1](https://github.com/VaclavObornik/mongodash/compare/v1.1.0...v1.1.1) (2021-12-14)


### Bug Fixes

* bump cron-parser from 3.5.0 to 4.2.0 ([0bb7e37](https://github.com/VaclavObornik/mongodash/commit/0bb7e37042d61c39e2d1287b9c4d6543b3f3827b))

# [1.1.0](https://github.com/VaclavObornik/mongodash/compare/v1.0.2...v1.1.0) (2021-12-13)


### Features

* cron task registration can be called before monogdash.init ([181747d](https://github.com/VaclavObornik/mongodash/commit/181747ddd7a1dbba7671561bc3e49ae0eddb3ee0))
* isLockAlreadyAcquiredError function introduced ([2741bff](https://github.com/VaclavObornik/mongodash/commit/2741bffbfcc7858175fbff8ea62ffb0f42af4a86))
* WithLockOptions exported ([7a6443a](https://github.com/VaclavObornik/mongodash/commit/7a6443a568bffa60fff852bf1c072938bdf20481))

## [1.0.2](https://github.com/VaclavObornik/mongodash/compare/v1.0.1...v1.0.2) (2021-12-06)


### Bug Fixes

* type update update ([c56f973](https://github.com/VaclavObornik/mongodash/commit/c56f97325131b011aa7d0e7f1b95bf5ce3dbf527))

## [1.0.1](https://github.com/VaclavObornik/mongodash/compare/v1.0.0...v1.0.1) (2021-08-27)


### Bug Fixes

* added ES Module Entrypoint ([9899de6](https://github.com/VaclavObornik/mongodash/commit/9899de6d3a93b2de915a33f9fc05ec1c2f68b1a6))

## [0.10.8](https://github.com/VaclavObornik/mongodash/compare/v0.10.7...v0.10.8) (2021-08-27)


### Bug Fixes

* typescript problems after tsc upgrade ([21262b2](https://github.com/VaclavObornik/mongodash/commit/21262b2ec1160914e8796d595c461beea828b58e))

## [0.10.7](https://github.com/VaclavObornik/mongodash/compare/v0.10.6...v0.10.7) (2021-07-31)


### Bug Fixes

* withLock can calculate last possible attempt in more accurate way ([f4dffbe](https://github.com/VaclavObornik/mongodash/commit/f4dffbe5521b0b834ddc2a4af975caa31f2ae127))

## [0.10.6](https://github.com/VaclavObornik/mongodash/compare/v0.10.5...v0.10.6) (2021-07-30)


### Bug Fixes

* run test in band to increase stability ([4c8c24a](https://github.com/VaclavObornik/mongodash/commit/4c8c24a0ab33fcc19e5c9e08ce5892dff3630980))

## [0.10.5](https://github.com/VaclavObornik/mongodash/compare/v0.10.4...v0.10.5) (2021-07-30)


### Bug Fixes

* stabilized tests and max wait time for withLock ([86c6e2d](https://github.com/VaclavObornik/mongodash/commit/86c6e2d27d153c609586731776cc5a0a8ae37d81))

## [0.10.4](https://github.com/VaclavObornik/mongodash/compare/v0.10.3...v0.10.4) (2021-07-26)


### Bug Fixes

* added tests for withLock function ([dae54b2](https://github.com/VaclavObornik/mongodash/commit/dae54b23e9a2d4ad5277b8fb43ede1c586526b40))

## [0.10.3](https://github.com/VaclavObornik/mongodash/compare/v0.10.2...v0.10.3) (2021-07-26)


### Bug Fixes

* unified readme styles ([7f153e6](https://github.com/VaclavObornik/mongodash/commit/7f153e6f09d791296793991dcfdbfab0a7d10277))
* updated Readme badges ([e0a4071](https://github.com/VaclavObornik/mongodash/commit/e0a4071cfb1f5a358bfd710bd82dc348b2ee72fa))

## [0.10.2](https://github.com/VaclavObornik/mongodash/compare/v0.10.1...v0.10.2) (2021-07-26)


### Bug Fixes

* updated Readme ([77f42e0](https://github.com/VaclavObornik/mongodash/commit/77f42e04af577225394f6223a6efec1308d45997))

## [0.10.1](https://github.com/VaclavObornik/mongodash/compare/v0.10.0...v0.10.1) (2021-07-26)


### Bug Fixes

* added package.json keywords ([c6ac7d1](https://github.com/VaclavObornik/mongodash/commit/c6ac7d11a19b72dbb58d13135be058f4430522c7))

# [0.10.0](https://github.com/VaclavObornik/mongodash/compare/v0.9.7...v0.10.0) (2021-07-24)


### Features

* **mongodb driver version:** peer dependency updated to mongodb@4 ([c4ce719](https://github.com/VaclavObornik/mongodash/commit/c4ce7193b81b80f44eb2d1033c5ed8ad07004b36))

## [0.9.7](https://github.com/VaclavObornik/mongodash/compare/v0.9.6...v0.9.7) (2021-07-14)


### Bug Fixes

* updated mongodb compatible version ([a21d549](https://github.com/VaclavObornik/mongodash/commit/a21d549d24d69f9d93f8df4fc83c13ddf6d575d3))

## [0.9.1](https://github.com/VaclavObornik/mongodash/compare/v0.9.0...v0.9.1) (2021-07-08)


### Bug Fixes

* substitute missing dependency for range-random by oneliner ([81d8e86](https://github.com/VaclavObornik/mongodash/commit/81d8e861318fbdbcc5342ad23b11700baba11e7c))
