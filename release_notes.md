# Release Notes - Version 1.5

We are excited to release **Version 1.5** of the Enhanced History Viewer. This update introduces local-only history filtering, parallel pre-rendering optimizations, and new automated codebase mapping & code health checking scripts.

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
