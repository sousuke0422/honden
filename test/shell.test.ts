/**
 * 貝（shell）の試験を bun の門へ繋ぐ橋。
 *
 * honden の shell は 1000 行を超える（出陣の書・CLI の付け替え・hook の皮）。
 * TypeScript は bun test が見ておったが、**貝は丸ごと無試験であった**。
 *
 * 門を二つにすると片方が忘れられる。`bun test` を叩けば貝も回る形にする。
 *
 * ## bats が無い時は**落ちる**。飛ばさぬ
 *
 * 道具が無いから飛ばす、は「新しい層は fail-open として生まれる」の型そのもの
 * ——見張りが黙って消え、誰も気づかぬ。落ちれば据え方が分かる。
 */
import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { requireBuilt } from './prereq';

const ROOT = join(import.meta.dir, '..');
const TESTS = join(ROOT, 'tests');

describe('貝の試験（bats）', () => {
  test('bats が据わっておる', () => {
    const p = Bun.spawnSync(['bats', '--version']);
    expect(
      p.success,
      'bats が無い。据えられよ: sudo apt install bats（または brew install bats-core）',
    ).toBe(true);
  });

  test('借り物の helper が繋がっておる', () => {
    for (const m of ['bats-support', 'bats-assert']) {
      expect(
        existsSync(join(TESTS, 'test_helper', m, 'load.bash')),
        `${m} が無い。繋がれよ: git submodule update --init --recursive`,
      ).toBe(true);
    }
  });

  // 走行は三つの前提が揃った時だけ登録する。欠けておれば上の二つの赤か
  // 【建てておらぬ】の赤が理由を語る——赤の雨で本物の赤を霞ませぬため。
  // 前提が在るのに飛ぶ筋は無い: 揃えば必ず登録され、bats の壊れは従来どおり赤くなる。
  const batsReady = Bun.spawnSync(['bats', '--version']).success;
  const helpersReady = ['bats-support', 'bats-assert'].every((m) =>
    existsSync(join(TESTS, 'test_helper', m, 'load.bash')),
  );
  const binReady = requireBuilt(ROOT, 'test/shell.test.ts——tests/*.bats が bin/honden を叩く', ['honden']);
  if (batsReady && helpersReady && binReady) test('tests/*.bats がすべて通る', () => {
    // 並べて回す。素だと 12 秒、四本並べて 2 秒——貝の試験は待ちが主ゆえ。
    const p = Bun.spawnSync(['bats', '-j', '4', '--tap', TESTS], { cwd: ROOT });
    const out = new TextDecoder().decode(p.stdout) + new TextDecoder().decode(p.stderr);
    // 落ちた時に中身が見えねば直せぬ。TAP をそのまま添える。
    expect(p.success, `bats が落ちた:\n${out}`).toBe(true);
    // 一本も無いのに「通った」と言わせぬ（空の見張りは見張りでない）。
    expect(out, `bats が一本も走っておらぬ:\n${out}`).toMatch(/^ok \d+/m);
  }, 120_000); // 別の process を幾つも起こすゆえ、既定の 5 秒では足りぬ
});
