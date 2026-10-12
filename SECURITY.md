# Security and trust boundaries

This extension runs with the permissions of the Pi process. It is a trusted local tool, not a multi-user service or an SSRF sandbox.

- Retrieval rejects non-HTTP(S) URLs, URL credentials, and obvious local/private address literals. DNS resolution, redirects, discovered URLs, and crawl requests are not comprehensively contained.
- Ketch runs without a shell, with execution/output budgets and a temporary home/config/cache. Ambient provider credentials are not inherited automatically. An explicitly selected Ketch config can enable authenticated retrieval and browser rendering.
- Retrieved content is untrusted data, not executable instructions. Source URLs, content, and local paths may appear in Pi sessions and logs.
- Library writes, watchlist changes, publication, and handoffs require interactive confirmation. No model-provided approval flag authorizes writes.
- POSIX process groups are terminated on cancellation. Windows descendant containment is more limited; transcript helper execution is disabled there.
- Private content and authenticated fetches should be treated as sensitive, even when stored only locally.

Before public release, configure GitHub private vulnerability reporting. Once enabled, use the repository's **Security → Report a vulnerability** page for sensitive reports. Until then, do not post credentials or exploit details in a public issue; agree on a private reporting channel with the maintainer first.
