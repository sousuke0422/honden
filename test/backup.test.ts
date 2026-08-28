/**
 * 写しの試験。要は三つ: 写る・刈れる・**写しが読める**。
 * 「写した」だけでは足りぬ——読めぬ写しは無いのと同じである。
 */
import { describe, expect, test } from 'bun:test';
import { backup, backupName, KEEP_DEFAULT } from '../src/backup';
import { openStore, tx } from '../src/store';
import { syncRoster } from '../src/roster';
import { Database } from 'bun:sqlite';
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const NOW = new Date('2026-08-29T12:00:00Z');

const seeded = (dir: string) => {
  const db = openStore({ path: join(dir, 'live.db') });
  tx(db, () => {
    syncRoster(db, [{ id: 'karo', role: 'commander', cli: 'cursor', model: null }]);
  });
  return db;
};

describe('写る', () => {
  test('写しが出来て、開けて、中身が居る', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bk-'));
    const db = seeded(dir);
    const r = backup(db, join(dir, 'backups'), NOW);
    expect(r.bytes).toBeGreaterThan(0);
    // **写しが読める**ことまで見る。焼けたが開かぬ写しは無いのと同じ。
    const copy = new Database(r.path, { readonly: true });
    const row = copy.query('SELECT id FROM roster').get() as { id: string };
    expect(row.id).toBe('karo');
  });

  test('名は時刻で並ぶ（時刻で刈れる）', () => {
    expect(backupName(NOW)).toBe('honden-2026-08-29T12-00-00.db');
  });
});

describe('刈れる', () => {
  test('世代を超えた古い写しは刈られ、新しいものが残る', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bk-'));
    const db = seeded(dir);
    const bdir = join(dir, 'backups');
    for (let i = 0; i < 4; i++) {
      backup(db, bdir, new Date(NOW.getTime() + i * 60_000), 2);
    }
    const left = readdirSync(bdir).sort();
    expect(left.length).toBe(2);
    // 残るのは**新しい方**である。古い方を残して新しい方を刈れば本末転倒。
    expect(left[1]).toContain('12-03-00');
  });

  test('写しでない file には触れぬ', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bk-'));
    const db = seeded(dir);
    const bdir = join(dir, 'backups');
    backup(db, bdir, NOW, 1);
    writeFileSync(join(bdir, 'notes.txt'), 'これは写しではない');
    backup(db, bdir, new Date(NOW.getTime() + 60_000), 1);
    expect(readdirSync(bdir)).toContain('notes.txt');
  });
});
