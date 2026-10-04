# Release Notes - Version 1.7

**Version 1.7** of the Enhanced History Viewer rebuilds the history renderer with a focus on correctness and speed where it counts, redesigns the "Tabs from other devices" view, and fixes a series of edge-case bugs surfaced by systematic investigations.

---

## What's New in v1.7

### 1. Faster Where It Counts

- **Parallel Device-Status Lookups**: The "This device only" filter resolves a page's device status in a single round instead of a throttled queue — filtered views render several times faster whenever Chrome's history database is slow to answer.
- **Repeat-Search Cache**: Device-status results are remembered for 60 seconds, so repeating or refining a search doesn't re-query the History API.
- **Live History Updates**: The page now listens for visits and deletions that happen elsewhere — badges and rows stay current in real time.
- **Fast Page Opens**: A minimal service worker keeps Chrome's extension process warm, preserving the snappy history-page open from earlier versions.
- **Measured**: In real-Chrome benchmarks, opening and scrolling the full history matches or beats v1.6 (a 1,000-item scroll is ~25% faster), the device filter resolves in a single parallel round instead of a throttled queue, and repeat searches are served from cache without re-querying the History API.

### 2. Leaner Permissions & Zero External Requests

- **No Host Permissions**: Removed host access to `google.com` — favicons now resolve entirely through Chrome's local favicon API. The `tabs` permission is kept because the "Tabs from other devices" view needs synced tabs' URLs and titles, which Chrome hides without it.
- **Zero External Requests**: Removed the render-blocking Google Fonts stylesheet, and the favicon fallback now uses a local placeholder instead of sending hostnames from your history to Google. The extension no longer talks to any external server, ever.

### 3. A Refreshed "Tabs from Other Devices" View

- **Collapsible Device Groups**: Each device is now a clean, native-style section that you can collapse or expand with a single click.
- **Relative Timestamps**: Device headers show when they were last active ("– 23 minutes ago"), localized to your language.
- **Open All / Hide for Now**: The ⋮ menu on every device opens all of its synced tabs in the background, or hides the group for now — just like native Chrome.
- **Search Synced Tabs**: The search bar stays visible on this view and now filters tabs across your devices as you type.
- **Native-Aligned Typography**: Compact search bar, larger date headers, and a clearer active-page highlight in dark mode, using your system font.

### 4. Correctness Fixes

- **No More Silent Blank Views**: When "This device only" filters out every remaining result, the page now clearly states that no history from this device was found instead of showing an empty list.
- **No More Skipped Entries**: History entries that share the exact same timestamp across a page boundary (common with redirect chains) are no longer dropped from the list.
- **Stuck Spinner Fixed**: The loading indicator can no longer wedge permanently if a history lookup fails mid-load; every load path now guarantees cleanup, and visit lookups carry a timeout safety net.
- **No Ghost Rows**: Deleting entries while a filtered view is still rendering can no longer bring the deleted rows back.
- **Fresh Searches, Fresh Selection**: Starting a new search or switching filters now clears the previous selection, so the action bar no longer shows counts from results that are no longer visible.
- **Shift-Click Repair**: Range selection with Shift now falls back to a normal single pick when the anchor row no longer exists, keeping checkboxes and selection in sync.
- **Accurate Date Headers**: "Today" and "Yesterday" group headers update correctly if the page stays open past midnight.
- **More Synced Devices**: The "Tabs from other devices" view now lists up to 25 devices (the browser's maximum) instead of 10.

### 5. Security Hardening

- **No Reverse Tab-Nabbing**: Sites opened from history rows or synced-device tabs no longer receive a handle (`window.opener`) to the history page.

---

## What's New in v1.6

Performance improvements and tooling upgrades — see the [v1.6 release on GitHub](https://github.com/psipher/Enhanced-History-Viewer/releases/tag/1.6).

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
