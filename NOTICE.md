# Provenance and dependencies

| Component | License | Use |
| --- | --- | --- |
| `ketch-cli@0.17.1` | MIT | Pinned runtime dependency, including platform-specific native binary; not copied source. |
| Pi host packages | MIT | Host-provided extension APIs, declared as peer dependencies. |
| TypeBox | MIT | Host-provided schemas, declared as a peer dependency. |

The Ketch adapter is independently authored. Public adapter behavior was reviewed at https://github.com/sovorn-c/pi-ketch/tree/fc303137029acd24e7ffa773b6ed4dcbb4ada1c5; that implementation is not imported or copied into this project.

Retain upstream license notices when redistributing dependencies. See `LICENSE` for this project's MIT terms.
