/**
 * 戦況をブラウザへ配る。旧 scripts/dashboard-viewer.py（python 323 行）の後継。
 *
 * 旧はファイル（dashboard.md）を読んで配り、mtime で更新を検知していた。
 * こちらは正本から組んで直に配る——中間生成物が消える（brief と同じ思想）。
 * 更新の検知は台帳の末尾で行う（正本が動けば台帳が伸びる）。
 *
 * 見た目（配色・字組み）は旧 viewer の HTML を踏襲する。殿の目が慣れた画面を
 * 変えぬ。markdown の描画も旧と同じ marked（CDN）——viewer はブラウザで
 * 開く道具ゆえ、オフライン要件は無い。
 */
import type { Database } from 'bun:sqlite';
import { mdToHtml } from './render';

/** 我らの口である印。見張りがよその listener と見分けるのに使う。 */
export const MARK = { 'X-Honden': 'dashboard' } as const;

/**
 * 頁の script。**CSP は hash で許す。**
 *
 * `default-src 'none'` のまま `script-src` を書いておらず、browser が
 * この script を黙って封じていた——poll() が一度も走らず、頁は
 * 「読み込み中…」のまま止まる（殿が実際に開いて発覚・2026-09-03）。
 * curl の検めは JS を走らせぬゆえ、試験も関所も釣れなんだ。
 *
 * 'unsafe-inline' で開けるのではなく、この文字列の hash だけを許す。
 * 文字列を変えれば hash は組み立てで追随する——手で写す番号を持たぬ。
 */
const SCRIPT = `
    // 頁は外へ繋がらぬ（CSP の default-src 'none'）。描画器も借りぬ。
    // ここへ入る HTML は honden が組み、差し込む文字は全て escape 済みである。
    let last = '';
    async function poll() {
      try {
        const v = await (await fetch('/api/version')).text();
        if (v !== last) {
          last = v;
          const html = await (await fetch('/api/html')).text();
          document.getElementById('app').innerHTML = html;
          document.getElementById('stamp').textContent = '取得: ' + new Date().toLocaleTimeString();
        }
      } catch (e) { /* 一時の失敗は次の周で拾う */ }
    }
    poll();
    setInterval(poll, 1500);
`;
const SCRIPT_HASH = new Bun.CryptoHasher('sha256').update(SCRIPT).digest('base64');

const PAGE = `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; style-src 'unsafe-inline'; connect-src 'self'; script-src 'sha256-${SCRIPT_HASH}'" />
  <title>Dashboard</title>
  <style>
    :root {
      --bg: #0d1117; --surface: #161b22; --border: #30363d;
      --text: #c9d1d9; --heading: #e6edf3; --accent: #58a6ff;
      --code-bg: #1c2128; --muted: #8b949e;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { background: var(--bg); color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
      font-size: 14px; line-height: 1.6; }
    #app { max-width: 860px; margin: 0 auto; padding: 24px; }
    h1, h2, h3 { color: var(--heading); margin: 1.2em 0 0.5em; }
    h1 { border-bottom: 1px solid var(--border); padding-bottom: 8px; }
    h2 { font-size: 1.15em; }
    table { border-collapse: collapse; margin: 8px 0; width: 100%; }
    th, td { border: 1px solid var(--border); padding: 6px 10px; text-align: left; }
    th { background: var(--surface); }
    ul { padding-left: 1.4em; }
    code { background: var(--code-bg); padding: 1px 5px; border-radius: 4px; }
    #stamp { color: var(--muted); font-size: 12px; margin-top: 24px; }
  </style>
</head>
<body>
  <div id="app">読み込み中…</div>
  <div id="stamp"></div>
  <script>${SCRIPT}</script>
</body>
</html>`;

/**
 * 叩き手が名乗った宛先を検める。**DNS rebinding 除け。**
 *
 * 錠も名乗りも無い口ゆえ、よその頁が「己の domain を 127.0.0.1 へ向け直して」
 * 我が家を叩ける。その時 Host は**そのよその名**になる——我が家の名で来た
 * ものだけ返せば、その道は塞がる。
 *
 * 外へ開いておる時（--host で明示した時）は、宛先が何になるか読めぬゆえ
 * 検めを緩める。**広げると決めた者が範囲を負う。**
 */
export function hostAllowed(header: string | null, bound: string, port: number): boolean {
  if (bound !== LOOPBACK) return true;
  if (header === null) return false; // HTTP/1.1 で Host 無しは筋が通らぬ
  const allowed = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
  return allowed.includes(header.trim().toLowerCase());
}

