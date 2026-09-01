/**
 * `honden roster set` の通し。対話は台本で注ぎ替える。
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runRosterSet, runRosterSync, type RosterIo } from '../src/main';
import { openStore } from '../src/store';
import { roster } from '../src/roster';
import { EXIT_OK, EXIT_INVALID } from '../src/cli';

const SRC = `cli:
  agents:
    shogun:
      type: claude
      model: claude-opus-5
    karo:
      type: cursor
      model: auto   # 家老は Cursor
    ashigaru1:
      type: claude
      model: claude-fable-5
    # gunshi MUST stay last
    gunshi:
      type: claude
      model: claude-sonnet-5
`;

function env() {
  const dir = mkdtempSync(join(tmpdir(), 'honden-rset-'));
  const settings = join(dir, 'settings.yaml');
  const db = join(dir, 'h.db');
  writeFileSync(settings, SRC);
  const r = runRosterSync(db, settings);
  if (r.code !== EXIT_OK) throw new Error(r.err);
  return { db, settings };
}

/** 台本どおりに答える手。尽きたら null（閉じた扱い）——空回りさせぬ。 */
function scripted(answers: string[], tty = true): RosterIo & { said: string[] } {
  const q = [...answers];
  const said: string[] = [];
  return { isTTY: tty, said, say: (l) => said.push(l), ask: () => q.shift() ?? null };
}

describe('旗で', () => {
  test('CLI と模型を対で差し替え、書き、名簿へ写す', () => {
    const { db, settings } = env();
    const r = runRosterSet(db, { karo: 'claude:claude-sonnet-5', yes: 'true' }, scripted([]));
    expect(r.code).toBe(EXIT_OK);
    expect(readFileSync(settings, 'utf8')).toContain('# gunshi MUST stay last');
    expect(roster(openStore({ path: db })).find((x) => x.id === 'karo')).toMatchObject({ cli: 'claude', model: 'claude-sonnet-5' });
    expect(r.out).toContain('次の出陣から');
  });

  test('**CLI だけ差して模型を残す形は拒む**', () => {
    const { db } = env();
    const r = runRosterSet(db, { karo: 'claude', yes: 'true' }, scripted([]));
    expect(r.code).toBe(EXIT_INVALID);
    expect(r.err).toContain('対で');
  });

  test('同じ CLI なら模型は据え置ける', () => {
    const { db } = env();
    const r = runRosterSet(db, { karo: 'cursor', yes: 'true' }, scripted([]));
    expect(r.code).toBe(EXIT_OK);
    expect(r.out).toContain('変わる所が無い');
  });

  test('下見は書かぬ', () => {
    const { db, settings } = env();
    const r = runRosterSet(db, { karo: 'claude:claude-sonnet-5', 'dry-run': 'true' }, scripted([]));
    expect(r.code).toBe(EXIT_OK);
    expect(readFileSync(settings, 'utf8')).toBe(SRC);
  });

  test('端末でなく --yes も無ければ書かぬ', () => {
    const { db, settings } = env();
    const r = runRosterSet(db, { karo: 'claude:claude-sonnet-5' }, scripted([], false));
    expect(r.code).toBe(EXIT_INVALID);
    expect(readFileSync(settings, 'utf8')).toBe(SRC);
  });

  test('頭数を増やし、増えた分は旗で与える', () => {
    const { db } = env();
    const r = runRosterSet(db, { workers: '2', ashigaru2: 'codex:gpt-5.6-sol', yes: 'true' }, scripted([]));
    expect(r.code).toBe(EXIT_OK);
    expect(roster(openStore({ path: db })).map((x) => x.id)).toContain('ashigaru2');
  });
});

describe('訊いて', () => {
  test('空で送れば据え置き。答えた所だけ変わる', () => {
    const { db, settings } = env();
    // shogun 据え置き / karo → claude sonnet / gunshi 据え置き / 頭数 据え置き / ashigaru1 据え置き / 書くか y
    const io = scripted(['', '', 'claude', 'claude-sonnet-5', '', '', '', '', '', 'y']);
    const r = runRosterSet(db, {}, io);
    expect(r.code).toBe(EXIT_OK);
    const t = readFileSync(settings, 'utf8');
    expect(t).toContain('type: claude\n      model: claude-sonnet-5   # 家老は Cursor');
    expect(t).toContain('model: claude-opus-5');
  });

  test('途中で閉じれば何も書かぬ', () => {
    const { db, settings } = env();
    const r = runRosterSet(db, {}, scripted(['claude']));
    expect(r.code).toBe(EXIT_INVALID);
    expect(r.err).toContain('何も書いておらぬ');
    expect(readFileSync(settings, 'utf8')).toBe(SRC);
  });

  test('確かめで N なら書かぬ', () => {
    const { db, settings } = env();
    const io = scripted(['', '', 'claude', 'claude-sonnet-5', '', '', '', '', '', 'n']);
    const r = runRosterSet(db, {}, io);
    expect(r.code).toBe(EXIT_OK);
    expect(r.out).toContain('やめた');
    expect(readFileSync(settings, 'utf8')).toBe(SRC);
  });

  test('端末でなく旗も無ければ、旗の使い方を教えて終わる', () => {
    const { db } = env();
    const r = runRosterSet(db, {}, scripted([], false));
    expect(r.code).toBe(EXIT_INVALID);
    expect(r.err).toContain('--workers');
  });
});
