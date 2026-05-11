import * as vscode from 'vscode';
import { findKeyReferences, isSupportedDocument, KeyReference } from './keyDetector';

/** All key references in the workspace, grouped by document URI. */
export interface WorkspaceUsageIndex {
  /** key → [{ uri, range }] */
  byKey: Map<string, Array<{ uri: vscode.Uri; ref: KeyReference }>>;
  /** total source files scanned */
  filesScanned: number;
}

const SCAN_GLOB = '**/*.{ts,tsx,js,jsx,vue,svelte,html,htm,mts,cts,mjs,cjs}';
const EXCLUDE_GLOB = '**/{node_modules,out,dist,build,.next,.nuxt,coverage,.git}/**';

/**
 * Scan the workspace for translation-key references. Honors VS Code's
 * `files.exclude` and `search.exclude`, plus our own bundled exclude list.
 *
 * Returns an index suitable for "find unused", "rename across workspace",
 * and "show usages" features.
 */
export async function buildUsageIndex(
  token?: vscode.CancellationToken,
  progress?: vscode.Progress<{ message?: string; increment?: number }>,
): Promise<WorkspaceUsageIndex> {
  const uris = await vscode.workspace.findFiles(SCAN_GLOB, EXCLUDE_GLOB, 5000, token);
  const byKey = new Map<string, Array<{ uri: vscode.Uri; ref: KeyReference }>>();
  const total = Math.max(uris.length, 1);
  const step = 100 / total;

  let scanned = 0;
  for (const uri of uris) {
    if (token?.isCancellationRequested) break;
    try {
      // openTextDocument is cheap (cached) and respects existing dirty buffers.
      const doc = await vscode.workspace.openTextDocument(uri);
      if (!isSupportedDocument(doc)) {
        progress?.report({ increment: step });
        continue;
      }
      const refs = findKeyReferences(doc);
      for (const ref of refs) {
        const list = byKey.get(ref.key) ?? [];
        list.push({ uri, ref });
        byKey.set(ref.key, list);
      }
      scanned++;
    } catch {
      // ignore unreadable files
    }
    progress?.report({ increment: step });
  }
  return { byKey, filesScanned: scanned };
}