/** 台帳の末尾。正本が動けば伸びる——これが更新の合図になる。 */
function version(db: Database): string {
  const r = db.query('SELECT COALESCE(MAX(id), 0) v FROM ledger').get() as { v: number };
  return String(r.v);
}

/**
 * 繋ぐ先。**既定は己の内のみ**（旧 dashboard-viewer.py と同じ 127.0.0.1）。
 *
 * `Bun.serve` は hostname を渡さねば `0.0.0.0`——全ての口に開く。移植の折に
 * これを見落とし、WSL の外向き address から戦況が読めておった（実測 2026-08-29）。
 * 戦況には司令・裁可・陣容が載る。既定で外へ出してよいものではない。
 *
 * 外から見せたい時だけ `--host` で明かす。**広げるなら明示で広げよ。**
 */
export const LOOPBACK = '127.0.0.1';

/**
 * 配る口。**旧 viewer の 8787 は継がなんだ。**
 *
 * この機では 8787 に別人（OpenAI API を模す python の中継）が既に座っており、
 * 写した既定がそのまま衝突した（実測 2026-08-29）。旧の隣を取る。
 * 既定が塞がる土地では `--port` で移されよ。
 */
export const DASHBOARD_PORT = 8788;

export function serve(opts: {
  port: number;
  host?: string;
  db: () => Database;
  compose: () => string;
}): { port: number; host: string; stop: () => void } {
  const host = opts.host ?? LOOPBACK;
  let server;
  try {
    server = bind(opts, host);
  } catch (e) {
    // 口が塞がっておる時に生の例外を吐かせぬ。旧 viewer は errno 98 を
    // 名指しで扱っておった（移植で落としかけた）。**既に配っておる**のと
    // **他人が座っておる**のは見分けられぬゆえ、両方を疑わせる。
    const msg = e instanceof Error ? e.message : String(e);
    if (/EADDRINUSE|in use/i.test(msg)) {
      throw new Error(
        `口 ${opts.port} は既に塞がっておる。\n` +
        '  もう一つ配っておるか、他の者が座っておる。\n' +
        `  確かめよ: ss -ltnp | grep ${opts.port}\n` +
        '  別の口で配るなら --port を渡されよ。',
      );
    }
    throw e;
  }
  // **願った先でなく、繋がった先**を返す。願いを返すと、
  // 「0.0.0.0 で開いておらぬか」の見張りが己の願いを見て頷くだけになる
  // ——試験が落ちようが無い形であった（敵対レビュー・2026-08-29）。
  return {
    port: server.port ?? opts.port,
    host: server.hostname ?? host,
    stop: () => server.stop(),
  };
}

function bind(
  opts: { port: number; db: () => Database; compose: () => string },
  host: string,
) {
  // 実際に繋がった番号を検めに使う。願った番号（0 なら自動採番）で
  // 検めると、己の頁すら弾く——試験が即座に暴いた。
  let bound = opts.port;
  const server = Bun.serve({
    port: opts.port,
    hostname: host,
    fetch(req) {
      // DNS rebinding 除け。錠も名乗りも無い口ゆえ、**誰の名で叩かれたか**
      // だけが頼りになる。よその頁が仕込んだ名で我が家を指しても、
      // Host が合わねば返さぬ（敵対レビューの critical・2026-08-29）。
      if (!hostAllowed(req.headers.get('host'), host, bound)) {
        return new Response('宛先が違う', { status: 403 });
      }
      const path = new URL(req.url).pathname;
      try {
        if (path === '/') {
          return new Response(PAGE, { headers: { ...MARK, 'Content-Type': 'text/html; charset=utf-8' } });
        }
        if (path === '/api/dashboard') {
          return new Response(opts.compose(), { headers: { ...MARK, 'Content-Type': 'text/plain; charset=utf-8' } });
        }
        if (path === '/api/html') {
          return new Response(mdToHtml(opts.compose()), {
            headers: { ...MARK, 'Content-Type': 'text/html; charset=utf-8' },
          });
        }
        if (path === '/api/version') {
          return new Response(version(opts.db()), { headers: { ...MARK, 'Content-Type': 'text/plain' } });
        }
        return new Response('無い', { status: 404 });
      } catch (e) {
        // 掴まねば Bun が**開発用の頁**を返す——stack も source も絶対道も出る。
        // 内情は己の口（stderr）へ、外へは素っ気なく（敵対レビュー）。
        console.error(`  配信でしくじった（${path}）: ${e instanceof Error ? e.message : String(e)}`);
        return new Response('しくじった', { status: 500 });
      }
    },
  });
  bound = server.port ?? opts.port;
  return server;
}
