# Changelog

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
