/**
 * 環境の設定を読む狭い口。
 *
 * ## なぜ狭くするか
 *
 * 現行では shell が YAML を直に読んでおる。`lib/cli_adapter.sh` の
 * python 呼び出し 17 箇所は、**すべて `config/settings.yaml` を読むため**である
 * （実測 2026-08-26）。そのために PyYAML だけを入れた venv が要る。
 *
 * honden は `Bun.YAML` を内に持つので、その venv は要らなくなる。
 * だが**汎用の YAML 読み口は開けない**。
 *
 *   honden yaml get <ファイル> <path>
 *
 * これを作ると、それが honden を迂回する道になる。誰かが
 * `queue/tasks/ashigaru1.yaml` を直に読み、`honden task` を通らなくなる。
 * 殿が閉じたかったのは、まさにその経路である。
 *
 * ## 設定の在り処は名簿を入れた時に覚える
 *
 * 引数でファイルを取らない。取れば汎用の読み口と同じになる。
 * `honden roster sync --settings <path>` が唯一の入口で、そこで覚える。
 *
 * ## 枝は返さない
 *
 * `cli.agents` のような枝を求められたら、値を並べて返すのではなく断る。
 * YAML や JSON を吐くと、受け取った shell がそれを解きにかかる——
 * **解く仕事を shell へ戻してしまう。** 何が下に在るかだけ示す。
 */

import type { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { getSetting } from './settings';

export const SETTINGS_PATH_KEY = 'settings_path';

export interface ConfigResult {
  ok: boolean;
  /** 見つかった値。scalar のみ。 */
  value?: string;
  message?: string;
}

export function settingsPath(db: Database): string | null {
  return getSetting(db, SETTINGS_PATH_KEY);
}

/** 覚えた設定を読む。 */
export function load(db: Database): { ok: true; doc: unknown; path: string } | { ok: false; message: string } {
  const p = settingsPath(db);
  if (!p) {
    return {
      ok: false,
      message:
        '設定の在り処を覚えておらぬ。\n' +
        '  honden roster sync --settings <settings.yaml> で入れられよ。\n' +
        '  そこが唯一の入口である——ここでファイルを取ると、汎用の YAML 読み口になり、\n' +
        '  honden を迂回する道が開く。',
    };
  }
  try {
    return { ok: true, doc: Bun.YAML.parse(readFileSync(p, 'utf8')), path: p };
  } catch (e) {
    return { ok: false, message: `${p} を読めぬ: ${String(e).slice(0, 160)}` };
  }
}

/** `cli.agents.karo.model` のような道を辿る。数字は一覧の添字。 */
export function dig(doc: unknown, dotted: string): { kind: 'scalar'; value: string } | { kind: 'branch'; keys: string[] } | { kind: 'none'; at: string } {
  const parts = dotted.split('.').filter((s) => s !== '');
  let cur: unknown = doc;
  const walked: string[] = [];
  for (const p of parts) {
    walked.push(p);
    if (Array.isArray(cur)) {
      const i = Number(p);
      if (!Number.isInteger(i) || i < 0 || i >= cur.length) return { kind: 'none', at: walked.join('.') };
      cur = cur[i];
      continue;
    }
    if (cur === null || typeof cur !== 'object') return { kind: 'none', at: walked.join('.') };
    if (!(p in (cur as Record<string, unknown>))) return { kind: 'none', at: walked.join('.') };
    cur = (cur as Record<string, unknown>)[p];
  }
  if (cur === null) return { kind: 'scalar', value: '' };
  if (Array.isArray(cur)) return { kind: 'branch', keys: cur.map((_, i) => String(i)) };
  if (typeof cur === 'object') return { kind: 'branch', keys: Object.keys(cur as Record<string, unknown>) };
  return { kind: 'scalar', value: String(cur) };
}

/**
 * 一つ引く。
 *
 * 値は**そのまま**返す。shell が `$(...)` で受けるゆえ、飾りを付けない。
 */
export function get(db: Database, key: string): ConfigResult {
  if (key.trim() === '') {
    return { ok: false, message: '鍵を渡されよ。例: honden config get cli.agents.karo.model' };
  }
  const doc = load(db);
  if (!doc.ok) return { ok: false, message: doc.message };

  const found = dig(doc.doc, key);
  if (found.kind === 'none') {
    return { ok: false, message: `${key} は無い（${found.at} で途切れた）。\n  honden config で何が在るか見られよ。` };
  }
  if (found.kind === 'branch') {
    return {
      ok: false,
      message:
        `${key} はまだ枝である。値ではない。\n` +
        `  下に在るもの: ${found.keys.slice(0, 12).join(' / ')}${found.keys.length > 12 ? ' …' : ''}\n` +
        '  枝を返すと、受け取った側がそれを解きにかかる。解く仕事を戻さぬため、値だけを返す。',
    };
  }
  return { ok: true, value: found.value };
}
