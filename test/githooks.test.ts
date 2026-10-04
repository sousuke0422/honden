import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = join(import.meta.dir, '..');
const STRIP = join(ROOT, '.githooks/lib/strip-cursor-trailers.sh');
const PREPARE = join(ROOT, '.githooks/prepare-commit-msg');
const COMMIT_MSG = join(ROOT, '.githooks/commit-msg');

async function withMsg(body: string, fn: (path: string) => void | Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'honden-githooks-'));
  const file = join(dir, 'msg');
  await writeFile(file, body, 'utf8');
  try {
    await fn(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function runStrip(file: string) {
  const r = spawnSync('sh', ['-c', `. "${STRIP}" && strip_cursor_trailers "$1"`, 'sh', file], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  expect(r.status).toBe(0);
}

describe('githooks: Cursor Co-authored-by', () => {
  test('strip: Cursor 行だけ落ち、Assisted-by と他の共著は残る', async () => {
    const before = `feat: 試し

Assisted-by: multi-agent-shogun-aki-tweak

Co-authored-by: Cursor <cursoragent@cursor.com>
Co-authored-by: Alice <alice@example.com>
`;
    await withMsg(before, async (file) => {
      runStrip(file);
      const after = await readFile(file, 'utf8');
      expect(after).toContain('Assisted-by: multi-agent-shogun-aki-tweak');
      expect(after).toContain('Co-authored-by: Alice <alice@example.com>');
      expect(after).not.toContain('cursoragent@cursor.com');
    });
  });

  test('commit-msg: Cursor が残れば拒否、Assisted-by だけは通る', async () => {
    await withMsg('fix: x\n\nAssisted-by: multi-agent-shogun-aki-tweak\n', async (file) => {
      const ok = spawnSync(COMMIT_MSG, [file], { encoding: 'utf8' });
      expect(ok.error).toBeUndefined();
      expect(ok.status).toBe(0);
    });
    await withMsg('fix: x\n\nCo-authored-by: Cursor <cursoragent@cursor.com>\n', async (file) => {
      const bad = spawnSync(COMMIT_MSG, [file], { encoding: 'utf8' });
      expect(bad.error).toBeUndefined();
      expect(bad.status).toBe(1);
    });
  });

  test('prepare-commit-msg: 鎖なしでも strip する', async () => {
    const body = `chore: y

Co-authored-by: Cursor <cursoragent@cursor.com>
`;
    await withMsg(body, async (file) => {
      const r = spawnSync(PREPARE, [file, 'message'], {
        cwd: ROOT,
        env: { ...process.env, HONDEN_PREPARE_COMMIT_MSG_CHAIN: '/nonexistent' },
        encoding: 'utf8',
      });
      expect(r.error).toBeUndefined();
      expect(r.status).toBe(0);
      const after = await readFile(file, 'utf8');
      expect(after).not.toContain('cursoragent@cursor.com');
    });
  });
});

// 紋様は表示名でなく宛先の領域（@cursor.com）で留める。表示名は Cursor 本体に埋まった
// 文字列で、こちらは握っておらぬ（実打で `Cursor Agent <cursoragent@cursor.com>` が
// 旧い紋様を通り抜け、commit object に残った）。
const DROP = [
  'Co-authored-by: Cursor <cursoragent@cursor.com>',
  'Co-authored-by: Cursor Agent <cursoragent@cursor.com>',
  'Co-authored-by: cursor <agent@cursor.com>',
];
const KEEP = [
  'Co-authored-by: Alice <alice@example.com>',
  'Co-authored-by: Bob <bob@cursor.company.example>',
  'Assisted-by: multi-agent-shogun-aki-tweak',
  'Signed-off-by: Carol <carol@example.com>',
];

describe('githooks: 落とす紋様は宛先の領域で留める', () => {
  for (const line of DROP) {
    test(`strip: 落とす — ${line}`, async () => {
      await withMsg(`feat: 試し\n\n${line}\n`, async (file) => {
        runStrip(file);
        const after = await readFile(file, 'utf8');
        expect(after).not.toContain(line);
        expect(after).toContain('feat: 試し');
      });
    });

    test(`commit-msg: 拒む — ${line}`, async () => {
      await withMsg(`fix: x\n\n${line}\n`, async (file) => {
        const r = spawnSync(COMMIT_MSG, [file], { encoding: 'utf8' });
        expect(r.error).toBeUndefined();
        expect(r.status).toBe(1);
      });
    });
  }

  for (const line of KEEP) {
    test(`strip: 残す — ${line}`, async () => {
      await withMsg(`feat: 試し\n\n${line}\n`, async (file) => {
        runStrip(file);
        expect(await readFile(file, 'utf8')).toContain(line);
      });
    });

    test(`commit-msg: 通す（exit 0） — ${line}`, async () => {
      await withMsg(`fix: x\n\n${line}\n`, async (file) => {
        const r = spawnSync(COMMIT_MSG, [file], { encoding: 'utf8' });
        expect(r.error).toBeUndefined();
        expect(r.status).toBe(0);
      });
    });
  }

  // Co-authored-by を一律に拒む形へ広げても緑のまま通ってしまう穴を塞ぐ。
  test('commit-msg: 人の Co-authored-by は exit 0 で通る（一律に拒まぬ）', async () => {
    await withMsg('fix: x\n\nCo-authored-by: Alice <alice@example.com>\n', async (file) => {
      const r = spawnSync(COMMIT_MSG, [file], { encoding: 'utf8' });
      expect(r.error).toBeUndefined();
      expect(r.status).toBe(0);
    });
  });
});
