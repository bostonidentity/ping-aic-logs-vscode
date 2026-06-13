import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import { LogSearchPanel } from './panel';
import { EnvironmentTreeProvider, EnvironmentItem } from './treeView';
import { RecentSearchesProvider } from './recentSearchesView';
import { TailFilesProvider, TailFileItem, deleteTailFile, clearAllTailFiles, listTailFiles } from './tailFilesView';
import { ConfigStore } from './config';
import { HistoryStore } from './history';
import { EnvEditorPanel } from './envEditor';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const configStore = new ConfigStore(context);
  const historyStore = new HistoryStore(context);
  // Load (and on first run, migrate from old globalState) before any view
  // provider tries to call list(). Cheap when file already exists.
  await historyStore.ensureLoaded();

  // ── Sidebar trees ──
  // Environments — uses createTreeView so we can attach the DnD controller
  // (registerTreeDataProvider has no DnD hook).
  const envProvider = new EnvironmentTreeProvider(configStore);
  const envTreeView = vscode.window.createTreeView('paicLogSearch.environments', {
    treeDataProvider: envProvider,
    dragAndDropController: envProvider
  });
  context.subscriptions.push(envTreeView);

  const recentSearchesProvider = new RecentSearchesProvider(historyStore);
  const recentTreeView = vscode.window.createTreeView('paicLogSearch.recentSearches', {
    treeDataProvider: recentSearchesProvider
  });
  context.subscriptions.push(recentTreeView);

  const tailFilesProvider = new TailFilesProvider(context);
  const tailTreeView = vscode.window.createTreeView('paicLogSearch.tailFiles', {
    treeDataProvider: tailFilesProvider
  });
  context.subscriptions.push(tailTreeView);

  // Auto-refresh sidebar lists when their section becomes visible — fresh
  // every time you open the section without polling in the background.
  recentTreeView.onDidChangeVisibility((e) => { if (e.visible) recentSearchesProvider.refresh(); });
  tailTreeView.onDidChangeVisibility((e) => { if (e.visible) tailFilesProvider.refresh(); });

  // Live update: history mutations (add / delete / clear) push to the sidebar
  // without waiting for the user to collapse-and-reopen the section.
  function updateRecentDescription(): void {
    const n = historyStore.list().length;
    recentTreeView.description = n === 0 ? undefined : `${n}`;
  }
  updateRecentDescription();
  context.subscriptions.push(historyStore.onDidChange(() => {
    recentSearchesProvider.refresh();
    updateRecentDescription();
  }));

  const treeProvider = envProvider; // keep backward-compatible name below

  // Open Search Panel
  context.subscriptions.push(
    vscode.commands.registerCommand('paicLogSearch.openPanel', (envName?: string) => {
      LogSearchPanel.create(context, configStore, historyStore, envName);
    })
  );

  // Duplicate the currently-active PAIC search panel (tab right-click → Duplicate).
  context.subscriptions.push(
    vscode.commands.registerCommand('paicLogSearch.duplicateActivePanel', () => {
      for (const p of LogSearchPanel.allInstances()) {
        if (p.isActive) { p.postMessage({ type: 'triggerDuplicate' }); return; }
      }
      vscode.window.showWarningMessage('No active PAIC log panel to duplicate.');
    })
  );

  // Open a saved tail file in a new panel (called by Saved Tail Files tree)
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'paicLogSearch.openTailFile',
      (name: string, env?: string) => {
        LogSearchPanel.create(context, configStore, historyStore, env, name);
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'paicLogSearch.revealTailFile',
      async (item?: TailFileItem) => {
        if (!item) return;
        const fileUri = vscode.Uri.joinPath(context.globalStorageUri, 'tails', item.meta.name);
        await vscode.commands.executeCommand('revealFileInOS', fileUri);
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'paicLogSearch.deleteTailFile',
      async (item?: TailFileItem) => {
        if (!item) return;
        const confirm = await vscode.window.showWarningMessage(
          `Delete saved tail "${item.meta.name}"?`,
          { modal: true },
          'Delete'
        );
        if (confirm !== 'Delete') return;
        await deleteTailFile(context, item.meta.name);
        tailFilesProvider.refresh();
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'paicLogSearch.clearAllTailFiles',
      async () => {
        const count = (await listTailFiles(context)).length;
        if (count === 0) {
          vscode.window.showInformationMessage('No saved tail files to clear.');
          return;
        }
        const confirm = await vscode.window.showWarningMessage(
          `Delete all ${count} saved tail file${count === 1 ? '' : 's'}? This cannot be undone.`,
          { modal: true },
          'Delete All'
        );
        if (confirm !== 'Delete All') return;
        await clearAllTailFiles(context);
        tailFilesProvider.refresh();
      }
    )
  );

  // Open a panel pre-filled from a HistoryEntry (called by Recent Searches tree)
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'paicLogSearch.openPanelFromHistory',
      (entry: import('./types').HistoryEntry) => {
        if (!entry || !entry.env) return;
        LogSearchPanel.create(context, configStore, historyStore, entry.env, undefined, entry);
      }
    )
  );

  // Recent Searches inline buttons: Run / Run in New Tab / Delete
  // "Run" targets the currently active PAIC panel only — never creates a new
  // tab. Webview's restoreSearch handler will switch env on the panel as
  // needed, matching panel-internal history menu behavior.
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'paicLogSearch.runHistory',
      (item: { entry: import('./types').HistoryEntry }) => {
        const entry = item && item.entry;
        if (!entry) return;
        const panels = Array.from(LogSearchPanel.allInstances());
        const active = panels.find((p) => p.isActive);
        // Fall back to the most recently created panel if none is currently
        // focused (e.g., user just clicked the sidebar without first opening
        // a search tab in this session).
        const target = active ?? panels[panels.length - 1];
        if (!target) {
          vscode.window.showInformationMessage(
            'No PAIC Log Search panel is open. Use "Run in New Tab" instead, or open a panel from the Environments sidebar.'
          );
          return;
        }
        target.reveal();
        target.postMessage({ type: 'restoreSearch', payload: entry });
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'paicLogSearch.runHistoryNewTab',
      (item: { entry: import('./types').HistoryEntry }) => {
        const entry = item && item.entry;
        if (!entry || !entry.env) return;
        LogSearchPanel.create(context, configStore, historyStore, entry.env, undefined, entry);
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'paicLogSearch.deleteHistoryEntry',
      async (item: { entry: import('./types').HistoryEntry }) => {
        const entry = item && item.entry;
        if (!entry) return;
        const list = historyStore.list();
        const idx = list.findIndex((e) =>
          e.timestamp === entry.timestamp
          && e.env === entry.env
          && e.source === entry.source
          && e.query === entry.query
          && e.begin === entry.begin
          && e.end === entry.end
        );
        if (idx < 0) return;
        const queryLabel = entry.query || '(no keyword)';
        const trimmed = queryLabel.length > 60 ? queryLabel.slice(0, 59) + '…' : queryLabel;
        const confirm = await vscode.window.showWarningMessage(
          `Delete this search history entry?\n\n${entry.env} · ${entry.source}\n"${trimmed}"`,
          { modal: true },
          'Delete'
        );
        if (confirm !== 'Delete') return;
        await historyStore.deleteAt(idx);
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('paicLogSearch.clearAllHistory', async () => {
      const count = historyStore.list().length;
      if (count === 0) {
        vscode.window.showInformationMessage('Search history is already empty.');
        return;
      }
      const confirm = await vscode.window.showWarningMessage(
        `Clear all ${count} search history entries? This cannot be undone.`,
        { modal: true },
        'Clear All'
      );
      if (confirm !== 'Clear All') return;
      await historyStore.clear();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('paicLogSearch.clearZeroResultHistory', async () => {
      const zeroCount = historyStore.list().filter((e) => (e.totalCount ?? 0) === 0).length;
      if (zeroCount === 0) {
        vscode.window.showInformationMessage('No zero-result searches to clear.');
        return;
      }
      const confirm = await vscode.window.showWarningMessage(
        `Remove ${zeroCount} zero-result search${zeroCount === 1 ? '' : 'es'} from history?`,
        { modal: true },
        'Remove'
      );
      if (confirm !== 'Remove') return;
      await historyStore.clearZeroCount();
    })
  );

  // Refresh both list-style sidebar views on demand (toolbar refresh button)
  context.subscriptions.push(
    vscode.commands.registerCommand('paicLogSearch.refreshSidebar', () => {
      recentSearchesProvider.refresh();
      tailFilesProvider.refresh();
    })
  );

  // Add Environment
  context.subscriptions.push(
    vscode.commands.registerCommand('paicLogSearch.addEnvironment', async () => {
      const result = await EnvEditorPanel.show(context, 'add');
      if (!result) return;
      try {
        await configStore.addEnvironment(
          { name: result.name, url: result.url },
          { key: result.key, secret: result.secret }
        );
      } catch (err) {
        vscode.window.showErrorMessage(`Add failed: ${(err as Error).message}`);
        return;
      }
      treeProvider.refresh();
      vscode.window.showInformationMessage(`Added environment: ${result.name}`);
    })
  );

  // Edit Environment
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'paicLogSearch.editEnvironment',
      async (item: EnvironmentItem) => {
        const oldName = item.label as string;
        const existing = configStore.listEnvironments().find((e) => e.name === oldName);
        if (!existing) {
          vscode.window.showErrorMessage(`Environment "${oldName}" not found.`);
          return;
        }
        const existingSecret = await configStore.getSecret(oldName);
        if (!existingSecret) {
          vscode.window.showErrorMessage(
            `Stored secret missing for "${oldName}". Delete and re-add.`
          );
          return;
        }

        const result = await EnvEditorPanel.show(context, 'edit', {
          name: existing.name,
          url: existing.url
        });
        if (!result) return;

        // "Leave blank to keep" semantics: empty submission preserves the
        // existing keychain value rather than overwriting with empty.
        const merged = {
          key: result.key === '' ? existingSecret.key : result.key,
          secret: result.secret === '' ? existingSecret.secret : result.secret
        };

        try {
          await configStore.updateEnvironment(
            oldName,
            { name: result.name, url: result.url },
            merged
          );
        } catch (err) {
          vscode.window.showErrorMessage(`Update failed: ${(err as Error).message}`);
          return;
        }
        treeProvider.refresh();
        vscode.window.showInformationMessage(`Updated environment: ${result.name}`);
      }
    )
  );

  // Delete Environment
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'paicLogSearch.deleteEnvironment',
      async (item: EnvironmentItem) => {
        const confirm = await vscode.window.showWarningMessage(
          `Delete environment "${item.label}"?`,
          { modal: true },
          'Delete'
        );
        if (confirm !== 'Delete') return;
        await configStore.deleteEnvironment(item.label as string);
        treeProvider.refresh();
      }
    )
  );

  // Import Environments from JSON — recovers env list from a backup or
  // migrates from another tool. Accepts two shapes:
  //   1. Our own format:  [{name, url, key, secret}, ...]
  //   2. Flat-dict format: { ENV_NAME: {url, key, secret}, ... }  (matches
  //      the upstream Python tool's log-search-config.json so users can
  //      bring their existing config over).
  // Sensitive: contains plaintext credentials → only the user picks the
  // file. Confirm before overwriting existing env entries.
  context.subscriptions.push(
    vscode.commands.registerCommand('paicLogSearch.importEnvironments', async () => {
      const picked = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        filters: { 'JSON': ['json'] },
        title: 'Import Environments from JSON',
        openLabel: 'Import'
      });
      if (!picked || picked.length === 0) return;

      let raw: string;
      try { raw = await fs.readFile(picked[0].fsPath, 'utf8'); }
      catch (e) {
        vscode.window.showErrorMessage(`Read failed: ${(e as Error).message}`);
        return;
      }

      let parsed: unknown;
      try { parsed = JSON.parse(raw); }
      catch (e) {
        vscode.window.showErrorMessage(`Not valid JSON: ${(e as Error).message}`);
        return;
      }

      type ImportEnv = { name: string; url: string; key?: string; secret?: string };
      const envs: ImportEnv[] = [];
      const looksLikeEnv = (o: Record<string, unknown>): boolean =>
        typeof o.url === 'string' && /^https?:\/\//.test(o.url);

      if (Array.isArray(parsed)) {
        for (const e of parsed) {
          if (e && typeof e === 'object'
              && typeof (e as Record<string, unknown>).name === 'string'
              && looksLikeEnv(e as Record<string, unknown>)) {
            const ee = e as Record<string, unknown>;
            envs.push({ name: ee.name as string, url: ee.url as string, key: ee.key as string | undefined, secret: ee.secret as string | undefined });
          }
        }
      } else if (parsed && typeof parsed === 'object') {
        // Flat-dict: top-level keys are env names; skip metadata keys (`_*`).
        for (const [name, info] of Object.entries(parsed)) {
          if (name.startsWith('_')) continue;
          if (info && typeof info === 'object' && looksLikeEnv(info as Record<string, unknown>)) {
            const ii = info as Record<string, unknown>;
            envs.push({ name, url: ii.url as string, key: ii.key as string | undefined, secret: ii.secret as string | undefined });
          }
        }
      }

      if (envs.length === 0) {
        vscode.window.showWarningMessage('No environments found in this file.');
        return;
      }

      const existing = new Set(configStore.listEnvironments().map((e) => e.name));
      const overlap = envs.filter((e) => existing.has(e.name));
      const lines = envs.map((e) => `• ${e.name}  ${e.url}`).join('\n');
      const confirmMsg =
        `Import ${envs.length} environment${envs.length === 1 ? '' : 's'}?\n\n${lines}` +
        (overlap.length ? `\n\n${overlap.length} already exist and will be OVERWRITTEN.` : '');
      const ok = await vscode.window.showWarningMessage(
        confirmMsg, { modal: true }, 'Import'
      );
      if (ok !== 'Import') return;

      let imported = 0; let skipped = 0;
      for (const env of envs) {
        try {
          const meta = { name: env.name, url: env.url };
          const secret = { key: env.key || '', secret: env.secret || '' };
          if (existing.has(env.name)) {
            await configStore.updateEnvironment(env.name, meta, secret);
          } else {
            await configStore.addEnvironment(meta, secret);
          }
          imported++;
        } catch (e) {
          skipped++;
          console.warn(`[ping-aic-logs] import ${env.name} failed:`, e);
        }
      }
      treeProvider.refresh();
      const msg = `Imported ${imported} environment${imported === 1 ? '' : 's'}` +
        (skipped ? `; ${skipped} skipped (errors logged to console)` : '');
      vscode.window.showInformationMessage(msg);
    })
  );

  // Reveal Saved Tail Files Folder
  context.subscriptions.push(
    vscode.commands.registerCommand('paicLogSearch.revealTailsFolder', async () => {
      const dirUri = vscode.Uri.joinPath(context.globalStorageUri, 'tails');
      try {
        await fs.mkdir(dirUri.fsPath, { recursive: true });
      } catch (err) {
        vscode.window.showErrorMessage(
          `Could not create tails folder: ${(err as Error).message}`
        );
        return;
      }
      await vscode.commands.executeCommand('revealFileInOS', dirUri);
    })
  );

  // Reset UI Preferences (clears webview localStorage in all open panels)
  context.subscriptions.push(
    vscode.commands.registerCommand('paicLogSearch.resetUiPreferences', async () => {
      const confirm = await vscode.window.showWarningMessage(
        'Reset PAIC Log Search UI preferences? This clears toggles, column widths, and ETA samples in every open panel. Search history and saved tails are not affected.',
        { modal: true },
        'Reset'
      );
      if (confirm !== 'Reset') return;
      const panels = LogSearchPanel.allInstances();
      if (!panels.size) {
        vscode.window.showInformationMessage(
          'No open PAIC Log Search panels. Open a panel and run this command again.'
        );
        return;
      }
      for (const p of panels) {
        try {
          await p.postMessage({ type: 'resetPreferences' });
        } catch {
          /* ignore disposed panels */
        }
      }
      vscode.window.showInformationMessage(
        `Reset preferences in ${panels.size} panel${panels.size === 1 ? '' : 's'}.`
      );
    })
  );
}

export function deactivate(): void {
  // VS Code automatically disposes registered subscriptions.
}
