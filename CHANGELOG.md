# Changelog
All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
