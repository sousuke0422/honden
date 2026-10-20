import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCmd } from '../src/dispatch';
import { runCmdShow, runRosterSync, runRoute, runStatus } from '../src/main';
import { syncLimits } from '../src/routing';
import { syncRoster } from '../src/roster';
import { openStore, tx } from '../src/store';

const dirs: string[] = [];

function freshPath(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'honden-bloom-gap-'));
  dirs.push(dir);
  return { dir, path: join(dir, 'h.db') };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function seedUnknown(path: string): void {
  const db = openStore({ path });
  tx(db, () => {
    syncRoster(db, [
      { id: 'shogun', role: 'commander', cli: 'claude', model: 'claude-opus-5' },
      { id: 'karo', role: 'commander', cli: 'cursor', model: 'auto' },
      { id: 'gunshi', role: 'commander', cli: 'claude', model: 'claude-sonnet-5' },
      { id: 'ashigaru1', role: 'worker', cli: 'claude', model: 'new-model' },
    ]);
    syncLimits(db, [{ model: 'claude-opus-5', maxBloom: 6, costGroup: 'claude_max' }]);
  });
  db.close();
}

describe('Bloom の穴を表示する', () => {
  test('route は表に無い模型を上限不明と明記する', () => {
    const { path } = freshPath();
    seedUnknown(path);
    const result = runRoute(path, 'L3', 'worker', undefined, undefined);
    expect(result.code).toBe(0);
    expect(result.out).toContain('ashigaru1');
    expect(result.out).toContain('上限不明');
  });

  test('status は未知模型と、既知の足軽で覆えない難度を警告する', () => {
    const { path } = freshPath();
    seedUnknown(path);
    const result = runStatus(path, false);
    expect(result.code).toBe(0);
    expect(result.out).toContain('能力表に無い模型: ashigaru1=new-model');
    expect(result.out).toContain('L1, L2, L3, L4, L5, L6 を振れる足軽が居らぬ');
  });

  test('roster sync は同期直後の穴を警告する', () => {
    const { dir, path } = freshPath();
    const settings = join(dir, 'settings.yaml');
    writeFileSync(
      settings,
      `cli:\n  agents:\n    shogun:\n      type: claude\n      model: claude-opus-5\n    karo:\n      type: cursor\n      model: auto\n    gunshi:\n      type: claude\n      model: claude-sonnet-5\n    ashigaru1:\n      type: claude\n      model: new-model\ncapability_tiers:\n  claude-opus-5:\n    max_bloom: 6\n    cost_group: claude_max\n`,
    );
    const result = runRosterSync(path, settings);
    expect(result.code).toBe(0);
    expect(result.out).toContain('能力表に無い模型: ashigaru1=new-model');
    expect(result.out).toContain('L1, L2, L3, L4, L5, L6 を振れる足軽が居らぬ');
  });
});

describe('司令の任意 Bloom', () => {
  const command = {
    north_star: '差配を再現できるようにする',
    purpose: '難度の既定を正本に置く',
    acceptance_criteria: ['難度が見える'],
    command: '実装せよ',
    project: 'honden',
  };

  test('cmd show は Bloom が在る時だけ表示し、旧い司令も読める', () => {
    const { path } = freshPath();
    const db = openStore({ path });
    const withBloom = createCmd(db, 'shogun', { ...command, bloom: 5 }).id!;
    const legacy = createCmd(db, 'shogun', command).id!;
    db.close();
    expect(runCmdShow(path, withBloom).out).toContain('難度: L5');
    expect(runCmdShow(path, legacy).out).not.toContain('難度:');
  });

  test('cmd new は範囲外の Bloom を拒む', () => {
    const db = openStore({ path: ':memory:' });
    const result = createCmd(db, 'shogun', { ...command, bloom: 'L7' });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('L1 から L6');
  });
});
