# Release Notes - Version 1.6

We are excited to release **Version 1.6** of the Enhanced History Viewer. This update introduces scalable non-blocking history rendering, repeatable real-Chrome performance benchmarks, append-only benchmark results, and an updated development toolchain.

---

## What's New in v1.6

### 1. History Rendering Performance

- **Non-Blocking Status Enrichment**: History rows render before synced/local status lookups when the local-only filter is disabled. Lookups use bounded concurrency, short-lived caching, and history-event invalidation, while local-only filtering remains accurate.
- **Scalable List Rendering**: Uses in-memory deduplication, batched document fragments, delegated row actions, stable date-group maps, observer-based infinite scrolling, offscreen content containment, and lazy favicon loading.
- **Measured Improvement**: Repeatable five-run Chrome/Puppeteer benchmarks showed faster initial and full-list rendering at every tested size.
- **50 Items**: Initial rendering 171→88 ms (-49%); full-list loading 224→123 ms (-45%).
- **250 Items**: Initial rendering 129→90 ms (-30%); full-list loading 805→656 ms (-18%).
- **1,000 Items**: Initial rendering 268→224 ms (-17%); full-list loading 6.32→5.04 s (-20%). Event listeners fell from 4,012 to 1,013 (-75%).
- **Deferred Visit Lookups**: `getVisits` is not called before the first row is rendered; lookup concurrency is capped at 6.

### 2. Development Tooling & Performance Tests

- **Updated Toolchain**: Upgraded TypeScript to 7, plus Node.js types, Oxlint, Prettier, and TSX, and added Puppeteer 25.9 for real-browser validation.
- **Repeatable Chrome Benchmark (`npm run benchmark:performance`)**: Runs initial render, infinite-scroll, search, and local-only workloads against locally seeded history in isolated temporary Chrome profiles at 50, 250, and 1,000 items.
- **Correctness Invariants (`npm run test:performance`)**: Separately verifies behavior and structural performance guarantees without flaky wall-clock thresholds.
- **Append-Only Results**: Benchmark outputs use unique timestamped run IDs and exclusive file creation, preserving prior results. Local environment artifacts remain excluded from version control.

---

## What's New in v1.5

### 1. "This device only" History Filter

- **Native Sidebar Toggle Switch**: Added a Google/Chrome-style toggle switch inside the sidebar navigation section.
- **Row-wide Toggle Click**: Users can toggle the device filter simply by clicking anywhere on the menu item row.
- **Context-aware UI**: The switch dynamically hides when browsing "Tabs from other devices" and shows when returning to local history.

### 2. Pre-Render Verification (Performance Optimization)

- **Zero Scroll Stuttering**: Resolves the device status (`isLocal`) for all history entries in parallel before grouping or DOM generation.
- **No Layout Jumps**: By filtering non-local items out before they are ever appended, we've eliminated post-render deletions and layout thrashing, resulting in completely smooth scrolling.
- **Adaptive Viewport Auto-loading**: Automatically loads subsequent pages of history if filtering leaves the screen too short to scroll.

### 3. Codebase Mapping & Code Health Scripts

- **Automated Codebase Mapping (`npm run map-codebase`)**: Traverses manifest entry points and HTML source documents to chart asset dependencies and flag orphaned files in `docs/CODEBASE_GRAPH.md`.
- **AST-Based Code Health (`npm run check-code-health`)**: Utilizes the official TypeScript compiler API to parse JavaScript files into Abstract Syntax Trees (AST) to detect unused function declarations without relying on regular expressions.

---

## What's New in v1.4

### 1. Bulk History Management

- **Multi-Selection Checkboxes**: Easily select multiple history items in the main list.
- **Selection Action Bar**: A dynamic bar slides in over the search bar when items are checked, displaying the count of selected items.
- **Bulk Delete**: Delete multiple history items in parallel using a single "Delete" click.

### 2. Device Integration & Smart Sync Indicators

- **"Tabs from other devices" View**: Access tabs currently open on your other synced devices directly from a dedicated sidebar tab.
- **Smart Device Icons**: Non-local history visits now display a clean, native-looking **Multi-Device icon** next to the page titles.
- **Adaptive Tab Favicon**: Integrated a transparent favicon for the history page tab that dynamically paints light/dark based on system theme.

### 3. Performance & Stability Improvements

- **Infinite Scroll Guard**: Implemented paging check optimization to halt background queries when the end of history is reached.
- **Race Condition Mitigation**: Handled stale query discards to prevent delayed search results from clashing on rapid keystrokes.
- **Favicon Cache Bypassing**: Implemented cache-busting overrides for custom page icons.

---
