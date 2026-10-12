# Contributing

## Development

Use Node.js 22.19.0 or newer. From a checkout:

```sh
npm ci --ignore-scripts
npm run validate
```

Tests use controlled fixtures and a local HTTP server. The Ketch contract test runs the bundled native binary, without external search-provider calls. The production-tarball smoke check needs npm registry access to install dependencies in an isolated directory.

To try the extension without saving Pi settings:

```sh
pi --no-extensions --no-skills -e ./src/index.ts --skill ./skills/research-kit
```

Pi loads TypeScript directly; no compilation or `dist` directory is required. The exported TypeScript modules require a TypeScript-aware loader; plain Node does not strip TypeScript in installed `node_modules` packages.

## Changes

Keep changes focused and add regression tests. State which checks ran, any live-provider checks, and known limitations. Do not commit retrieved private pages, credentials, personal configuration, generated archives, or dependency trees.

Preserve compatibility for existing tools, `PI_RESEARCH_*` settings, and research storage. Breaking changes require migration documentation. New source adapters must report disabled, failed, partial, and empty coverage honestly and respect explicit credential opt-in.

See [SECURITY.md](SECURITY.md) for trust boundaries and [RELEASING.md](RELEASING.md) for publication checks.
