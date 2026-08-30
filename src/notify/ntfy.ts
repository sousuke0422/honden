/**
 * ntfy へ報せる（スマホ等）。
 *
 * # 旧をそのままは移せなんだ
 *
 * 旧 `scripts/ntfy.sh` は宛先を `https://ntfy.sh/$TOPIC` と**直に書いて**おった。
 * 自前で建てる者（YunoHost 等）には使えぬ——殿もそうなさる由。ゆえに
 * **宛先を設定へ出す**。既定は公開の ntfy.sh とし、書けば自前を向く。
 *
 * # 秘密は設定に書かぬ
 *
 * honden は公開しておる。合鍵を `settings.yaml` に置けば、いつか誰かが
 * そのまま押す。**環境変数から取る**——`NTFY_TOKEN`、または
 * `NTFY_USER` と `NTFY_PASS`。旧も `config/ntfy_auth.env` を別に持っており、
 * 分ける流儀は同じである。
 *
 * # 設定が無ければ名乗り出ぬ
 *
 * topic が無ければ送り口を作らぬ。**「配ったが届かなんだ」と「そもそも
 * 配っておらぬ」を混ぜぬ**ため——混ぜれば、繋いだつもりで黙っておる状態に
 * 気づけぬ。
 */
import type { Notice, Sink } from '../notify';

export const DEFAULT_BASE = 'https://ntfy.sh';

export interface Config {
  /** 宛先の根。自前なら `https://ntfy.example.org` の類 */
  base: string;
  topic: string;
  token?: string;
  user?: string;
  pass?: string;
}

/**
 * 設定と環境から組む。topic が無ければ `null`（＝送り口を作らぬ）。
 *
 * 設定の形:
 * ```yaml
 * notify:
 *   ntfy:
 *     base: https://ntfy.example.org   # 省けば https://ntfy.sh
 *     topic: 適度に長い推測しにくい名
 * ```
 */
export function config(doc: unknown, env: Record<string, string | undefined>): Config | null {
  const n = (doc as { notify?: { ntfy?: Record<string, unknown> } })?.notify?.ntfy;
  const topic = typeof n?.['topic'] === 'string' ? n['topic'].trim() : '';
  if (topic === '') return null;
  const base = typeof n?.['base'] === 'string' && n['base'].trim() !== '' ? n['base'].trim() : DEFAULT_BASE;
  return {
    base: base.replace(/\/+$/, ''),
    topic,
    token: env['NTFY_TOKEN']?.trim() || undefined,
    user: env['NTFY_USER']?.trim() || undefined,
    pass: env['NTFY_PASS']?.trim() || undefined,
  };
}

/**
 * 推測しやすい topic を戒める。
 *
 * ntfy の topic は**それ自体が合鍵**である（誰でも購読できる）。短い名や
 * ありふれた名は、他人に読まれ、他人に書かれる。旧環境も同じ検めを持って
 * おった（`lib/ntfy_auth.sh` の `ntfy_validate_topic`）。
 */
export const WEAK = new Set([
  'test', 'mytopic', 'notifications', 'alerts', 'messages', 'my-topic', 'default', 'ntfy', 'honden', 'shogun',
]);

export function topicWarning(topic: string): string | undefined {
  if (WEAK.has(topic.toLowerCase())) {
    return `topic「${topic}」はありふれておる。ntfy の topic は合鍵そのもの——他人に読まれ、書かれる`;
  }
  if (topic.length < 12) {
    return `topic が短い（${topic.length} 字）。12 字以上を勧める——topic は合鍵そのものゆえ`;
  }
  return undefined;
}

/**
 * 見出しを ntfy が読める形へ。
 *
 * HTTP の頭は ASCII しか通らぬ。**percent 符号化では化ける**——
 * `%E6%AE%BF%E3%81%B8` と生のまま端末に出る（公開の ntfy.sh へ撃って実測・
 * 2026-08-30）。正道は RFC 2047 の encoded-word で、これなら `殿へ` と出る。
 *
 * ASCII だけの見出しはそのまま通す——包めば読みにくくなるだけゆえ。
 */
export function encodeTitle(title: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7e]*$/.test(title)) return title;
  return `=?UTF-8?B?${Buffer.from(title, 'utf8').toString('base64')}?=`;
}

/**
 * 送る中身を組む。純関数ゆえ試験できる。
 *
 * **旧の画面に寄せる。** 旧 `ntfy.sh` は見出しを送らず本文だけを投げ、
 * 端末では会話のように並んでおった（`images/screenshots/masked/` の実物）。
 * 見出しを足せば一行増えて、その並びが崩れる。ゆえに既定では付けぬ
 * ——**見出しは本文の一行目に畳む**。
 *
 * 印は `outbound`。旧の受け手（`ntfy_listener.sh`）はこの印で
 * **自分の声を弾いておった**。名を変えれば、いつか輪ができる。
 */
export function request(c: Config, n: Notice): { url: string; init: RequestInit } {
  const headers: Record<string, string> = {
    'Content-Type': 'text/plain; charset=utf-8',
    Tags: 'outbound',
  };
  if (n.url) headers['Click'] = n.url;
  if (c.token) headers['Authorization'] = `Bearer ${c.token}`;
  else if (c.user && c.pass) {
    headers['Authorization'] = `Basic ${Buffer.from(`${c.user}:${c.pass}`).toString('base64')}`;
  }
  // 見出しは本文の一行目に畳む（旧の並びに寄せるため）。
  const body = n.title ? `${n.title}\n${n.body}` : n.body;
  return { url: `${c.base}/${c.topic}`, init: { method: 'POST', headers, body } };
}

/** 送る手。`notify/desktop.ts` と同じ流儀で注げるようにする。 */
export interface Runner {
  (args: string[]): { ok: boolean; code: string; detail?: string };
}

const realRun: Runner = (args) => {
  try {
    const p = Bun.spawnSync(args, { stdout: 'pipe', stderr: 'pipe' });
    return {
      ok: p.success,
      code: new TextDecoder().decode(p.stdout).trim(),
      detail: p.success ? undefined : new TextDecoder().decode(p.stderr).slice(0, 200),
    };
  } catch (e) {
    return { ok: false, code: '', detail: e instanceof Error ? e.message : String(e) };
  }
};

/** 要求を curl の引数へ畳む。何をどう投げるかが目で追える形にしておく。 */
export function curlArgs(c: Config, n: Notice): string[] {
  const { url, init } = request(c, n);
  const headers = Object.entries(init.headers as Record<string, string>).flatMap(([k, v]) => ['-H', `${k}: ${v}`]);
  return ['curl', '-sS', '-o', '/dev/null', '-w', '%{http_code}', '-X', 'POST', ...headers,
    '--data-binary', String(init.body ?? ''), url];
}

/**
 * 送り口。**届かねば落ちたと言う。**
 *
 * curl を使うのは、`Sink.send` が同期の口だからである。非同期を畳むより、
 * 一往復の投げに curl を借りる方が読みやすい——旧 `ntfy.sh` も同じ道であった。
 *
 * 2xx 以外は落第として扱う。curl は 404 でも 0 で終わるゆえ、
 * **終了コードだけを見れば「届いた」と誤る。**
 */
export function ntfySink(c: Config, run: Runner = realRun): Sink {
  return {
    name: 'ntfy',
    send: (n) => {
      const r = run(curlArgs(c, n));
      if (r.ok && /^2\d\d$/.test(r.code)) return { ok: true };
      return { ok: false, detail: r.detail ?? `HTTP ${r.code || '応答なし'}` };
    },
  };
}
