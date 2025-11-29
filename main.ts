import { Plugin, TFolder, WorkspaceLeaf, TAbstractFile } from 'obsidian';

interface DrilldownSettings {
	focusPath: string;
}

const DEFAULT_SETTINGS: DrilldownSettings = {
	focusPath: '/'
}

export default class FolderDrilldownPlugin extends Plugin {
	settings: DrilldownSettings = DEFAULT_SETTINGS;
	private clickHandler: (evt: MouseEvent) => void = () => {};
	private lastClickTime: number = 0;
	private lastClickTarget: HTMLElement | null = null;

	async onload() {
		await this.loadSettings();

		// Register global event listener for delegation
		// Use capture phase to intercept the second click of a double-click
		this.clickHandler = (evt: MouseEvent) => this.handleClick(evt);
		window.addEventListener('click', this.clickHandler, { capture: true });

		// Command to reset focus to root
		this.addCommand({
			id: 'drilldown-reset',
			name: 'Reset Focus (Go to Root)',
			callback: () => {
				this.setFocus('/');
			}
		});

		// Command to go back up one level
		this.addCommand({
			id: 'drilldown-back',
			name: 'Go Back (Up one level)',
			callback: () => {
				this.goBack();
			}
		});

		// Apply initial drilldown when layout is ready
		this.app.workspace.onLayoutReady(() => {
			this.applyDrilldown();
		});

		// Re-apply filtering if DOM structure changes
		// 'layout-change' triggers on workspace structure modifications
		this.registerEvent(
			this.app.workspace.on('layout-change', () => {
				this.applyDrilldown();
			})
		);
		
		// Listen for file changes to keep view updated
		this.registerEvent(
			this.app.vault.on('rename', () => this.applyDrilldown())
		);
		this.registerEvent(
			this.app.vault.on('delete', () => this.applyDrilldown())
		);
		this.registerEvent(
			this.app.vault.on('create', () => this.applyDrilldown())
		);
	}

