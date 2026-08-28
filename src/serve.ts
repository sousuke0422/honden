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

const PAGE = `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Dashboard</title>
  <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
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
  <script>
    let last = '';
    async function poll() {
      try {
        const v = await (await fetch('/api/version')).text();
        if (v !== last) {
          last = v;
          const md = await (await fetch('/api/dashboard')).text();
          document.getElementById('app').innerHTML = marked.parse(md);
          document.getElementById('stamp').textContent = '取得: ' + new Date().toLocaleTimeString();
        }
      } catch (e) { /* 一時の失敗は次の周で拾う */ }
    }
    poll();
    setInterval(poll, 1500);
  </script>
</body>
</html>`;

/** 台帳の末尾。正本が動けば伸びる——これが更新の合図になる。 */
function version(db: Database): string {
  const r = db.query('SELECT COALESCE(MAX(id), 0) v FROM ledger').get() as { v: number };
  return String(r.v);
}

export function serve(opts: {
  port: number;
  db: () => Database;
  compose: () => string;
}): { port: number; stop: () => void } {
  const server = Bun.serve({
    port: opts.port,
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === '/') {
        return new Response(PAGE, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      }
      if (path === '/api/dashboard') {
        return new Response(opts.compose(), { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
      }
      if (path === '/api/version') {
        return new Response(version(opts.db()), { headers: { 'Content-Type': 'text/plain' } });
      }
      return new Response('無い', { status: 404 });
    },
  });
  return { port: server.port ?? opts.port, stop: () => server.stop() };
}
