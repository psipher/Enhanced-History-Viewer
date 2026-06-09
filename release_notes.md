# Release Notes - Version 1.4

We are excited to release **Version 1.4** of the Enhanced History Viewer. This update introduces key features for managing history across multiple devices, bulk selection tools, performance improvements, and critical UI/UX refinements.

---

## What's New in v1.4

### 1. Bulk History Management
* **Multi-Selection Checkboxes**: Easily select multiple history items in the main list.
* **Selection Action Bar**: A dynamic bar slides in over the search bar when items are checked, displaying the count of selected items.
* **Bulk Delete**: Delete multiple history items in parallel using a single "Delete" click.

### 2. Device Integration & Smart Sync Indicators
* **"Tabs from other devices" View**: Access tabs currently open on your other synced devices directly from a dedicated sidebar tab.
* **Smart Device Icons**: Non-local history visits now display a clean, native-looking **Multi-Device icon** (monitor & laptop outline) next to the page titles.
* **Adaptive Tab Favicon (Option A)**: Integrated a transparent favicon for the history page tab that dynamically paints white/light-blue in Dark Mode and dark-grey/black in Light Mode to match Chrome's theme guidelines.

### 3. Performance & Stability Improvements
* **Infinite Scroll Guard**: Implemented paging check optimization to halt background queries when the end of history is reached.
* **Race Condition Mitigation**: Handled stale query discards to prevent delayed search results from clashing on rapid keystrokes.
* **Favicon Cache Bypassing**: Implemented cache-busting overrides for custom page icons.

---