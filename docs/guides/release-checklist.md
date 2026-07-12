# Release checklist

Checklist for releasing `browser-pilot` to npm. The release owner must approve the release gate before any version, tag, registry, or publish action.

## Release gate

Do not run `npm publish`, `npm dist-tag`, `git tag`, or an equivalent release command until the release owner confirms all of these in the release record:

- [ ] Exact package version.
- [ ] Exact Git tag.
- [ ] Exact npm dist-tag, if it is not the default.
- [ ] Exact npm registry.

This checklist does not authorize publishing.

## Choose and promote the version

- [ ] Review the changes since the last release and choose the next semver version: major, minor, or patch.
- [ ] Confirm the current version in `package.json` before changing it.
- [ ] After release-owner approval, set `package.json` to the approved version during release preparation. There is no package-specific version or release script.
- [ ] Treat `package.json` as the version source. `tsup.config.ts` reads it and embeds the version in the build and CLI.
- [ ] Check that the approved version is used consistently in the changelog, packed metadata, and `bp --version` output.

Version changes belong to release preparation after the release gate is approved; this checklist does not authorize publishing, tagging, or registry changes.

## Promote the changelog

- [ ] Keep `## [Unreleased]` at the top of `CHANGELOG.md` while preparing a future release.
- [ ] Move its current release-note sections into a new section directly below it.
- [ ] Name the new section `## [x.y.z] - YYYY-MM-DD` with the approved version and release date.
- [ ] Preserve breaking-change notes and make the public impact clear.
- [ ] Confirm that no intended release entries remain under `Unreleased`.

## Run the checks and build

Run the repository's full quiet check. It covers TypeScript, Biome, type-aware oxlint, unit tests, fitness tests, and API Extractor.

```bash
bun run check:quiet
```

Then make a clean production build:

```bash
bun run clean
bun run build
```

The package defines `prepack` and `prepublishOnly` as `bun run clean && bun run build`, so both packing and publishing rebuild the package. Publishing is still prohibited until the release gate is confirmed.

## Inspect the npm package

Preview the file list before creating a tarball:

```bash
npm pack --dry-run
```

The package should contain the built `dist/` output, `CHANGELOG.md`, `README.md`, `LICENSE`, and package metadata. It should not contain source files, tests, docs, temporary files, or a previous `.tgz` file.

Create the tarball for the consumer smoke test and inspect its contents:

```bash
TARBALL="$(npm pack --silent)"
tar -tzf "$TARBALL" | sort
```

Verify that the tarball metadata has the approved version and that its `exports` and `bin` entries point to files present under `dist/`.

## Smoke-test the packed consumer

Install the tarball into a fresh temporary npm project. Run this from the repository root after setting `TARBALL`:

```bash
EXPECTED_VERSION="$(node -p "require('./package.json').version")"
SMOKE_DIR="$(mktemp -d)"

(
  cd "$SMOKE_DIR"
  npm init -y
  npm install --ignore-scripts "$OLDPWD/$TARBALL"
  node --input-type=module <<'NODE'
import { connect } from "browser-pilot";

if (typeof connect !== "function") {
  throw new Error("browser-pilot import did not expose connect");
}
NODE
  ./node_modules/.bin/bp --help >/dev/null
  test "$(./node_modules/.bin/bp --version)" = "$EXPECTED_VERSION"
)

rm -rf "$SMOKE_DIR" "$TARBALL"
```

The smoke test must pass without relying on the repository's source tree or local `file:` dependencies.

## CLI verification

The packed CLI must pass both checks:

- [ ] `bp --help` exits successfully and shows the routed command tree.
- [ ] `bp --version` exits successfully and prints the approved version exactly, without a leading `v`.

Stop after these checks if the release owner has not confirmed the version, tag, and registry. Do not publish from the checklist run.