	onunload() {
		// Cleanup: Remove all added CSS classes
		this.clearDrilldownStyles();
		// Remove manual event listener
		window.removeEventListener('click', this.clickHandler, { capture: true });
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	/**
	 * Handle click to manually detect double-click and intercept event.
	 */
	private handleClick(evt: MouseEvent) {
		const target = evt.target as HTMLElement;
		
		// Check if click occurred in file explorer
		const explorerContainer = target.closest('.nav-files-container');
		if (!explorerContainer) return;

		const currentTime = new Date().getTime();
		const isSameTarget = this.lastClickTarget === target;
		const isDouble = isSameTarget && (currentTime - this.lastClickTime < 300);

		if (isDouble) {
			// Double-click detected
			// Prevent propagation so Obsidian doesn't process this second click (which would toggle folder)
			evt.preventDefault();
			evt.stopPropagation();
			
			// Reset to avoid triple-click being detected as another double-click
			this.lastClickTime = 0;
			this.lastClickTarget = null;

			this.handleDrilldownAction(target);
		} else {
			// First click
			this.lastClickTime = currentTime;
			this.lastClickTarget = target;
		}
	}

	/**
	 * Execute drilldown action based on target.
	 */
	private handleDrilldownAction(target: HTMLElement) {
		// Case 1: Click on a folder title
		const folderTitle = target.closest('.nav-folder-title');
		if (folderTitle) {
			const path = (folderTitle as HTMLElement).getAttribute('data-path');
			if (path) {
				// If double-clicking the ALREADY focused folder, go back
				if (path === this.settings.focusPath) {
					this.goBack();
				} else {
					// Otherwise, focus on this folder
					this.setFocus(path);
				}
				return;
			}
		}

		// Case 2: Click on empty space (to go back)
		// If clicking container itself or children area (but not a title)
		if (target.classList.contains('nav-files-container') || target.classList.contains('nav-folder-children')) {
			// Only go back if not already at root
			if (this.settings.focusPath !== '/') {
				this.goBack();
			}
		}
	}

	/**
	 * Set new focus path and update view.
	 */
	private async setFocus(path: string) {
		// Validation: Ensure folder still exists
		// Root '/' is always valid
		if (path !== '/') {
			const folder = this.app.vault.getAbstractFileByPath(path);
			if (!folder || !(folder instanceof TFolder)) {
				// If folder doesn't exist, fallback to root
				console.warn(`FolderDrilldown: Path ${path} is invalid. Resetting to root.`);
				path = '/';
			} else {
				// Ensure folder is expanded to see content
				// Done immediately since we intercepted the click that would have closed it
				this.expandFolder(folder);
				// Collapse direct children for a clean view
				this.collapseDirectChildren(folder);
			}
		}

		this.settings.focusPath = path;
		await this.saveSettings();
		this.applyDrilldown();
	}

	/**
	 * Collapse all direct subfolders of the given folder.
	 */
	private collapseDirectChildren(folder: TFolder) {
		const leaves = this.app.workspace.getLeavesOfType('file-explorer');
		leaves.forEach((leaf: WorkspaceLeaf) => {
			const view = leaf.view as any;
			
			folder.children.forEach(child => {
				if (child instanceof TFolder) {
					// Try accessing via internal fileItems API
					if (view.fileItems && view.fileItems[child.path]) {
						const item = view.fileItems[child.path];
						if (typeof item.setCollapsed === 'function') {
							// true to collapse
							item.setCollapsed(true);
						}
					} 
					// Fallback
					else if (view.setExpanded) {
						view.setExpanded(child, false);
					}
				}
			});
		});
	}

	/**
	 * Expand a folder in the file explorer.
	 */
	private expandFolder(folder: TFolder) {
		const leaves = this.app.workspace.getLeavesOfType('file-explorer');
		leaves.forEach((leaf: WorkspaceLeaf) => {
			const view = leaf.view as any;
			
			// Try accessing via internal fileItems API (more reliable for visual state)
			if (view.fileItems && view.fileItems[folder.path]) {
				const item = view.fileItems[folder.path];
				if (typeof item.setCollapsed === 'function') {
					// false to expand
					item.setCollapsed(false);
				}
			} 
			// Fallback to old method if fileItems is not accessible
			else if (view.setExpanded) {
				view.setExpanded(folder, true);
			}
		});
	}

	/**
	 * Go up one level in hierarchy.
	 */
	private async goBack() {
		if (this.settings.focusPath === '/') return;

		const currentFolder = this.app.vault.getAbstractFileByPath(this.settings.focusPath);
		
		if (currentFolder && currentFolder.parent) {
			// If parent is root, path is '/'
			// TFolder.path for root is '/'
			const parentPath = currentFolder.parent.path;
			this.setFocus(parentPath);
		} else {
			// Fallback
			this.setFocus('/');
		}
	}

	/**
	 * Apply CSS classes to hide/show elements based on current focus.
	 */
	private applyDrilldown() {
		const focusPath = this.settings.focusPath;
		
		// Get file explorer view
		const leaves = this.app.workspace.getLeavesOfType('file-explorer');
		if (leaves.length === 0) return;
		
		// Apply to all open file explorer instances
		leaves.forEach((leaf: WorkspaceLeaf) => {
			const container = leaf.view.containerEl.querySelector('.nav-files-container');
			if (!container) return;

			// Get all folder and file elements
			const items = container.querySelectorAll('.nav-folder, .nav-file');
			
			items.forEach((item: Element) => {
				const titleEl = item.querySelector('.nav-folder-title, .nav-file-title') as HTMLElement;
				if (!titleEl) return;
				
				const path = titleEl.getAttribute('data-path');
				if (!path) return;

				// If at root, show everything
				if (focusPath === '/') {
					item.classList.remove('is-hidden-by-drilldown');
					if (item.classList.contains('nav-folder')) {
						const title = item.querySelector('.nav-folder-title');
						if (title) title.classList.remove('is-hidden-by-drilldown');
					}
					return;
				}

				// Normalize for comparison
				const focusPathSlash = focusPath + '/';
				const pathSlash = path + '/';

				const isSelf = path === focusPath;
				const isDescendant = path.startsWith(focusPathSlash);
				// A folder is an ancestor if focus path starts with it
				// Root '/' is always an implicit ancestor, but has no corresponding .nav-folder
				const isAncestor = (path !== focusPath) && focusPath.startsWith(pathSlash);

				if (isSelf) {
					// The focus folder itself: Show container and title
					item.classList.remove('is-hidden-by-drilldown');
					const title = item.querySelector('.nav-folder-title');
					if (title) title.classList.remove('is-hidden-by-drilldown');
				} else if (isDescendant) {
					// Content of focus folder: Show everything
					item.classList.remove('is-hidden-by-drilldown');
					const title = item.querySelector('.nav-folder-title, .nav-file-title');
					if (title) title.classList.remove('is-hidden-by-drilldown');
				} else if (isAncestor) {
					// Ancestor: Show container (to see children)
					// BUT hide title to give illusion that focus is root
					item.classList.remove('is-hidden-by-drilldown');
					
					if (item.classList.contains('nav-folder')) {
						const title = item.querySelector('.nav-folder-title');
						if (title) title.classList.add('is-hidden-by-drilldown');
					}
				} else {
					// Everything else (siblings of ancestors, parallel branches): Hide
					item.classList.add('is-hidden-by-drilldown');
				}
			});
		});
	}

	/**
	 * Remove all visual modifications.
	 */
	private clearDrilldownStyles() {
		const leaves = this.app.workspace.getLeavesOfType('file-explorer');
		leaves.forEach((leaf: WorkspaceLeaf) => {
			const container = leaf.view.containerEl.querySelector('.nav-files-container');
			if (!container) return;
			const hidden = container.querySelectorAll('.is-hidden-by-drilldown');
			hidden.forEach((el: Element) => el.classList.remove('is-hidden-by-drilldown'));
		});
	}
}
