/**
 * 運用の様態。
 *
 * ## 「将軍は特別」ではない。「殿が在席か」である
 *
 * 合図を将軍へ撃たぬのは、将軍が偉いからではなく、
 * **殿がいま打ち込んでおる最中を潰すゆえ**である。
 *
 * 殿が席を外しておる間——夜間や、仕事中——は潰す入力が無い。
 * その間は将軍を起こすのが前提になる。起こさねば、家老からの
 * escalation が誰にも届かず、パイプラインが朝まで止まる
 * (memory: shogun_night_autonomous_escalation)。
 *
 * ゆえに旗ではなく様態にした。旗にすると「例外的に起こす」と読める。
 * 自律運用では起こすのが常道であって、例外ではない。
 *
 * ## 切り替えられるのは将軍だけ
 *
 * 様態が言い表しているのは「殿が席におられるか」という**外の世界の事実**で、
 * 布陣の都合ではない。それを見ているのは将軍だけである。
 *
 * 誰でも切り替えられると、足軽が自分の合図を通したくて自律へ移せる。
 * 移せば家老から将軍への路も開くので、一体の都合で布陣ぜんたいの
 * 決めが動く。指揮系統を型で守っているのと同じ理由で絞る。
 *
 * 読むのは誰でもよい。合図を撃つ側 (nudge) が毎回読むゆえ。
 *
 * ## 期限をつけられる
 *
 * 様態を戻し忘れると、朝になって殿が打ち込んでおる最中に合図が飛ぶ。
 * **戻し忘れの害が、まさにこの守りが防ごうとしているもの**なので、
 * 自分で戻れるようにした。期限を過ぎれば在席として扱う。
 */

import type { Database } from 'bun:sqlite';
import { journal } from './store';

export const MODES = ['attended', 'autonomous'] as const;
export type Mode = (typeof MODES)[number];

/** 何も決めておらぬ時。殿が居るものとして扱う——潰すほうが害が大きい。 */
export const DEFAULT_MODE: Mode = 'attended';

/** 様態を切り替えられる者。殿の在席を見ておるのは将軍だけゆえ。 */
export const MODE_AUTHOR = 'shogun';

export interface ModeState {
  mode: Mode;
  /** 決めた時刻。 */
  at?: string;
  by?: string;
  /** この時刻を過ぎたら既定へ戻る。 */
  until?: string;
  /** 期限切れで既定へ戻っているか。 */
  expired: boolean;
}

export function getMode(db: Database, now: Date = new Date()): ModeState {
  const r = db.query("SELECT value, at, by, until FROM setting WHERE key = 'mode'").get() as
    | { value: string; at: string; by: string | null; until: string | null }
    | null;
  if (!r) return { mode: DEFAULT_MODE, expired: false };

  const expired = r.until !== null && new Date(r.until).getTime() <= now.getTime();
  return {
    mode: expired ? DEFAULT_MODE : (r.value as Mode),
    at: r.at,
    by: r.by ?? undefined,
    until: r.until ?? undefined,
    expired,
  };
}

/** 殿が席を外しておるか。合図を将軍へ撃つかの判断はこれ一つで決まる。 */
export function isAutonomous(db: Database, now: Date = new Date()): boolean {
  return getMode(db, now).mode === 'autonomous';
}

export interface SetResult {
  ok: boolean;
  message?: string;
  state?: ModeState;
}

/**
 * 期限の書き方を解く。
 *
 * `08:00` のような時刻なら、いまより後の直近のその時刻。
 * 夜に「朝 8 時まで」と書いた時、翌朝を指すようにする。
 * `6h` のような長さも受ける。ISO 8601 も受ける。
 */
