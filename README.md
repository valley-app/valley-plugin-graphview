# Graph View

Knowledge graph of the vault with filters, color groups, saved graphs, and a per-file local graph.

## Using the graph

- **Saved graphs.** The row under the Graph header names the active graph. Click the name to switch, rename, duplicate or delete graphs (after a confirmation); `+` starts a new graph from the whole vault. Every change saves into the active graph, and ⌘Z undoes rename, duplicate and delete. The Default graph always exists; naming it saves it as its own graph and resets Default to the whole vault.
- **Filters.** The graph starts from the whole vault. Type a query into *Whole vault* to start from fewer files, then add exclusions to subtract from that set; the counts show how many files each step covers. Queries use `tag:#name`, `path:folder`, free text, `-` to negate a term, and double quotes for spaces: `path:"Projects/Copper Finch/"`.
- **Sources.** Tags, attachments and orphans have their own switches and colors. Registered Markdown sources appear separately under Plugins, including empty sources. Settings → Graph View lists registered plugins in the shared Search-style cards, with version, author, graph contribution details and a settings shortcut; its switches control the active graph. Plugin colors follow the palette from bottom to top, cycling when exhausted, with explicit color choices preserved.
- **Graph tab.** The workspace header shows the selected graph’s name and updates when it is switched or renamed. Properties has Info and Search tabs; Find in graph occupies a standard search row with matching nodes listed below. Click a result to focus it and color its dot with the accent color; Enter and ⇧Enter step through matches. Nodes and Links appear in the footer; Graph name and Groups are optional Footer details. Info shows plain values and a Filter breakdown counting visible nodes in their first matching color group. The legend explains the colors, and the ⋯ menu replays the vault's growth with *Animate history*.

- **Local graph.** The right sidebar follows the current file, highlighted in the accent color. Its first row selects an existing graph and opens Filters or Display. The second row contains depth (1–10 connections) and one arrows toggle. There is no local Color groups editor or new-graph button. Selecting a saved global graph copies its settings once; subsequent local changes save separately for each graph.

This repository owns the plugin’s interface, behavior, dependencies, schemas, tests, translations, and compiled releases. It uses Valley manifest API 5 and the injected SDK 6.

Valley ships this core plugin as a verified release artifact in its application resources and copies that exact package into the vault's `.valley/plugins/packages/core/graphView/` when the vault opens, replacing the copy whenever the bundled release differs; never edit that copy by hand. Core and external installations run with the same sandbox, permissions, and SDK/IPC contract. Ordinary vault documents and saved plugin data (`.valley/plugins/data/graphView/`) keep their existing locations.

## Package

- `manifest.json`: readable English identity, version, and paired `author` / `authorUrl` arrays.
- `config.json`: runtime entry points, permissions, contributions, and storage declarations.
- `src/`: plugin interface.
- `src/wasm/`: the force-layout kernel in Rust (built to `runtime/assets/layout.wasm`, declared in `config.json` under `runtime.wasm`).
- `locales/`: English, German, Spanish, French, and Simplified Chinese catalogs.
- `tests/`: package-owned checks using the portable SDK testkit.
- `runtime/`: compiled installation artifact, including the package’s locale catalogs.
- `vendor/`: pinned SDK, testkit, and build-tool archives for independent development.

The package’s `manifest.name` and `manifest.description` catalog entries translate its identity, including while disabled. Missing translations fall back to this package’s English catalog. A plugin never falls back to Valley’s catalog or another plugin’s catalog.

## Development and releases

Use Node 24.19.0 and npm 11.17.0, and Rust from `rustup` (the toolchain pinned in `rust-toolchain.toml`) with binaryen's `wasm-opt` at the version plugin-tools names. From this repository, run:

```sh
npm ci
npm run check
```

The check validates types and package boundaries, builds the layout kernel twice (the bytes must match each other and the `sha256` in `config.json`), runs the package tests, including the 200-tick layout goldens in `tests/fixtures/layout-goldens.json`, and rebuilds `runtime/`. After a kernel change, commit the digest the build reports. It requires no Valley source checkout. Keep the rebuilt runtime, locale files, dependency lock, and vendored tools with each release. Increment the package and manifest versions together.

Valley release maintainers explicitly import the compiled artifact into the application’s `plugins.lock.json`; building Valley does not build or read this repository. All privileged work uses declared SDK capabilities, authenticated IPC, and explicit grants. Disabling or unloading the plugin releases its subscriptions and resources.

## Registering Markdown sources

Graph uses the SDK's `api.documents.sources()` registry and `api.documents.query()` / `onChanged()` APIs. A plugin declares each structured Markdown inbox or note field in `config.json` under `noteDocuments`, including its dataset, body column, identity and navigation command. Calendar, SideNotes and To-Do already use this contract. Sources are discovered automatically from these declarations, without a Graph-specific plugin-ID list or direct reads of another plugin's files. The settings cards use the registered dataset titles and source-file declarations returned by the plugin backend to describe graph nodes and connections, rather than the plugin’s general manifest description. Only registered sources enter the graph; disabling or unloading a provider removes its sources on the next inventory event. Ordinary vault Markdown files remain part of the vault index.

New global, local and embedded graphs default to arrows and legend off, text fade 0.2, node size 1.2, link thickness 0.7, center 0.4, repel 1.3, link 0.5 and link distance 135. Explicit saved settings are preserved.

## Workflow integration

The backend explicitly registers its supported blocks through `registerWorkflowContribution`. Workflow calls the owning operations with their original authentication, cancellation, grants, revisions, and receipts. The catalogue publishes Draft-07 parameter and port contracts; credential administration and approval bypasses are excluded. Workflow availability is configured separately in Workflow → Plugins. Existing account, connection, and profile settings remain owned by this plugin.

Workflow output collections are explicit: `sources` → `$.value`. Selectors are relative to each execution item’s `json`. The selected value is the explicit registered source list, with no graph-node or link collection inferred.
