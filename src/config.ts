import * as vscode from 'vscode';
import { EnvironmentMeta, EnvironmentSecret } from './types';

const SECRET_PREFIX = 'pingAicLogs.secret.';

/**
 * Storage for environment metadata + secrets.
 *
 * Strategy (locked in by design decision A):
 *   - Non-sensitive metadata (name, url) → workspace settings (paicLogSearch.environments)
 *     so users can version-control their env list if they want.
 *   - Secrets (key, secret) → VS Code SecretStorage (OS keychain), never on disk.
 *
 * Single source of truth for settings: vscode.workspace.getConfiguration('paicLogSearch').
 */
export class ConfigStore {
  constructor(private readonly context: vscode.ExtensionContext) {}

  listEnvironments(): EnvironmentMeta[] {
    const cfg = vscode.workspace.getConfiguration('paicLogSearch');
    return cfg.get<EnvironmentMeta[]>('environments', []);
  }

  async addEnvironment(meta: EnvironmentMeta, secret: EnvironmentSecret): Promise<void> {
    const list = this.listEnvironments();
    if (list.some((e) => e.name === meta.name)) {
      throw new Error(`Environment "${meta.name}" already exists.`);
    }
    list.push(meta);
    await this.persistList(list);
    await this.setSecret(meta.name, secret);
  }

  async deleteEnvironment(name: string): Promise<void> {
    const list = this.listEnvironments().filter((e) => e.name !== name);
    await this.persistList(list);
    await this.context.secrets.delete(SECRET_PREFIX + name);
  }

  /** Reorder: move env named `fromName` to position `toIdx` in the list. */
  async moveEnvironment(fromName: string, toIdx: number): Promise<void> {
    const list = this.listEnvironments();
    const fromIdx = list.findIndex((e) => e.name === fromName);
    if (fromIdx < 0) return;
    const clamped = Math.max(0, Math.min(toIdx, list.length));
    if (fromIdx === clamped || fromIdx === clamped - 1) return;
    const [moved] = list.splice(fromIdx, 1);
    // Adjust insertion index when the source was before the target.
    const insertAt = clamped > fromIdx ? clamped - 1 : clamped;
    list.splice(insertAt, 0, moved);
    await this.persistList(list);
  }

  /**
   * Update an environment in place. If `meta.name` differs from `oldName`,
   * the secret is moved to the new keychain entry and the old one is deleted.
   */
  async updateEnvironment(
    oldName: string,
    meta: EnvironmentMeta,
    secret: EnvironmentSecret
  ): Promise<void> {
    const list = this.listEnvironments();
    const idx = list.findIndex((e) => e.name === oldName);
    if (idx < 0) throw new Error(`Environment "${oldName}" not found.`);
    if (oldName !== meta.name && list.some((e) => e.name === meta.name)) {
      throw new Error(`Environment "${meta.name}" already exists.`);
    }
    list[idx] = meta;
    await this.persistList(list);
    if (oldName !== meta.name) {
      await this.context.secrets.delete(SECRET_PREFIX + oldName);
    }
    await this.setSecret(meta.name, secret);
  }

  async getSecret(envName: string): Promise<EnvironmentSecret | undefined> {
    const raw = await this.context.secrets.get(SECRET_PREFIX + envName);
    if (!raw) return undefined;
    try {
      return JSON.parse(raw) as EnvironmentSecret;
    } catch {
      return undefined;
    }
  }

  async setSecret(envName: string, secret: EnvironmentSecret): Promise<void> {
    await this.context.secrets.store(SECRET_PREFIX + envName, JSON.stringify(secret));
  }

  private async persistList(list: EnvironmentMeta[]): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('paicLogSearch');
    // ConfigurationTarget: Workspace if a workspace is open, else Global.
    const target = vscode.workspace.workspaceFolders
      ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global;
    await cfg.update('environments', list, target);
  }
}
