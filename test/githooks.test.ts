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
      expect(ok.status).toBe(0);
    });
    await withMsg('fix: x\n\nCo-authored-by: Cursor <cursoragent@cursor.com>\n', async (file) => {
      const bad = spawnSync(COMMIT_MSG, [file], { encoding: 'utf8' });
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
      expect(r.status).toBe(0);
      const after = await readFile(file, 'utf8');
      expect(after).not.toContain('cursoragent@cursor.com');
    });
  });
});
