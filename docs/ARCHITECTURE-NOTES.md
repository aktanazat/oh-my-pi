# Architecture Notes

A map of this repository for reviewers who are new to the fork: what each package
and crate does, how the CLI process model works, who owns state, where state
crosses process boundaries, and which invariants the code relies on without
enforcing.

Line references use `path:line` and point at `main` as of this document's commit.
They will drift; treat them as anchors, not contracts. Items verified to be
unknown are marked **uncertain** rather than guessed.

Sources: `packages/*/package.json` dependency fields, crate `lib.rs` doc
comments, and direct code inspection (paths cited inline).

## 1. Repository layout

### 1.1 Packages (`packages/`)

Deps below are the internal (`@oh-my-pi/*`) dependencies declared in each
package's `package.json`.

| Package (dir) | Name | Role | Internal deps |
|---|---|---|---|
| `packages/agent` | `@oh-my-pi/pi-agent-core` | Agent runtime: tool-calling loop, compaction, pause, run collection (`src/agent.ts`, `src/agent-loop.ts`, `src/compaction.ts`) | pi-ai, pi-catalog, pi-natives, pi-utils, pi-wire, snapcompact |
| `packages/ai` | `@oh-my-pi/pi-ai` | Multi-provider LLM client, streaming, auth storage. Providers under `src/providers/` (anthropic.ts, amazon-bedrock.ts, azure-openai-responses.ts, …) | omptype, pi-catalog, pi-utils, pi-wire |
| `packages/browser-relay` | `@oh-my-pi/browser-relay` | Chrome extension relay for browser tools | none |
| `packages/catalog` | `@oh-my-pi/pi-catalog` | Bundled `models.json` (generated — never hand-edit), provider descriptors, identity/classify | omptype, pi-utils |
| `packages/coding-agent` | `@oh-my-pi/pi-coding-agent` | The CLI: sessions, tools, TUI modes, LSP/DAP, extensions. See §2–§5 | hashline, omp-stats, omptype, pi-agent-core, pi-ai, pi-catalog, pi-mnemopi, pi-natives, pi-tui, pi-utils, pi-wire, snapcompact |
| `packages/collab-web` | `@oh-my-pi/collab-web` | Guest client + relay for browser collaboration | pi-utils, pi-wire |
| `packages/hashline` | `@oh-my-pi/hashline` | Line-anchored patch applier | pi-natives, pi-utils |
| `packages/metaharness` | `@oh-my-pi/pi-metaharness` | Benchmark runners/dashboard | hashline, pi-agent-core, pi-ai, pi-catalog, pi-coding-agent, pi-natives, pi-utils, typescript-edit-benchmark |
| `packages/mnemopi` | `@oh-my-pi/pi-mnemopi` | SQLite-backed memory engine | pi-ai, pi-catalog, pi-natives, pi-utils |
| `packages/natives` | `@oh-my-pi/pi-natives` | TypeScript bridge over the Rust N-API cdylib (d.ts in `native/`) | none |
| `packages/omptype` | `@oh-my-pi/omptype` | ArkType-compatible lazy-JIT schema validation | none |
| `packages/snapcompact` | `@oh-my-pi/snapcompact` | Bitmap-frame context compression | pi-ai, pi-catalog, pi-natives, pi-utils, pi-wire |
| `packages/stats` | `@oh-my-pi/omp-stats` | Usage dashboard; background sync worker spawned by the CLI | pi-ai, pi-catalog, pi-utils |
| `packages/tui` | `@oh-my-pi/pi-tui` | Differential-render terminal UI (`src/editor.ts`, `src/markdown.ts`, components) | pi-natives, pi-utils |
| `packages/typescript-edit-benchmark` | `@oh-my-pi/typescript-edit-benchmark` | Edit-quality benchmarks | hashline, pi-agent-core, pi-ai, pi-catalog, pi-coding-agent, pi-natives, pi-tui, pi-utils |
| `packages/utils` | `@oh-my-pi/pi-utils` | Logger, streams (`parseJsonlLenient`), worker-host env, shared helpers | pi-natives |
| `packages/wire` | `@oh-my-pi/pi-wire` | Shared wire types | none |

### 1.2 Crates (`crates/`)

Roles are taken from each crate's `src/lib.rs` doc comment where present;
otherwise noted as inferred from module names.

