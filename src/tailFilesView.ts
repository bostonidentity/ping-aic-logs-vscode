import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { TailFileMeta } from './types';

export class TailFileItem extends vscode.TreeItem {
  constructor(public readonly meta: TailFileMeta) {
    const dur = Math.round((meta.endTime - meta.startTime) / 1000);
    super(`${meta.env}  ${meta.count} entries  ${dur}s`, vscode.TreeItemCollapsibleState.None);
    this.tooltip =
      `${meta.name}\nenv: ${meta.env}\nsource: ${meta.source}\nquery: ${meta.query || '(none)'}` +
      `\nstart: ${new Date(meta.startTime).toLocaleString()}` +
      `\nend:   ${new Date(meta.endTime).toLocaleString()}`;
    this.description = relativeTime(new Date(meta.startTime));
    this.iconPath = new vscode.ThemeIcon('archive', new vscode.ThemeColor('charts.orange'));
    this.contextValue = 'tailFile';
    this.command = {
      command: 'paicLogSearch.openTailFile',
      title: 'Open Tail File',
      arguments: [meta.name, meta.env]
    };
  }
}

function relativeTime(d: Date): string {
  const sec = Math.floor((Date.now() - d.getTime()) / 1000);
  if (sec < 60) return sec + 's ago';
  if (sec < 3600) return Math.floor(sec / 60) + 'm ago';
  if (sec < 86400) return Math.floor(sec / 3600) + 'h ago';
  return Math.floor(sec / 86400) + 'd ago';
}

function tailDir(context: vscode.ExtensionContext): string {
  return path.join(context.globalStorageUri.fsPath, 'tails');
}

async function readIndex(context: vscode.ExtensionContext): Promise<TailFileMeta[]> {
  try {
    const raw = await fs.readFile(path.join(tailDir(context), 'index.json'), 'utf8');
    const metas = JSON.parse(raw);
    return Array.isArray(metas) ? (metas as TailFileMeta[]) : [];
  } catch {
    return [];
  }
}

async function writeIndex(context: vscode.ExtensionContext, metas: TailFileMeta[]): Promise<void> {
  await fs.mkdir(tailDir(context), { recursive: true });
  await fs.writeFile(path.join(tailDir(context), 'index.json'), JSON.stringify(metas, null, 2));
}

export async function deleteTailFile(context: vscode.ExtensionContext, name: string): Promise<void> {
  try { await fs.unlink(path.join(tailDir(context), name)); } catch { /* ignore */ }
  const metas = (await readIndex(context)).filter((m) => m.name !== name);
  await writeIndex(context, metas);
}

export async function clearAllTailFiles(context: vscode.ExtensionContext): Promise<number> {
  const metas = await readIndex(context);
  await Promise.all(metas.map((m) =>
    fs.unlink(path.join(tailDir(context), m.name)).catch(() => { /* ignore */ })
  ));
  await writeIndex(context, []);
  return metas.length;
}

export async function listTailFiles(context: vscode.ExtensionContext): Promise<TailFileMeta[]> {
  return readIndex(context);
}

export class TailFilesProvider implements vscode.TreeDataProvider<TailFileItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<TailFileItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly context: vscode.ExtensionContext) {}

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(item: TailFileItem): vscode.TreeItem {
    return item;
  }

  async getChildren(): Promise<TailFileItem[]> {
    try {
      const indexPath = path.join(this.context.globalStorageUri.fsPath, 'tails', 'index.json');
      const raw = await fs.readFile(indexPath, 'utf8');
      const metas = JSON.parse(raw) as TailFileMeta[];
      if (!Array.isArray(metas)) return [];
      return metas
        .slice()
        .sort((a, b) => b.startTime - a.startTime)
        .map((m) => new TailFileItem(m));
    } catch {
      return [];
    }
  }
}
