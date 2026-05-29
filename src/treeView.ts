import * as vscode from 'vscode';
import { ConfigStore } from './config';

const ENV_DRAG_MIME = 'application/vnd.code.tree.paicenv';

export class EnvironmentItem extends vscode.TreeItem {
  constructor(label: string, public readonly url: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.tooltip = url;
    this.description = url.replace(/^https?:\/\//, '');
    this.contextValue = 'environment';
    this.iconPath = new vscode.ThemeIcon('server-environment', new vscode.ThemeColor('charts.green'));
    this.command = {
      command: 'paicLogSearch.openPanel',
      title: 'Open Search Panel',
      arguments: [label]
    };
  }
}

export class EnvironmentTreeProvider
  implements vscode.TreeDataProvider<EnvironmentItem>, vscode.TreeDragAndDropController<EnvironmentItem>
{
  private _onDidChangeTreeData = new vscode.EventEmitter<EnvironmentItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  // Drag-and-drop: enables "drag env to reorder" gesture.
  readonly dropMimeTypes = [ENV_DRAG_MIME];
  readonly dragMimeTypes = [ENV_DRAG_MIME];

  constructor(private readonly configStore: ConfigStore) {}

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: EnvironmentItem): vscode.TreeItem {
    return element;
  }

  getChildren(): vscode.ProviderResult<EnvironmentItem[]> {
    return this.configStore
      .listEnvironments()
      .map((env) => new EnvironmentItem(env.name, env.url));
  }

  // ── Drag & drop ────────────────────────────────────────────────────────
  handleDrag(source: readonly EnvironmentItem[], dataTransfer: vscode.DataTransfer): void {
    if (source.length !== 1) return;
    const name = String(source[0].label);
    dataTransfer.set(ENV_DRAG_MIME, new vscode.DataTransferItem(name));
  }

  async handleDrop(
    target: EnvironmentItem | undefined,
    dataTransfer: vscode.DataTransfer
  ): Promise<void> {
    const item = dataTransfer.get(ENV_DRAG_MIME);
    if (!item) return;
    const fromName = String(await item.asString());
    if (!fromName) return;
    const list = this.configStore.listEnvironments();
    let toIdx: number;
    if (!target) {
      toIdx = list.length;
    } else {
      const targetIdx = list.findIndex((e) => e.name === target.label);
      if (targetIdx < 0) return;
      toIdx = targetIdx;
    }
    await this.configStore.moveEnvironment(fromName, toIdx);
    this.refresh();
  }
}