export function parseUntil(s: string, now: Date = new Date()): Date | null {
  const t = s.trim();

  const hhmm = /^(\d{1,2}):(\d{2})$/.exec(t);
  if (hhmm) {
    const h = Number(hhmm[1]);
    const m = Number(hhmm[2]);
    if (h > 23 || m > 59) return null;
    const d = new Date(now);
    d.setHours(h, m, 0, 0);
    if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
    return d;
  }

  const span = /^(\d+(?:\.\d+)?)(h|m)$/.exec(t);
  if (span) {
    const n = Number(span[1]);
    const ms = span[2] === 'h' ? n * 3_600_000 : n * 60_000;
    if (ms <= 0) return null;
    return new Date(now.getTime() + ms);
  }

  const iso = new Date(t);
  return Number.isNaN(iso.getTime()) ? null : iso;
}

export function setMode(
  db: Database,
  selfId: string | undefined,
  mode: string,
  opts: { until?: string; now?: Date } = {},
): SetResult {
  const now = opts.now ?? new Date();

  if (selfId !== MODE_AUTHOR) {
    return {
      ok: false,
      message:
        `様態を切り替えられるのは ${MODE_AUTHOR} である（そなたは ${selfId ?? '名乗り無し'}）。\n` +
        '  これは「殿が席におられるか」という布陣の外の事実であって、\n' +
        '  布陣の都合で動かすものではない。見ておるのは将軍だけである。\n' +
        '  合図が通らぬなら、まず未読を片付けられよ。\n' +
        '  読むだけなら誰でもよい: honden mode',
    };
  }

  if (!(MODES as readonly string[]).includes(mode)) {
    return {
      ok: false,
      message:
        `様態は ${MODES.join(' か ')} である。受け取った値: ${JSON.stringify(mode)}\n` +
        '  attended   殿が席におられる。将軍へは撃たぬ\n' +
        '  autonomous 殿が席を外しておられる。将軍も起こす',
    };
  }

  let until: Date | null = null;
  if (opts.until !== undefined && opts.until !== '') {
    until = parseUntil(opts.until, now);
    if (!until) {
      return {
        ok: false,
        message:
          `期限が読めぬ: ${JSON.stringify(opts.until)}\n` +
          '  08:00 のような時刻、6h のような長さ、ISO 8601 のいずれかで書かれよ。',
      };
    }
    if (until.getTime() <= now.getTime()) {
      return { ok: false, message: `その期限は既に過ぎておる: ${until.toISOString()}` };
    }
  }

  // 自律へ移すのに期限が無いのは危うい。戻し忘れると、朝になって
  // 殿が打ち込んでおる最中に合図が飛ぶ。守ろうとしたものを自分で壊す。
  // 断りはせぬが、黙って通しもしない。
  const warn =
    mode === 'autonomous' && !until
      ? '\n  ※ 期限が無い。戻し忘れると、殿が席へ戻られた後も将軍へ撃ち続ける。\n' +
        '    --until 08:00 のように切っておくのが safe である。'
      : '';

  const at = now.toISOString();
  db.prepare(
    `INSERT INTO setting(key, value, at, by, until) VALUES ('mode',?,?,?,?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, at = excluded.at,
       by = excluded.by, until = excluded.until`,
  ).run(mode, at, selfId ?? null, until ? until.toISOString() : null);

  journal(db, {
    actor: selfId ?? '不明',
    action: `mode.${mode}`,
    target: 'formation',
    detail: until ? `until=${until.toISOString()}` : '期限なし',
  });

  return { ok: true, state: getMode(db, now), message: warn || undefined };
}

/** 人へ見せる形。 */
export function describe(s: ModeState): string {
  const head =
    s.mode === 'autonomous'
      ? '  autonomous — 殿は席を外しておられる。将軍も起こす。'
      : '  attended — 殿が席におられる。将軍へは撃たぬ。';
  const lines = [head];
  if (s.expired) {
    lines.push(`  ※ ${s.until} で期限が切れ、既定へ戻っておる。`);
  } else if (s.until) {
    lines.push(`  期限: ${s.until}`);
  }
  if (s.at) lines.push(`  決めた者: ${s.by ?? '不明'} (${s.at})`);
  return lines.join('\n');
}
