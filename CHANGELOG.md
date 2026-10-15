# Changelog

## [0.7.0](https://github.com/workos/quickstudy/compare/v0.6.1...v0.7.0) (2026-10-15)


### Features

* **diagnose:** skip control pairs ([#27](https://github.com/workos/quickstudy/issues/27)) ([e475d8d](https://github.com/workos/quickstudy/commit/e475d8dad9ed26f702585ed4d33ca7bfecf220b1))

## [0.6.1](https://github.com/workos/quickstudy/compare/v0.6.0...v0.6.1) (2026-10-14)


### Bug Fixes

* **proxy:** flush the tunnel before closing the peer ([#25](https://github.com/workos/quickstudy/issues/25)) ([c147619](https://github.com/workos/quickstudy/commit/c147619c6ffd5837ac35b0d98eae3574c58d26cd))

## [0.6.0](https://github.com/workos/quickstudy/compare/v0.5.0...v0.6.0) (2026-10-14)


### Features

* check kinds, prompt preambles, and fetch-only docs evidence ([#23](https://github.com/workos/quickstudy/issues/23)) ([1f90f1b](https://github.com/workos/quickstudy/commit/1f90f1b639ddf4bef7529ca400ee00936683c75f))

## [0.5.0](https://github.com/workos/quickstudy/compare/v0.4.0...v0.5.0) (2026-09-25)


### Features

* **report:** keep control experiments out of bands, scorer health and the leaderboard lead ([#20](https://github.com/workos/quickstudy/issues/20)) ([34dd802](https://github.com/workos/quickstudy/commit/34dd8024c4f1d9e6926e75032029cbd69a0ecae8))

## [0.4.0](https://github.com/workos/quickstudy/compare/v0.3.0...v0.4.0) (2026-09-24)


### Features

* prove the bench — oracle, graded checks, scorer health, leaderboard ([#18](https://github.com/workos/quickstudy/issues/18)) ([cebcbab](https://github.com/workos/quickstudy/commit/cebcbab8b4b63092e924646e9efbb6b6eab943bc))

## [0.3.0](https://github.com/workos/quickstudy/compare/v0.2.1...v0.3.0) (2026-09-21)


### Features

* **ui:** export the transcript and diff viewers ([#16](https://github.com/workos/quickstudy/issues/16)) ([c054326](https://github.com/workos/quickstudy/commit/c0543268ec0638f60d54679a889aea50096903c1))

## [0.2.1](https://github.com/workos/quickstudy/compare/v0.2.0...v0.2.1) (2026-09-18)


### Bug Fixes

* **ui:** make the hosted report say what it knows ([#14](https://github.com/workos/quickstudy/issues/14)) ([4d38f6e](https://github.com/workos/quickstudy/commit/4d38f6e04991dbdccf1334169c6dab888f918d9e))

## [0.2.0](https://github.com/workos/quickstudy/compare/v0.1.1...v0.2.0) (2026-09-16)


### Features

* **report:** Add native retrospective Codex cost estimates ([7cd5010](https://github.com/workos/quickstudy/commit/7cd5010ce3b4346636f9d4c80fed59e9769af538))
* **report:** estimate archived Codex token costs ([f6e43af](https://github.com/workos/quickstudy/commit/f6e43af5e30ac4d59801191d64564240192cbd76))


### Bug Fixes

* **report:** keep tiny estimates visibly nonzero ([05f9edb](https://github.com/workos/quickstudy/commit/05f9edb000ab04093d6af29b81d7900409ecf18b))

## [0.1.1](https://github.com/workos/quickstudy/compare/v0.1.0...v0.1.1) (2026-09-16)


### Bug Fixes

* **ui:** Classify Codex turns in transcript viewer ([2cec82e](https://github.com/workos/quickstudy/commit/2cec82ec9db471203d80025fc9869fffc234d961))

## [0.1.0](https://github.com/workos/quickstudy/compare/v0.0.1...v0.1.0) (2026-09-15)


### ⚠ BREAKING CHANGES

* **runner:** Scorers now execute in isolated workers. Client capabilities must expose JSON-like fields and asynchronous methods; prototype methods and synchronous remote methods are unsupported.

### Features

* initial import of the quickstudy eval harness ([7231b84](https://github.com/workos/quickstudy/commit/7231b84ea37291fd1a3dae357cbdc5f54778b4d5))
* **report:** add per-experiment agent identity ([79b97e7](https://github.com/workos/quickstudy/commit/79b97e7ae00e08464c07d9b2719d37e9354cc8de))
* **report:** add per-pair pass@k and pass^k ([7b6827e](https://github.com/workos/quickstudy/commit/7b6827ea03ba7b7d616ea395f7880df0c64c483e))
* **runner:** Make eval runs resumable and auditable ([18749fd](https://github.com/workos/quickstudy/commit/18749fddf22852ec3ae8d8930680fe6b164f3702))
* set up release process ([d43ce79](https://github.com/workos/quickstudy/commit/d43ce79d7a422ed92623d4043d1365c20a5473e6))
* **ui:** lead headers with model and reasoning ([05e115e](https://github.com/workos/quickstudy/commit/05e115e6d57e1afba9f518384cdc03160034c513))


### Bug Fixes

* **codex:** mint auth.json in-container via codex login ([a40996e](https://github.com/workos/quickstudy/commit/a40996e0e376dd7656c5174520e5e8e4a9e459c7))
* **diagnose:** bound excerpt bytes and raise the analyst output cap ([405fff8](https://github.com/workos/quickstudy/commit/405fff8041eac4186c19af8e8129a43335302dc9))
* **diagnose:** strip array-length keywords from the wire schema ([23f7770](https://github.com/workos/quickstudy/commit/23f777033c30da386293d43825a982fe6c859fc4))
* **diagnose:** strip every bound keyword, not just array lengths ([81bfe78](https://github.com/workos/quickstudy/commit/81bfe7846e65b2a1a8dbf0171ad700ac07a17f6b))
* **images:** bump codex CLI to 0.149.1 ([f11d280](https://github.com/workos/quickstudy/commit/f11d2808b4e67ece4d0f24f899c3be98e96b53b4))
* **isolation:** Tolerate a concurrent container removal ([09afbff](https://github.com/workos/quickstudy/commit/09afbff3cacaeacac1a6b16ba00efe7a3e4a838d))
* **isolation:** Tolerate a concurrent container removal ([69f8469](https://github.com/workos/quickstudy/commit/69f846990ef38d53c906cc9c7ca0e7e88870f01f))
* **runner:** number trials from 1 in the run log ([1d2418a](https://github.com/workos/quickstudy/commit/1d2418a454c73b454eb7c941e7a1687a225ad4cf))
