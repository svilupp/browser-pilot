# Changelog
All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.0.5] - 2026-01-04

### Added
- React-like controlled form test fixture for validating event handling
- Integration tests for fill action with controlled inputs (state sync validation)

## [0.0.4] - 2026-01-04

### Changed
- Simplified CLI help output and quickstart guide for cleaner UX

### Fixed
- CLI exec validates actions before session check (better error messages in CI/fresh environments)

## [0.0.3] - 2026-01-02

### Added
- CLI ref caching: refs from snapshot are now cached per session+URL, reusable across exec calls
- `bp quickstart` command for getting started guide

### Fixed
- Iframe context polling: actions in iframes now wait for execution context (fixes race condition with delayed iframe content)

## [0.0.2] - 2026-01-01

### Fixed
- Better test coverage

## [0.0.1] - 2026-01-01

- Initial release
