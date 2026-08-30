/**
 * 卓上へ報せる（Windows の対話式通知）。
 *
 * # 借り物を使わぬ
 *
 * BurntToast のような module は入れぬ。素の COM（`Windows.UI.Notifications`）で
 * 足りることを実測した（2026-08-30）——module を入れれば D011 の伺いが要り、
 * 機が変わるたびに据え直しになる。
 *
 * # ボタンの行き先は http
 *
 * 独自の protocol（`honden:`）でボタンを受けるには registry の登録が要る。
 * だが**配信の窓が既に立っておる**ゆえ、`http://127.0.0.1:8788` を指せば
 * 既定の browser が開くだけで済む。登録も COM server も要らぬ。
 *
 * # 符号化して渡す。ファイルにも BOM にも頼らぬ
 *
 * PowerShell 5.1 は BOM の無い `.ps1` を**既定の符号系**（この機では Shift-JIS）で
 * 読む。WSL から書いた UTF-8 の日本語は化ける——最初の試し撃ちで実際に化けた。
 * `-EncodedCommand`（UTF-16LE の base64）なら、ファイルを置かず符号系にも
 * 依らぬ。中身が無傷で届くことを文字符号で確かめてある。
 */
import type { Notice, Sink } from '../notify';

/** 通知を借りる名。既存の AppUserModelID を借りれば登録が要らぬ。 */
const APP_ID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe';

/** XML へ差し込む字を殺す。**通知の中身は配下が書いた文である。** */
export function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** 報せから通知の XML を組む。純関数ゆえ試験できる。 */
export function toastXml(n: Notice): string {
  const action = n.url
    ? `<action content="戦況を見る" activationType="protocol" arguments="${esc(n.url)}" />`
    : '';
  return (
    '<toast scenario="reminder">' +
    '<visual><binding template="ToastGeneric">' +
    `<text>${esc(n.title)}</text>` +
    `<text>${esc(n.body)}</text>` +
    '</binding></visual>' +
    `<actions>${action}<action content="後で" activationType="system" arguments="dismiss" /></actions>` +
    '</toast>'
  );
}

/** 撃つための PowerShell を組む。 */
export function script(n: Notice): string {
  // ここへ差し込むのは XML だけで、既に escape 済み。PowerShell の
  // here-string（@"…"@）は展開を行うが、`$` を含む字は escape で潰れておる。
  return [
    "$ErrorActionPreference = 'Stop'",
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] > $null',
    '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType=WindowsRuntime] > $null',
    '$doc = New-Object Windows.Data.Xml.Dom.XmlDocument',
    `$doc.LoadXml(@'\n${toastXml(n)}\n'@)`,
    '$t = New-Object Windows.UI.Notifications.ToastNotification $doc',
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${APP_ID}').Show($t)`,
  ].join('\n');
}

/** UTF-16LE の base64。PowerShell の `-EncodedCommand` が食う形。 */
export function encode(ps: string): string {
  return Buffer.from(ps, 'utf16le').toString('base64');
}

export interface Runner {
  (args: string[]): { ok: boolean; detail?: string };
}

const realRun: Runner = (args) => {
  try {
    const p = Bun.spawnSync(args, { stdout: 'pipe', stderr: 'pipe' });
    if (p.success) return { ok: true };
    return { ok: false, detail: new TextDecoder().decode(p.stderr).slice(0, 200) };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
};

/**
 * 卓上の送り口。
 *
 * Windows が居らぬ機（真の Linux 等）では `powershell.exe` が無く、
 * **黙って成功と言わぬ**——落ちたと言う。届かなんだ報せを届いたことにすれば、
 * 見張りが嘘をつく。
 */
export function desktopSink(run: Runner = realRun): Sink {
  return {
    name: 'desktop',
    send: (n) => run(['powershell.exe', '-NoProfile', '-NonInteractive', '-EncodedCommand', encode(script(n))]),
  };
}
