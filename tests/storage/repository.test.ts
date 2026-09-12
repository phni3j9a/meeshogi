import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalRepository, type Database } from '../../src/storage/repository';
import { DEFAULT_SETTINGS, type GameRecord } from '../../src/domain/model';
import { parseKif } from '../../src/domain';
import { readFileSync } from 'node:fs';
function database(path: string) {
  const db = new DatabaseSync(path);
  const adapter: Database = {
    execAsync: async (sql) => {
      db.exec(sql);
    },
    runAsync: async (sql, ...args) => db.prepare(sql).run(...args),
    getAllAsync: async <T>(sql: string, ...args: (string | number | null)[]) =>
      db.prepare(sql).all(...args) as T[],
  };
  return { db, repository: new LocalRepository(adapter) };
}
function sample(): GameRecord {
  return {
    ...parseKif(readFileSync('fixtures/kif/shogiwars.kif', 'utf8')),
    id: 'test-game',
    createdAt: '2026-09-12',
    favorite: true,
    lastViewedPly: 25,
    mySide: 'white',
    attribution: 'manual',
    analysis: {},
  };
}
describe('端末保存', () => {
  it('棋譜・設定・手動帰属をSQLiteに保存してDB再起動後に保持する', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'meeshogi-db-'));
    try {
      const path = join(dir, 'data.db');
      const first = database(path);
      await first.repository.initialize();
      const game = sample();
      await first.repository.insert(game);
      const settings = {
        ...DEFAULT_SETTINGS,
        playerNames: { shogiwars: ['a'], kiou: [], unknown: [] },
      };
      await first.repository.saveSettings(settings, []);
      first.db.close();
      const second = database(path);
      await second.repository.initialize();
      expect(await second.repository.load()).toEqual({ games: [game], settings });
      await expect(second.repository.insert({ ...game, id: 'different-id' })).rejects.toThrow(
        /UNIQUE/,
      );
      expect((await second.repository.load()).games).toHaveLength(1);
      await second.repository.delete(game.id);
      expect((await second.repository.load()).games).toHaveLength(0);
      second.db.close();
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
  it('設定と既存対局の帰属更新を同じtransactionでrollbackする', async () => {
    const { db, repository } = database(':memory:');
    await repository.initialize();
    const game = sample();
    await repository.insert(game);
    await repository.saveSettings(DEFAULT_SETTINGS, []);
    db.exec(
      "CREATE TRIGGER reject_game BEFORE UPDATE ON games BEGIN SELECT RAISE(ABORT, 'disk failure'); END;",
    );
    await expect(
      repository.saveSettings({ ...DEFAULT_SETTINGS, theme: 'dark' }, [
        { ...game, mySide: 'black' },
      ]),
    ).rejects.toThrow('disk failure');
    expect(await repository.load()).toEqual({ games: [game], settings: DEFAULT_SETTINGS });
    db.close();
  });
  it('破損した棋譜を黙って空データで置き換えない', async () => {
    const { db, repository } = database(':memory:');
    await repository.initialize();
    db.prepare('INSERT INTO games VALUES (?, ?, ?)').run('broken', 'x', '{"moves":[]}');
    await expect(repository.load()).rejects.toThrow('保持');
    expect(db.prepare('SELECT count(*) as n FROM games').get()?.n).toBe(1);
    db.close();
  });
  it('将来版DBを変更しない', async () => {
    const { db, repository } = database(':memory:');
    db.exec('PRAGMA user_version = 99');
    await expect(repository.initialize()).rejects.toThrow('更新');
    expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(99);
    db.close();
  });
  it.each([
    { result: 'corrupted-result' },
    { openings: [] },
    { positions: [null], moves: [] },
    { analysis: [] },
    { analysis: { 999: {} } },
    { favorite: 'false' },
    { lastViewedPly: -1 },
  ])('ネストした破損値を戦績や局面として受理しない: %j', async (patch) => {
    const { db, repository } = database(':memory:');
    await repository.initialize();
    const game = sample();
    const payload = JSON.stringify({ ...game, ...patch });
    db.prepare('INSERT INTO games VALUES (?, ?, ?)').run(game.id, game.identity, payload);
    await expect(repository.load()).rejects.toThrow('保持');
    expect(db.prepare('SELECT payload FROM games').get()?.payload).toBe(payload);
    db.close();
  });
  it('設定のboolean破損を有効化と解釈しない', async () => {
    const { db, repository } = database(':memory:');
    await repository.initialize();
    const payload = JSON.stringify({ ...DEFAULT_SETTINGS, autoAnalyze: 'false' });
    db.prepare('INSERT INTO settings VALUES (1, ?)').run(payload);
    await expect(repository.load()).rejects.toThrow('保持');
    expect(db.prepare('SELECT payload FROM settings').get()?.payload).toBe(payload);
    db.close();
  });
});