| Crate | Role | Evidence |
|---|---|---|
| `pi-natives` | "Native utilities exported via N-API for the Oh My Pi toolchain" — grep, PDF, audio, PTY, clipboard, images; the single cdylib behind `packages/natives` | `crates/pi-natives/src/lib.rs:1` |
| `pi-ast` | AST parsing primitives: language grammars, block/summary extraction, parse cache (**role inferred from module names** — no lib.rs doc comment) | `crates/pi-ast/src/{block.rs,language/,ops.rs,parse_cache.rs,summary.rs}` |
| `pi-walker` | "Reusable platform directory traversal primitives" | `crates/pi-walker/src/lib.rs:1` |
| `pi-shell` | Embedded brush shell process layer: shell lifecycle, cancellation, output minimizer | `crates/pi-shell/src/{shell.rs,cancel.rs,minimizer.rs,process.rs}` |
| `pi-builtins` | "Builtins and in-process command-line utilities for the embedded brush shell" | `crates/pi-builtins/Cargo.toml` description |
| `pi-iso` | "Cross-platform isolation PAL" — overlayfs, projfs, btrfs, APFS clone/reflink, diff | `crates/pi-iso/src/lib.rs:1` |
| `pi-voice` | "Native voice engine: microphone capture, speaker playback, and the WebRTC live-conversation peer" | `crates/pi-voice/src/lib.rs:1` |
| `vendor/` | Vendored upstream sources (`brush-core` shell) | `crates/vendor/brush-core/` |

## 2. CLI process model

`packages/coding-agent/src/cli.ts` (475 lines) is the single entry point and
doubles as the worker host. What it does, in order:

1. **Worker dispatch, before any `await`** (`cli.ts:390-396`). If `argv[0]` is a
   hidden worker selector (`isWorkerHostSelector`, `packages/utils/src/worker-host.ts:7`),
   the process re-enters as that worker via `runWorkerEntrypoint` and returns.
   An unknown selector is a runtime error (`cli.ts:392-394`).
   The eight selectors are constants at `cli.ts:134-141`:
   `__omp_worker_tiny_inference`, `__omp_worker_stats_sync`, `__omp_worker_tab`,
   `__omp_worker_js_eval`, `__omp_worker_js_eval_process`, `__omp_worker_stt`,
   `__omp_worker_tts`, `__omp_worker_mnemopi_embed`.
   Early dispatch is load-bearing: the stats sync worker installs its
   `self.onmessage` handler in the synchronous prefix, and Bun flushes parked
   worker messages as soon as the entry module finishes top-level evaluation
   (`cli.ts:385-389`).
2. **Worker-host declaration** (`cli.ts:408`). `declareWorkerHostEntry()` runs
   only when `isProcessEntry` — worker-thread re-entry already returned in step 1,
   and SDK/test importers have `import.meta.main === false`. Declaring on the
   wrong path would poison `workerHostEntry()` for the whole process
   (`cli.ts:399-407`).
3. **Proxy install via dynamic import** (`cli.ts:421-435`). `pi-ai` is loaded
   dynamically so `--version`, worker selectors, and other non-network paths
   never load the provider graph.
4. **Startup composer gate** (`cli.ts:437-448`). The TUI startup composer is
   dynamically imported only for bare interactive launches (TTY stdin+stdout,
   no other args).
5. **Command resolution** (`cli.ts:449-452`). `main.ts` (2,043 lines) parses argv
   into `createAgentSession()` options; the SDK does the rest (`main.ts:1-5`).

### 2.1 Worker processes

Workers are spawned by callers that resolve the current binary and re-invoke it
with a selector argv, via the `workerHostEntry()` pattern
(`packages/utils/src/worker-host.ts`, consumed at
`packages/coding-agent/src/subprocess/worker-client.ts:123`,
`packages/coding-agent/src/tools/browser/tab-supervisor.ts:1081`,
`packages/coding-agent/src/tools/browser/registry.ts:181,222`,
`packages/coding-agent/src/tools/computer/supervisor.ts:104`,
`packages/coding-agent/src/eval/js/context-manager.ts:688`,
`packages/coding-agent/src/launch/terminal-output-worker-client.ts:14`,
`packages/stats/src/aggregator.ts:138`).

### 2.2 LSP and DAP subprocesses

LSP servers and linters spawn through `Bun.spawn`:
`packages/coding-agent/src/lsp/lspmux.ts:104`,
`packages/coding-agent/src/lsp/workspace-diagnostics.ts`,
`packages/coding-agent/src/lsp/clients/biome-client.ts`,
`packages/coding-agent/src/lsp/clients/swiftlint-client.ts`.
DAP adapter processes are managed in `packages/coding-agent/src/dap/client.ts`
and `packages/coding-agent/src/dap/session.ts`.

### 2.3 Native boundary

`packages/natives` is the TypeScript side of the N-API boundary; its bindings
are the `.d.ts` files under `packages/natives/native/`. The Rust
implementation is `crates/pi-natives` (§1.2), built with `bun run build:native`.

## 3. State ownership

- **Agent core state.** `class Agent` (`packages/agent/src/agent.ts:354`) owns
  `#state: AgentState` (`agent.ts:355`): system prompt, model, thinking level,
  tools, messages, streaming flag, pending tool calls — all ES `#private`.
  Steering/follow-up queues hang off the same object. `agent-loop.ts`
  (2,950 lines) converts `AgentMessage` to provider `Message` only at the LLM
  boundary.
