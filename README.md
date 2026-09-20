# Pi Research Kit

[![CI](https://github.com/tahabakhit/pi-research-kit/actions/workflows/ci.yml/badge.svg)](https://github.com/tahabakhit/pi-research-kit/actions/workflows/ci.yml)

Pi Research Kit is a native Pi extension for bounded web retrieval and evidence-oriented research. It combines pinned [Ketch](https://github.com/1broseidon/ketch) retrieval with dated evidence workflows, a local research library, watchlists, exports, and explicitly configured publication or handoff destinations.

MIT licensed; see [LICENSE](LICENSE). The package name is `@tahabakhit/pi-research-kit`. Source installation is available now; npm distribution is not yet available.

## Install from GitHub

```sh
pi install git:github.com/tahabakhit/pi-research-kit
```

Reload Pi after installation. Avoid loading another extension that registers the same web tool aliases.

## Requirements

- Node.js 22.19 or newer
- A current Pi installation with the `@earendil-works` APIs
- Network access for retrieval tools

Ketch is installed as the exact `ketch-cli@0.17.1` dependency, including its platform-specific binary. Go is not required. Chromium is not installed by this extension.

## Try from a checkout

From the package root:

```sh
npm ci --ignore-scripts
npm test
npm run typecheck
npm run pack:check
npm run pack:smoke
pi --no-extensions -e ./index.ts --skill ./skills/research-kit
```

The last command starts an interactive Pi session without other extensions, which avoids duplicate tool names. It does not install or publish anything. Review dependencies and configuration before enabling network or write operations.

The GitHub installation above uses Pi's native package mechanism.

## Tools

The extension registers 17 tools:

| Tool | Purpose |
| --- | --- |
| `ketch_search` | Bounded web search through Ketch |
| `ketch_scrape` | Extract bounded content from one HTTP(S) URL |
| `ketch_crawl` | Crawl a site with depth, page, and output limits |
| `ketch_code` | Search public source code |
| `ketch_docs` | Search public library documentation |
| `web_search` | Compatibility alias for `ketch_search` |
| `web_fetch` | Compatibility alias for `ketch_scrape` |
| `research_recent` | Gather dated and unknown-date evidence with source status |
| `research_synthesize` | Organize retrieved evidence for a host-model synthesis |
| `research_compare` | Gather separate evidence for two to four named entities |
| `research_discover` | Nominate and cautiously enrich heuristic research leads |
| `research_library` | List, search, and confirmation-gated save of local records |
| `research_watchlist` | Add, list, update, remove, or manually refresh watch items |
| `research_export` | Render selected records as Markdown, HTML, or Atom |
| `research_doctor` | Report configured dependencies and source coverage |
| `research_publish` | Publish selected records through an explicit GitHub repository adapter |
| `research_handoff` | Write a new confirmation-gated research handoff to an explicit inbox |

Examples:

```json
{"query":"agent browser research","exactPhrases":["local-first"],"excludeTerms":["sponsored content"],"site":"github.com","count":5}
{"query":"browser automation tooling","days":30,"limit":10,"maxFetch":3}
{"entities":["Tool A","Tool B"],"question":"reliability and maintenance","days":30,"depth":"standard"}
```

Provider support for search operators varies; aliases do not promise Google-identical semantics. Tool schemas are the parameter authority. Crawling stops at configured result, time, and output budgets; requests may already be in flight when a limit is reached. Ketch renders pages but does not automate clicks, forms, or browser sessions. Use an interactive browser tool for those tasks.

## Research behavior and evidence limits

`research_compare` and `research_discover` accept an optional host-authored version-1 `queryPlan`. Plans validate workflow, explicit queries, entities or scope, date window, and budget before retrieval. A plan allows at most eight research queries, four comparison entities, and ten enrichment fetches. Fetch allocation is cumulative across a workflow. Depth changes work budgets; it does not change the requested date window.

Discovery uses dated eligibility, normalized multiword overlap, and conservative domain grouping. Repeated URLs, grouped subdomains, and exact syndicated copies do not create independent corroboration. These heuristics cannot establish publisher ownership or detect every dependent account. A nominated lead is still a research lead, not a verified trend or calibrated confidence score. `no-solid-findings` and insufficient evidence are valid outcomes.

The default source set includes Ketch plus keyless Hacker News Algolia, GitHub repository search, Reddit public search, and Polymarket Gamma. GitHub repository activity is not equivalent to issue discussions or community sentiment. Reddit coverage is bounded and does not promise complete comment trees or exhaustive history. Polymarket distinguishes market end dates from publication dates.

X recent search and YouTube Data API adapters are opt-in and require credentials. X recent search is limited to the provider's recent-search window. YouTube metadata and top-level comment retrieval use the YouTube Data API. An optional trusted, operator-configured `yt-dlp` executable can retrieve available captions without cookies, media downloads, or automatic installation. No paid API is enabled without explicit operator opt-in, and provider quotas or charges remain the operator's responsibility.

Evidence preserves URLs, retrieval timestamps, available publication dates, and source-specific metadata. Missing dates remain separate from dated evidence, and failed retrieval is not evidence that a source was silent. Synthesis is performed by the hosting Pi model; no second model subscription is required.

## Configuration

All path settings are explicit local operator configuration:

- `KETCH_BIN` — optional executable override. Without it, the package-local locked launcher is used.
- `PI_RESEARCH_HOME` — optional absolute storage root. The default is `~/.local/share/pi-research-kit`.
- `PI_RESEARCH_INBOX` — required for handoff writes; an explicit absolute operator path to the inbox. There is no default inbox, no path discovery, and no inspection of unrelated notes.
- `PI_RESEARCH_ENABLE_TRANSCRIPTS=1` and `PI_RESEARCH_YTDLP_BIN` — enable captions with an already installed `yt-dlp` at an absolute path. This is an optional POSIX configuration. Transcript helper execution is deliberately disabled on Windows until process-tree containment is available.
- `PI_RESEARCH_ENABLE_X=1` and `PI_RESEARCH_X_BEARER_TOKEN` — opt in to X recent search.
- `PI_RESEARCH_ENABLE_YOUTUBE=1` and `PI_RESEARCH_YOUTUBE_API_KEY` — opt in to YouTube Data API sources.

The Ketch launcher runs shell-free with bounded output and time in a fresh temporary home/config/cache environment. Existing Ketch configuration, API keys, and cookies are not reused automatically. The default package has no authenticated-provider setup UI.

## Safety and local storage

**Network access is trusted-local, not a sandbox.** URL tools reject obvious local or non-public address literals, URL credentials, and non-HTTP schemes. DNS rebinding, redirect targets, remotely discovered URLs, and crawler requests are not comprehensively contained. This package does not provide an SSRF sandbox and must not be exposed as an untrusted multi-user service.

Local records are bounded and written with owner-only permissions where supported. Immutable library saves use exclusive creation. Watchlist changes use locks and atomic replacement with retained history. These measures do not eliminate races against another local process, and Windows permission behavior remains less thoroughly verified.

Library saves, watchlist mutations, publication, and handoff writes require interactive human confirmation. Headless or model-supplied approval arguments cannot authorize them. Handoff writes create a new dated Markdown file and never overwrite an existing file. Research results and local paths may appear in Pi session or tool logs; protect those logs accordingly.

## GitHub artifact publication

`research_publish` is disabled unless all publication settings are explicitly provided:

```text
PI_RESEARCH_PUBLISH_GITHUB=1
PI_RESEARCH_PUBLISH_OWNER=...
PI_RESEARCH_PUBLISH_REPO=...
PI_RESEARCH_PUBLISH_BRANCH=...
PI_RESEARCH_PUBLISH_PREFIX=...
PI_RESEARCH_PUBLISH_TOKEN=...
```

Use an existing repository, branch, and narrowly scoped contents-write token. Each operation previews the destination, paths, sizes, and content hashes, then requires confirmation. It creates immutable per-record Markdown, HTML, or Atom artifacts, refuses collisions, checks the branch base, and updates the ref without force. It returns a commit URL.

This is an artifact publisher, not GitHub Pages setup: it does not create or configure Pages, change repository permissions, or claim that a Pages deployment is live. Configure and verify Pages separately if a rendered site is desired.

## Verification and CI

Run the local checks from the package root:

```sh
npm test
npm run typecheck
npm run pack:check
npm run pack:smoke
```

`.github/workflows/ci.yml` is a standalone package-root workflow with a six-platform macOS, Linux, and Windows x64/arm64 matrix on Node 22.19. Each job runs fixture tests, strict typechecking, and a clean production-tarball installation. The badge links to actual run results. Windows transcript-helper execution is tested as deliberately unsupported; it is not silently counted as working caption retrieval.

## Provenance

Ketch is used at exact version `0.17.1`; see <https://github.com/1broseidon/ketch>. Public Pi/Ketch adapter behavior was also reviewed at <https://github.com/sovorn-c/pi-ketch/tree/fc303137029acd24e7ffa773b6ed4dcbb4ada1c5>. The adapter in this package is independently authored and does not import that implementation. Dependency updates should remain deliberate exact-pin reviews followed by CLI contract checks.
