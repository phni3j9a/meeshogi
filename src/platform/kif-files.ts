import * as DocumentPicker from 'expo-document-picker';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import Encoding from 'encoding-japanese';
import type { GameRecord } from '../domain/model';

export async function pickKif(): Promise<string | null> {
  const result = await DocumentPicker.getDocumentAsync({
    type: '*/*',
    copyToCacheDirectory: true,
    multiple: false,
  });
  if (result.canceled) return null;
  const asset = result.assets[0];
  if (asset.size && asset.size > 2_000_000)
    throw new Error('棋譜ファイルが大きすぎます。2 MB以下のKIFを選んでください。');
  const file = new File(asset.uri);
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length > 2_000_000) throw new Error('棋譜ファイルが大きすぎます。');
  const detected = Encoding.detect(bytes);
  if (!detected)
    throw new Error('文字コードを判別できません。UTF-8またはShift_JISのKIFを選んでください。');
  return Encoding.convert(bytes, { from: detected, to: 'UNICODE', type: 'string' }).replace(
    /^\uFEFF/,
    '',
  );
}
export async function shareKif(game: GameRecord): Promise<void> {
  if (!(await Sharing.isAvailableAsync()))
    throw new Error('この端末ではファイル共有を利用できません。');
  const file = new File(Paths.cache, `meeshogi-${game.id}.kifu`);
  file.write(game.rawKif);
  await Sharing.shareAsync(file.uri, {
    mimeType: 'text/plain',
    UTI: 'public.plain-text',
    dialogTitle: '棋譜を書き出す',
  });
}
