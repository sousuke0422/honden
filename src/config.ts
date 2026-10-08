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
 * 足軽ごとの env で許す名。
 *
 * **名簿で許す。すべては許さぬ。** env の値は起こす命の字面に載り、tmux の pane・
 * shell の履歴・`ps` に残る。何でも許せば、API の鍵や token をここへ書く道が開く。
 * 秘密は env の欄ではなく、別の置き場（鍵の file）で渡すのが筋である。
 * ここに載せるのは、CLI の設定の在り処を足軽ごとに分ける名だけとする。
 * 名を足す時は、秘密を運ばぬ名かを判じて、この名簿へ足す（試験も足す）。
 */
export const AGENT_ENV_ALLOWED: readonly string[] = ['CODEX_HOME'];

const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;

/**
 * 名ごとの値の掟。名の判じと同じ所で、値も判ずる。外れれば理由と直し方を返す。
 *
 * **CODEX_HOME は `/` で始まる絶対の道に限る。** 値は単引用で命に載るゆえ、`~` も
 * `$HOME` も展開されぬ。`~/.codex-x` は codex の側では「今の dir の下の `~` という dir」
 * になり、selftest が `~` を展開して読めば、見張る先と codex が使う先が食い違う。
 * 相対の道も同じく、起こした dir 次第で先が変わる。
 *
 * **`..` は畳まずに止める。** 字面で畳むと、symlink を越える道で実の在り処とずれうる
 * （`/a/link/../b` の `..` は、shell では字面で、kernel では link の先で解かれる）。
 * 畳まずに受ける形を一つに絞れば、selftest が読む先と codex が開く先は必ず同じになる。
 */
const ENV_VALUE_RULES: Record<string, (v: string) => string | null> = {
  CODEX_HOME: (v) => {
    const fix = '$HOME を展開した絶対の道（例: /home/me/.codex-ashigaru3）で書かれよ';
    if (!v.startsWith('/')) {
      return `絶対の道（/ で始まる）で書かれよ: ${JSON.stringify(v)}。値は単引用で載るゆえ ~ も $HOME も展開されず、相対の道は起こした dir で先が変わる。${fix}`;
    }
    if (v.split('/').includes('..')) {
      return `.. を含む: ${JSON.stringify(v)}。畳むと symlink を越えて実の在り処とずれうるゆえ受けぬ。${fix}`;
    }
    return null;
  },
};

/** shell の単引用で包む。単引用そのものは `'\''` で抜ける。空白・`$`・`!` も崩れぬ。 */
export function shellQuote(v: string): string {
  return `'${v.replace(/'/g, `'\\''`)}'`;
}

/**
 * `cli.agents.<名>.env` を読む。無ければ空。名と値の組の写像であること。
 * 名は `[A-Z_][A-Z0-9_]*` で、AGENT_ENV_ALLOWED に載ること。値は文か数で、
 * 改行などの制御の字を含まぬこと（起こす命が一行で打たれるため）。
 */
export function agentEnv(doc: unknown, agent: string): { ok: true; env: [string, string][] } | { ok: false; message: string } {
  const found = dig(doc, `cli.agents.${agent}.env`);
  if (found.kind === 'none') return { ok: true, env: [] };
  if (found.kind === 'scalar') {
    if (found.value === '') return { ok: true, env: [] };
    return { ok: false, message: `cli.agents.${agent}.env は名と値の組（写像）で書かれよ。値が一つだけ在る。` };
  }
  const raw = (doc as Record<string, any>).cli.agents[agent].env;
  if (Array.isArray(raw)) {
    return { ok: false, message: `cli.agents.${agent}.env は名と値の組（写像）で書かれよ。一覧ではない。` };
  }
  const env: [string, string][] = [];
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!ENV_NAME.test(name)) {
      return { ok: false, message: `cli.agents.${agent}.env の名 ${JSON.stringify(name)} は [A-Z_][A-Z0-9_]* の形でない。` };
    }
    if (!AGENT_ENV_ALLOWED.includes(name)) {
      return {
        ok: false,
        message:
          `cli.agents.${agent}.env の名 ${name} は許しておらぬ（許す名: ${AGENT_ENV_ALLOWED.join(', ')}）。\n` +
          '  env の値は起こす命の字面に載り、pane や履歴に残る。秘密は鍵の file で渡されよ。',
      };
    }
    if (typeof value !== 'string' && typeof value !== 'number') {
      return { ok: false, message: `cli.agents.${agent}.env.${name} の値は文で書かれよ。` };
    }
    const v = String(value);
    if (/[\u0000-\u001f\u007f]/.test(v)) {
      return { ok: false, message: `cli.agents.${agent}.env.${name} の値に改行などの制御の字が在る。` };
    }
    const bad = ENV_VALUE_RULES[name]?.(v);
    if (bad) return { ok: false, message: `cli.agents.${agent}.env.${name} の値の誤り——${bad}` };
    env.push([name, v]);
  }
  return { ok: true, env };
}

/** 起こす命の頭に置く代入の並び（`CODEX_HOME='…' `の形）。env が無ければ空。 */
export function envPrefix(env: [string, string][]): string {
  return env.map(([n, v]) => `${n}=${shellQuote(v)}`).join(' ');
}

/** `honden config env <名>` の中身。設定を読み、検めて、前置きを返す。 */
export function envOf(db: Database, agent: string): ConfigResult {
  if (agent.trim() === '') return { ok: false, message: '誰の env か渡されよ。例: honden config env ashigaru3' };
  const doc = load(db);
  if (!doc.ok) return { ok: false, message: doc.message };
  const r = agentEnv(doc.doc, agent);
  if (!r.ok) return { ok: false, message: r.message };
  return { ok: true, value: envPrefix(r.env) };
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
