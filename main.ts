import { Plugin, TFolder, WorkspaceLeaf } from 'obsidian';

interface DrilldownSettings {
	focusPath: string;
}

const DEFAULT_SETTINGS: DrilldownSettings = {
	focusPath: '/'
}

interface InternalFileExplorerItem {
	setCollapsed?: (collapsed: boolean) => void;
}

interface InternalFileExplorerView {
	fileItems?: Record<string, InternalFileExplorerItem>;
	setExpanded?: (folder: TFolder, expanded: boolean) => void;
}

export default class FolderDrilldownPlugin extends Plugin {
	settings: DrilldownSettings = DEFAULT_SETTINGS;
	private lastClickTime: number = 0;
	private lastClickTarget: HTMLElement | null = null;

	async onload() {
		await this.loadSettings();

		// Register global event listener for delegation
		// Use capture phase to intercept the second click of a double-click
		this.registerDomEvent(window, 'click', (evt: MouseEvent) => this.handleClick(evt), { capture: true });

		// Command to reset focus to root
		this.addCommand({
			id: 'drilldown-reset',
			name: 'Reset focus (go to root)',
			callback: () => {
				void this.setFocus('/');
			}
		});

		// Command to go back up one level
		this.addCommand({
			id: 'drilldown-back',
			name: 'Go back (up one level)',
			callback: () => {
				void this.goBack();
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
		let target = evt.target as Node;
		// Handle text nodes (common on some platforms/browsers)
		// Use 3 instead of Node.TEXT_NODE to avoid potential reference errors if Node is not global
		if (target && target.nodeType === 3) {
			target = target.parentNode!;
		}

		// Safety check: Ensure target is a valid Element
		if (!target || !(target instanceof Element)) return;

		const element = target as HTMLElement;

		// Skip clicks on our own breadcrumb — handled by renderBreadcrumb
		if (element.closest('.drilldown-breadcrumb')) return;

		// Check if click occurred in file explorer
		const explorerContainer = element.closest('.nav-files-container');
		if (!explorerContainer) return;

		const currentTime = new Date().getTime();
		const isSameTarget = this.lastClickTarget === element;
		const isDouble = isSameTarget && (currentTime - this.lastClickTime < 300);

		if (isDouble) {
			// Double-click detected
			// Prevent propagation so Obsidian doesn't process this second click (which would toggle folder)
			evt.preventDefault();
			evt.stopPropagation();
			
			// Reset to avoid triple-click being detected as another double-click
			this.lastClickTime = 0;
			this.lastClickTarget = null;

			void this.handleDrilldownAction(element);
		} else {
			// First click
			this.lastClickTime = currentTime;
			this.lastClickTarget = element;
		}
	}

	/**
	 * Execute drilldown action based on target.
	 */
	private async handleDrilldownAction(target: HTMLElement) {
		// Case 1: Click on a folder title
		const folderTitle = target.closest('.nav-folder-title');
		if (folderTitle) {
			const path = (folderTitle as HTMLElement).getAttribute('data-path');
			if (path) {
				// If double-clicking the ALREADY focused folder, go back
				if (path === this.settings.focusPath) {
					await this.goBack();
				} else {
					// Otherwise, focus on this folder
					await this.setFocus(path);
				}
				return;
			}
		}

		// Case 2: Click on empty space (to go back)
		// If clicking container itself or children area (but not a title)
		if (target.classList.contains('nav-files-container') || target.classList.contains('nav-folder-children')) {
			// Only go back if not already at root
			if (this.settings.focusPath !== '/') {
				await this.goBack();
			}
		}
	}

	/**
	 * Set new focus path and update view.
	 */
	private async setFocus(path: string) {
		console.debug('FolderDrilldown: setFocus', path);
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
			const view = leaf.view as unknown as InternalFileExplorerView;
			
			folder.children.forEach(child => {
				if (child instanceof TFolder) {
					// Try accessing via internal fileItems API
					if (view.fileItems && view.fileItems[child.path]) {
						const item = view.fileItems[child.path];
						if (item && typeof item.setCollapsed === 'function') {
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
			const view = leaf.view as unknown as InternalFileExplorerView;
			
			// Try accessing via internal fileItems API (more reliable for visual state)
			if (view.fileItems && view.fileItems[folder.path]) {
				const item = view.fileItems[folder.path];
				if (item && typeof item.setCollapsed === 'function') {
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
			await this.setFocus(parentPath);
		} else {
			// Fallback
			await this.setFocus('/');
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

			// Render the breadcrumb (root + current path) at the top of the list
			this.renderBreadcrumb(container);

			// Get all folder and file elements
			const items = container.querySelectorAll('.nav-folder, .nav-file');
			
			items.forEach((item: Element) => {
				const titleEl = item.querySelector('.nav-folder-title, .nav-file-title');
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

			// ---- Indentation fix ----
			// Obsidian uses padding-inline-start on .nav-folder-children for tree
			// indentation. When we drill into a folder, all ancestor children
			// containers must lose that padding so the focused folder is flush left.
			if (focusPath === '/') {
				container.querySelectorAll('.nav-folder-children').forEach((el) => {
					(el as HTMLElement).style.removeProperty('padding-inline-start');
				});
			} else {
				const focusTitle = container.querySelector(
					'.nav-folder-title:not(.is-hidden-by-drilldown)[data-path="' + focusPath + '"]'
				);
				const focusFolder = focusTitle?.closest('.nav-folder');
				if (focusFolder) {
					let el: Element | null = focusFolder.parentElement;
					while (el && el !== container) {
						if (el.classList.contains('nav-folder-children')) {
							(el as HTMLElement).style.paddingInlineStart = '0';
						}
						el = el.parentElement;
					}
				}
			}
		});
	}

	/**
	 * Render a breadcrumb at the top of the file list showing the path from
	 * the root down to the current focus folder. Each crumb is clickable and
	 * jumps to that level. Hidden when already at the root.
	 */
	private renderBreadcrumb(container: Element) {
		const focusPath = this.settings.focusPath;
		let crumb = container.querySelector('.drilldown-breadcrumb') as HTMLElement | null;

		// At root there is nothing to drill into, so hide the breadcrumb.
		if (focusPath === '/') {
			if (crumb) crumb.remove();
			return;
		}

		if (!crumb) {
			crumb = document.createElement('div');
			crumb.className = 'drilldown-breadcrumb';
			container.insertBefore(crumb, container.firstChild);

			// Single delegated listener on the container — survives rebuilds
			crumb.addEventListener('click', (evt: MouseEvent) => {
				const crumbEl = (evt.target as HTMLElement).closest('.drilldown-crumb');
				if (!crumbEl) return;
				const dest = crumbEl.getAttribute('data-path');
				if (!dest) return;

				evt.preventDefault();
				evt.stopPropagation();
				console.debug(`Breadcrumb click: "${dest}"`);
				void this.setFocus(dest);
			});
		}
		// Rebuild contents on every pass (handles Obsidian re-renders too).
		while (crumb.firstChild) crumb.removeChild(crumb.firstChild);

		// Build the list of crumbs: always start with the root, then each segment.
		const segments = focusPath.split('/').filter((seg) => seg.length > 0);
		const crumbs: { label: string; path: string }[] = [{ label: '根目录', path: '/' }];
		let acc = '';
		for (const seg of segments) {
			acc += '/' + seg;
			crumbs.push({ label: seg, path: acc });
		}

		crumbs.forEach((c, i) => {
			const span = document.createElement('span');
			span.className = 'drilldown-crumb';
			span.setAttribute('data-path', c.path);
			if (c.path === focusPath) span.classList.add('is-current');
			span.textContent = c.label;
			crumb!.appendChild(span);

			if (i < crumbs.length - 1) {
				const sep = document.createElement('span');
				sep.className = 'drilldown-crumb-sep';
				sep.textContent = '\u203A'; // ›
				crumb!.appendChild(sep);
			}
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
			// Reset any inline indentation styles
			container.querySelectorAll('.nav-folder-children').forEach((el) => {
				(el as HTMLElement).style.removeProperty('padding-inline-start');
			});
			// Remove breadcrumb
			const bc = container.querySelector('.drilldown-breadcrumb');
			if (bc) bc.remove();
		});
	}
}
