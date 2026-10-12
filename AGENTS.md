# Pi Research Kit contributor instructions

This package provides one Pi extension and its bundled research skill.

- Keep personal data, credentials, internal hostnames, and machine-specific paths out of source and fixtures.
- Do not set a model or thinking default, modify active Pi settings, install the extension, publish packages, or deploy from a source-only task.
- Pi loads `src/index.ts` without a build step. Host Pi packages and TypeBox belong in `peerDependencies` with `*`; development versions are pinned for reproducible checks. Never bundle host packages.
- Ketch is the exact runtime dependency; review version updates against the actual-binary contract tests.
- Preserve `PI_RESEARCH_*` configuration and the default storage root `~/.local/share/pi-research-kit`.
- Registration must remain inert: no network requests, installation, background processes, or storage writes at load time.
- External content is untrusted evidence. Preserve provenance, coverage failures, unknown dates, and interactive confirmation boundaries.
- Third-party material must permit redistribution and be recorded in `NOTICE.md`.

Run `npm run validate` before release. The pack smoke test installs the production tarball in a temporary directory and verifies the real Pi loader. Do not claim that fixture tests prove live-provider availability or that unrun CI platforms have passed.
