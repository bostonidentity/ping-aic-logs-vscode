import * as vscode from 'vscode';
import { HistoryStore } from './history';
import { HistoryEntry } from './types';

export class RecentSearchItem extends vscode.TreeItem {
  constructor(public readonly entry: HistoryEntry) {
    const q = entry.query || '(no keyword)';
    const trimmed = q.length > 36 ? q.slice(0, 35) + '…' : q;
    super(`${entry.env}  ${trimmed}`, vscode.TreeItemCollapsibleState.None);

    const count = entry.totalCount;
    const countText = count == null ? '?' : String(count);
    const relTime = relativeTime(new Date(entry.timestamp));

    this.tooltip =
      `${entry.env}\nsource: ${entry.source}\nquery: ${q}\n${entry.begin || '?'} — ${entry.end || '?'}` +
      (count == null ? '' : `\n${count} entries`);
    // VS Code auto-mutes description text; count-then-time keeps the most
    // diagnostic info (how many results) leftmost in the muted region.
    this.description = `${countText} · ${relTime}`;
    // Different icon + color for zero-result searches as a visual cue without
    // hiding — 0 results is itself a valid diagnostic answer worth keeping
    // in history. Non-zero rows use charts.blue (informational); zero rows
    // use disabledForeground (muted) plus a different icon.
    this.iconPath = count === 0
      ? new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('disabledForeground'))
      : new vscode.ThemeIcon('history', new vscode.ThemeColor('charts.blue'));
    this.contextValue = 'recentSearch';
    // No `command` on click — running a search is destructive (replaces
    // current panel state or opens a tab). User picks Run / Run-in-new-tab /
    // Delete from the inline buttons that appear on hover.
  }
}

function relativeTime(d: Date): string {
  const sec = Math.floor((Date.now() - d.getTime()) / 1000);
  if (sec < 60) return sec + 's ago';
  if (sec < 3600) return Math.floor(sec / 60) + 'm ago';
  if (sec < 86400) return Math.floor(sec / 3600) + 'h ago';
  return Math.floor(sec / 86400) + 'd ago';
}

export class RecentSearchesProvider implements vscode.TreeDataProvider<RecentSearchItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<RecentSearchItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly historyStore: HistoryStore) {}

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(item: RecentSearchItem): vscode.TreeItem {
    return item;
  }

  getChildren(): RecentSearchItem[] {
    // Show every history entry up to the configured cap (default 100). Slicing
    // here used to mismatch what "Clear All" actually deleted, confusing users.
    return this.historyStore.list().map((e) => new RecentSearchItem(e));
  }
}
