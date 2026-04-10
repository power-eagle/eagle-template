# eagle-template

A local-first Eagle plugin template built around `lefthook` for update and maintenance tasks, while keeping GitHub Actions only for packaging the plugin artifact.

## Direction

This template uses a deliberately narrow automation split:

1. `lefthook` handles local update and maintenance workflow.
2. `.eagleplus/` owns template-managed scripts and config.
3. GitHub Actions is kept for packaging and release publication.

For the design rationale and comparison with the previous `eagle-plugin-template` approach, see `.eagleplus/docs/what_changed_since.md`.

## Template layout

Template-owned automation lives in `.eagleplus/`.

- `.eagleplus/config/` defines packaging and update behavior
- `.eagleplus/scripts/` contains the local automation entrypoints
- `.github/workflows/package-plugin.yml` is the only workflow intended to be template-managed
- `lefthook.yaml` is local workflow glue and may optionally be template-managed

This split is deliberate. The template keeps its own operational logic under `.eagleplus/`, while the repository root stays focused on the plugin project itself.

## Script roles

`.eagleplus/scripts/doctor.cjs`
Checks that the template config files are valid JSON, reports sync timing from the temp-state file, and, when `manifest.json` exists, prints the file list that packaging currently resolves.

`.eagleplus/scripts/sync-template.cjs`
Clones the configured template source and copies only the files the template is allowed to own.

`.eagleplus/scripts/package-plugin.cjs`
Builds `.eagleplugin` archives locally for `release` and `debug` variants without relying on platform-specific shell tools.

`.eagleplus/scripts/package-local.cjs`
Builds both local package variants in one run and prints the generated output paths.

`.eagleplus/scripts/process-manifest.cjs`
Produces the manifest variant used during packaging by toggling `devTools` and resolving the package name and version.

## Packaging config

Packaging behavior is controlled by `.eagleplus/config/pkg-rules.json`.

Current shape:

```json
{
	"includes": [
		"src/**",
		"assets/**"
	],
	"ignore": [
		"dist/**",
		"node_modules/**"
	]
}
```

Settings:

`includes`
Defines which project files are eligible to be added to the generated `.eagleplugin` archive. Patterns are evaluated relative to the repository root. Files that match here are packaged alongside the generated `manifest.json`.

`ignore`
Defines paths that packaging must always exclude even if they also match `includes`. This is the place to keep build output, dependencies, caches, and other non-plugin material out of the final artifact.

Optional setting:

`branches`
When present, this array limits which branches the packaging workflow is allowed to release from. Wildcards are supported, so values like `release/*` or `feature/*` are valid. If `branches` is omitted, the workflow defaults to `main` only.

`i18n`
Boolean toggle for localization-aware packaging validation. When `true`, packaging requires `manifest.json` to define `fallbackLanguage` and a non-empty `languages` array, requires `languages` to contain the configured `fallbackLanguage`, and requires `_locales` to be covered by `includes` and present in the package input.

Operational notes:

- `manifest.json` is always written into the archive by the packager and does not need to be listed in `includes`
- `debug` packaging sets `devTools: true`
- `release` packaging sets `devTools: false`
- package output is written to `dist/`
- when `i18n` is `true`, `_locales/**` should be included explicitly in `includes`

## Update config

Template update behavior is controlled by `.eagleplus/config/template-target.json`.

Current shape:

```json
{
	"source": "https://github.com/ZackaryW/eagle-template.git",
	"branch": "main",
	"checkIntervalHours": 24,
	"workflow": ".github/workflows/package-plugin.yml",
	"syncLefthook": true,
	"protected": [
		"README.md",
		"LICENSE"
	]
}
```

Settings:

`source`
The git repository used as the template source during sync. `sync-template.cjs` clones this repository and reads the managed files from it.

`branch`
The branch to clone from the template source. This allows the template consumer to pin sync behavior to a stable branch instead of always taking the default branch.

`checkIntervalHours`
Optional sync interval in hours. When set, the template stores sync state in the operating system temp directory under `.eagleplus/<sha256-of-project-path>.json` and records a `lastUpdated` timestamp. Future sync runs use that timestamp to determine whether the next check is due.

`workflow`
The single workflow file under `.github/workflows` that the template is allowed to update. This keeps workflow ownership narrow and prevents template sync from rewriting unrelated CI files.

`syncLefthook`
Boolean toggle controlling whether `lefthook.yaml` is part of template sync. When `true`, sync may replace `lefthook.yaml` from the source template. When `false`, `lefthook.yaml` is treated as repository-owned and left untouched.

`protected`
List of paths that must never be overwritten by template sync even if the source repository contains them. This acts as a hard deny-list.

Sync scope is intentionally limited to:

- files inside `.eagleplus/scripts`
- the single workflow named by `workflow`
- `lefthook.yaml` only when `syncLefthook` is `true`

State behavior:

- sync state is stored outside the repo in the OS temp directory
- the filename is the SHA-256 hash of the normalized project path
- the state file records `lastUpdated`
- `--force` bypasses the next-check gate

## Workflow behavior

The packaging workflow is defined in `.github/workflows/package-plugin.yml`.

It is triggered by:

- changes to `manifest.json`
- changes to `.eagleplus/config/pkg-rules.json`
- changes to `.eagleplus/scripts/**`
- changes to `.github/workflows/package-plugin.yml`
- manual dispatch

Behavior:

- reads branch restrictions from `.eagleplus/config/pkg-rules.json`
- defaults to `main` when no `branches` array is configured
- reads the plugin version from `manifest.json`
- skips release creation when a release with tag `v<version>` already exists
- builds both `release` and `debug` package variants through `.eagleplus/scripts/package-plugin.cjs`
- publishes both artifacts in the GitHub release

## Runtime assumptions

The local scripts are written in Node and avoid shell-specific packaging commands, so the same packaging logic can run on Windows, macOS, and Linux.

`lefthook` is expected as a global install rather than a repo dependency:

```bash
npm install -g lefthook
lefthook install
```

Core commands:

```bash
node .eagleplus/scripts/doctor.cjs
node .eagleplus/scripts/sync-template.cjs --dry-run
node .eagleplus/scripts/sync-template.cjs --force
node .eagleplus/scripts/package-local.cjs
node .eagleplus/scripts/package-plugin.cjs release
node .eagleplus/scripts/package-plugin.cjs debug
```