- **Session state.** `class AgentSession`
  (`packages/coding-agent/src/session/agent-session.ts:471`, 9,730 lines) owns
  `SessionManager`, `Settings`, `SessionTools`, the yield queue, plan/vibe/goal
  mode state, bash/eval runners, async jobs, title generation, handoff, and
  maintenance. `SessionManager` (`session/session-manager.ts`) owns the JSONL
  session file and the in-memory entry list (`#entries`, `session-manager.ts:476`).
- **Tool state.** `ToolSession` (`packages/coding-agent/src/tools/index.ts:157`)
  is a plain data/context object — cwd, `additionalDirectories`, `hasUI`,
  event bus, session-manager handle — passed to tool factories. Tools own no
  session state; everything they need arrives in this object.
- **UI state.** The interactive TUI (`packages/coding-agent/src/modes/interactive-mode.ts`,
  5,725 lines) and the controllers under `packages/coding-agent/src/modes/controllers/`
  own all UI state. Non-interactive runs use `modes/print-mode.ts`; the
  agent-to-UI bridge lives under `modes/rpc/`.

## 4. Cross-process boundaries

| Boundary | Mechanism | Where |
|---|---|---|
| Session persistence | JSONL file, append + atomic rewrite | `session/session-manager.ts`, load in `session/session-loader.ts` |
| Main ↔ workers | argv-selector re-entry, then message RPC over the worker inbox | `packages/utils/src/worker-host.ts`, `subprocess/worker-client.ts:123`, selectors at `cli.ts:134-141` |
| Main ↔ LSP/DAP | JSON-RPC over stdio/TCP to `Bun.spawn`ed processes | `lsp/lspmux.ts:104`, `dap/client.ts` |
| TS ↔ Rust | N-API function calls (same process, no serialization) | `packages/natives/native/*.d.ts` ↔ `crates/pi-natives` |

## 5. Unenforced invariants

Invariants the code depends on that no type, assertion, or entry check enforces.
Ranked by the risk of silent corruption; these are documented, not fixed, here.

1. **Session JSONL entries are cast, not validated, at load.**
   `parseJsonlLenient<T>` returns `values as T[]` (`packages/utils/src/stream.ts:455`)
   with no shape check; `parseSessionContent` casts to `FileEntry[]`
   (`session/session-loader.ts:74-75`); `session-manager.ts:1379` casts
   `fileEntries[0] as SessionHeader` and `:1393` casts `fileEntries.slice(1) as
   SessionEntry[]`. A crash mid-append can persist a valid-JSON, wrong-shape
   record that flows straight into the session tree.
2. **"entries[0] is a valid session header" is a comment only.**
   `session-manager.ts:1378` states the guarantee; `parseSessionContent`
   (`session-loader.ts:66-78`) never checks `entries[0].type === "session"`. A
   foreign first line yields `header.cwd === undefined` and silently skips cwd
   adoption (`session-manager.ts:1385-1390`).
3. **DAP placeholder process.** Before the adapter spawns, a fake object is cast
   in: `as unknown as DapClientState["proc"]` (`dap/client.ts:161`). Early
   readers see a lie, not `undefined`.
4. **Agent-message snapshot cast.** `agent-session.ts:466` returns a
   hand-cloned snapshot `as unknown as AgentMessage` with no shape check.
5. **Structured subagent output is permissive by default.** `outputSchema` is
   `unknown` and `outputSchemaMode` "defaults to legacy permissive behavior"
   (`tools/index.ts:222-224`, `tools/task/executor.ts:383-385`). A validator
   exists but is not enforced by default (**uncertain** which call paths pass a
   schema; the default-off behavior is verified).
6. **Registry park promise is a placeholder.** `undefined as unknown as
   Promise<void>` (`registry/agent-lifecycle.ts:262`); resolving before
   assignment produces a confusing failure rather than a typed error.
7. **Worker selector ↔ dispatch-table linkage is by convention only.** Nothing
   type-level connects a selector constant (`cli.ts:134-141`) to its arm in
   `runWorkerEntrypoint` (`cli.ts:143-240`); adding one without the
   other fails at runtime ("unknown worker selector", `cli.ts:392-394`).
8. **Malformed-record rewrite** (**uncertain — crash-atomicity not verified**):
   on load, `#rewriteRequired = migrated || loaded.malformedRecords > 0`
   (`session-manager.ts:1398`) triggers a full rewrite; whether `#rewriteAtomically`
   is crash-atomic was not verified for this document.

## 6. Build and check surface

For verification of a docs-only or any change:

- `bun run check` — typecheck (never `tsc` directly; see `AGENTS.md`).
- `bun run lint` — Biome (TS) + clippy (Rust) formatting/lint gate.
- `bun run test` / `bun run test:rs` — TS and Rust test suites (never `cargo test` directly; see `AGENTS.md`).
- Full details of buckets, network-dependent tests, and CI jobs: `.github/workflows/ci.yml` and `AGENTS.md`.
