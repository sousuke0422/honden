/**
 * 箱と記録係の陽性対照。群れを渡す前に、ここが全て通らねばならぬ。
 *
 * 各項は「緩めた箱で同じ形を撃てば痕が残る」（対照が見えることの対照）と、
 * 「記録係の箱では痕が残らぬ」の対で見る。痕は組み込みの printf で fd 8 に書く（記録の fd 9 とは分ける）。
 * ここの命の字は無害な物だけ（捨てる場所への touch・lo への接続・在るかの問い）。
 * 書き込みの試しには特別な組み込みの `:` を使わぬ（redirect に落ちると bash ごと抜けるため、`true` を使う）。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInBox, type Loosen } from './box';
import { parseTrace } from './xtrace';


const RECORDER = readFileSync(join(import.meta.dir, 'recorder.sh'), 'utf8');

/** 記録係の箱で撃つ。trace は記録（fd 9）、marks は痕（fd 8） */
function recorded(cmd: string): { trace: string; marks: string } {
  const r = runInBox({ case: cmd, 'recorder.sh': RECORDER }, '/oracle/in/recorder.sh');
  return { trace: r.stdout, marks: r.stderr };
}

/** 記録係を通さず、緩めた箱の素の bash で撃つ（痕が見えることの対照） */
function naked(cmd: string, loosen: Loosen): string {
  const script = `exec 8>&1 1>/dev/null 2>/dev/null </dev/null\neval "$(< /oracle/in/case)"\n`;
  return runInBox({ case: cmd, 'naked.sh': script }, '/oracle/in/naked.sh', 3000, loosen).stdout;
}

export interface Control {
  name: string;
  /** 緩めた箱で撃った時の記録（痕が出ること） */
  loosened: string;
  /** 記録係の箱で撃った時の、痕（fd 8。出ぬこと）と記録（fd 9 の xtrace） */
  boxed: { trace: string; marks: string };
  /** 対照の判じ */
  ok: boolean;
  detail: string;
}

const MARK = "printf 'MARK\\n' >&8";

export function runControls(): Control[] {
  const out: Control[] = [];

  // 一、命が走らぬこと: 捨てる場所への touch（名と道の両方）
  {
    const cmd = `touch /tmp/sink/ran; /usr/bin/touch /tmp/sink/ran2; [ -e /tmp/sink/ran ] && ${MARK}; [ -e /tmp/sink/ran2 ] && ${MARK}; printf 'END\\n' >&8`;
    const loosened = naked(cmd, { usr: true });
    const boxed = recorded(cmd);
    const traced = parseTrace(boxed.trace).traced.map((t) => t.argv.join(' '));
    const ok =
      (loosened.match(/MARK/g) ?? []).length === 2 &&
      !boxed.marks.includes('MARK') &&
      boxed.marks.includes('END') &&
      traced.includes('touch /tmp/sink/ran') &&
      traced.includes('/usr/bin/touch /tmp/sink/ran2');
    out.push({ name: '命が走らぬ（touch の痕が残らず、argv は記録される）', loosened, boxed, ok, detail: traced.join(' | ') });
  }

  // 二、shell を呼び直せぬこと（bash も sh も箱の中で見つからぬ）
  {
    const cmd = `bash -c "${MARK}"; /bin/bash -c "${MARK}"; sh -c "${MARK}"; /usr/bin/bash -c "${MARK}"; printf 'END\\n' >&8`;
    const loosened = naked(cmd, { usr: true });
    const boxed = recorded(cmd);
    const ok = (loosened.match(/MARK/g) ?? []).length >= 3 && !boxed.marks.includes('MARK') && boxed.marks.includes('END');
    out.push({ name: 'shell を呼び直せぬ', loosened, boxed, ok, detail: '' });
  }

  // 三、網に出られぬこと（lo の上の待ち受けへの接続。網を分けねば届く）
  {
    const port = 39000 + Math.floor(Math.random() * 1000);
    const server = Bun.listen({ hostname: '127.0.0.1', port, socket: { data() {}, open(s) { s.end(); } } });
    try {
      const cmd = `true 3<>/dev/tcp/127.0.0.1/${port} && ${MARK}; printf 'END\\n' >&8`;
      const loosened = naked(cmd, { net: true });
      const boxed = recorded(cmd);
      const ok = loosened.includes('MARK') && !boxed.marks.includes('MARK') && boxed.marks.includes('END');
      out.push({ name: '網に出られぬ（手元の lo の待ち受けに届かぬ）', loosened, boxed, ok, detail: `port ${port}` });
    } finally {
      server.stop(true);
    }
  }

  // 四、家と repo が見えず、捨てる場所の他に書けぬこと
  {
    const repo = join(import.meta.dir, '..', '..');
    const home = process.env.HOME ?? '/home';
    const cmd = [
      `[ -e '${home}' ] && printf 'HOME\\n' >&8`,
      `[ -e '${repo}' ] && printf 'REPO\\n' >&8`,
      `[ -e /usr/bin ] && printf 'USR\\n' >&8`,
      `{ true > /oracle/x; } 2>/dev/null && printf 'WROTE-ROOT\\n' >&8`,
      `{ true > /oracle/in/x; } 2>/dev/null && printf 'WROTE-IN\\n' >&8`,
      `{ true > /tmp/sink/ok; } 2>/dev/null && printf 'TMP-OK\\n' >&8`,
      `printf 'END\\n' >&8`,
    ].join('; ');
    const loosened = naked(cmd, { usr: true });
    const boxed = recorded(cmd);
    const ok =
      loosened.includes('USR') &&
      !/HOME|REPO|USR|WROTE/.test(boxed.marks) &&
      boxed.marks.includes('TMP-OK') &&
      boxed.marks.includes('END');
    out.push({ name: '家・repo・/usr が見えず、/tmp の他に書けぬ', loosened, boxed, ok, detail: `home=${home} repo=${repo}` });
  }

  // 五、外した組み込み（exec・source・.・kill・trap・enable）が効かぬこと
  {
    const cmd = [
      `exec 9>/dev/null`,
      `trap '' EXIT`,
      `enable exec`,
      `source /oracle/in/case`,
      `printf 'END\\n' >&8`,
    ].join('; ');
    const boxed = recorded(cmd);
    const traced = parseTrace(boxed.trace).traced.map((t) => t.argv[0]);
    const ok = boxed.marks.includes('END') && ['exec', 'trap', 'enable', 'source'].every((n) => traced.includes(n));
    out.push({ name: '外した組み込みは効かず、argv だけが記録される', loosened: '', boxed, ok, detail: traced.join(' ') });
  }
  return out;
}
