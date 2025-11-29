# Code Quality & Architecture Standards

This document defines the coding standards for the `obsidian-folder-drilldown` plugin. Any contribution or code generation must adhere to these principles.

## 1. Tech Stack
* **Language:** TypeScript (Strict Mode enabled).
* **Framework:** Obsidian API (latest stable version).
* **Style:** Standard Prettier.

## 2. DOM & UI Manipulation
* **No Element Removal:** Never remove (`.remove()`) DOM elements from the File Explorer. Always use CSS (`display: none`) to hide unfocused folders. This prevents breaking Obsidian's internal indexing.
* **Event Delegation:** Do not attach event listeners to *each* folder individually. Attach a single listener to the `nav-files-container` and filter the target element.
* **Cleanup:** Any applied styles or attached events must be strictly removed in the `onunload()` method. The plugin must leave no trace when disabled.

## 3. State Management
* **Focus Path:** The state of the "currently focused folder" must be stored.
* **Persistence:** If the user restarts Obsidian, the plugin must remember the last focused folder (via `loadData` and `saveData`).
* **Boundaries:** Implement strict checks to prevent navigating higher than the vault root (`/`).

## 4. Error Handling
* **Vanishing Folders:** If the focused folder is renamed or deleted externally, the plugin must gracefully fallback to the parent folder or root without crashing the application.
* **Compatibility:** Verify that the File Explorer `leaf` is active before attempting to manipulate it.

## 5. Readability
* Use explicit variable names (e.g., `currentFocusedPath` instead of `path`).
* Document complex functions using JSDoc.