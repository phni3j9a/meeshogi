import { type GameRecord, type Settings } from '../domain/model';
import { CloudRepository } from './cloud-repository';
import { decodeGame, decodeSettings } from './validation';

export interface Database {
  execAsync(sql: string): Promise<void>;
  runAsync(sql: string, ...params: (string | number | null)[]): Promise<unknown>;
  getAllAsync<T>(sql: string, ...params: (string | number | null)[]): Promise<T[]>;
}
export class LocalRepository {
  /** Cloud attempts/results share this Database so game deletion cascades. */
  readonly cloud: CloudRepository;
  constructor(private readonly db: Database) {
    this.cloud = new CloudRepository(db);
  }
  private validateForWrite(game: GameRecord) {
    // Keep invalid/incomplete current-identity analyses out of SQLite. Old
    // identities remain readable through decodeGame's migration-free path.
    decodeGame(game, game.id, game.identity);
  }
  async initialize() {
    const versions = await this.db.getAllAsync<{ user_version: number }>('PRAGMA user_version');
    if ((versions[0]?.user_version ?? 0) > 1)
      throw new Error('新しいバージョンで保存されたデータです。アプリを更新してください。');
    await this.db.execAsync(`PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS games (
        id TEXT PRIMARY KEY NOT NULL, identity TEXT NOT NULL UNIQUE, payload TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id = 1), payload TEXT NOT NULL);
      PRAGMA user_version = 1;`);
    await this.cloud.initialize();
  }
  async load(): Promise<{ games: GameRecord[]; settings: Settings }> {
    const games: GameRecord[] = [];
    try {
      // Release each batch of JSON strings before reading the next one. Keeping
      // every raw payload alongside every decoded game doubles load-time memory.
      const batchSize = 100;
      for (let offset = 0; ; offset += batchSize) {
        const rows = await this.db.getAllAsync<{
          id: string;
          identity: string;
          payload: string;
        }>(
          'SELECT id, identity, payload FROM games ORDER BY rowid LIMIT ? OFFSET ?',
          batchSize,
          offset,
        );
        for (const { id, identity, payload } of rows)
          games.push(decodeGame(JSON.parse(payload), id, identity));
        if (rows.length < batchSize) break;
      }
      const settingsRows = await this.db.getAllAsync<{ payload: string }>(
        'SELECT payload FROM settings WHERE id = 1',
      );
      const settings = decodeSettings(settingsRows[0] ? JSON.parse(settingsRows[0].payload) : {});
      return { games, settings };
    } catch {
      throw new Error('保存したデータを読み込めません。データは削除せず保持しています。');
    }
  }
  async insert(game: GameRecord) {
    this.validateForWrite(game);
    await this.db.runAsync(
      'INSERT INTO games (id, identity, payload) VALUES (?, ?, ?)',
      game.id,
      game.identity,
      JSON.stringify(game),
    );
  }
  async save(game: GameRecord) {
    this.validateForWrite(game);
    await this.db.runAsync(
      'UPDATE games SET payload = ? WHERE id = ?',
      JSON.stringify(game),
      game.id,
    );
  }
  async delete(id: string) {
    await this.db.runAsync('DELETE FROM games WHERE id = ?', id);
  }
  async saveSettings(settings: Settings, reattributed: GameRecord[]) {
    await this.db.execAsync('BEGIN IMMEDIATE');
    try {
      await this.db.runAsync(
        'INSERT INTO settings (id, payload) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload',
        JSON.stringify(settings),
      );
      for (const game of reattributed) await this.save(game);
      await this.db.execAsync('COMMIT');
    } catch (error) {
      await this.db.execAsync('ROLLBACK');
      throw error;
    }
  }
}
