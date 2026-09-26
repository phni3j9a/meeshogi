import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import type { ComparisonExport } from '../comparison/schema';

/**
 * Developer-only comparison export (Plan §5). Writes the validated document to
 * a deterministic cache path so acceptance scripts can retrieve it, logs that
 * path, then offers the OS share sheet — same pattern as the KIF export.
 */

/** Deterministic cache path for one game's comparison export. */
export function comparisonExportPath(gameId: string): string {
  return new File(Paths.cache, `meeshogi-comparison-${gameId}.json`).uri;
}

export async function shareComparisonExport(
  gameId: string,
  doc: ComparisonExport,
): Promise<string> {
  const file = new File(Paths.cache, `meeshogi-comparison-${gameId}.json`);
  if (file.exists) file.delete();
  file.write(JSON.stringify(doc, null, 2) + '\n');
  console.log(`[comparison-export] wrote ${file.uri}`);
  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(file.uri, {
      mimeType: 'application/json',
      dialogTitle: '解析比較レポートを書き出す',
    });
  }
  return file.uri;
}
