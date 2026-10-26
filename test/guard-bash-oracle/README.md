# 箱の中の bash を物差しにする試験

門の解き手（`bin/honden-parse`）が取り出す単純命令の argv が、本物の bash が exec しようとする argv と
合うかを、#56 の群れ（`test/fixtures/guard-corpus.jsonl`）の全件で比べる。

## 安全の形

攻撃の形を bash に渡すゆえ、**手元の機械の上で直に bash へ渡さぬ。** 撃つのは箱の中だけで、命は走らせぬ。

- 箱（`box.ts`）は bubblewrap で作る
  - 全ての名前空間を分け、網は箱の中の lo だけ
  - 根は空の tmpfs を読み取り専用にした物で、手元の家・repo・`/usr` は見えぬ
  - bash（`/oracle/sh`）、その共有library、呼び直しを止める `seal-exec.so` を置く。
  - `seal-exec.so` は初回bash起動のloaderでseccompを据え、`execve` と `execveat` をENOENTで拒む。
    `/oracle/sh` と `/proc/self/exe` も呼び直せず、子にも制限が継がれる。
    据えられなければ入力を読む前に終了する。
    共有libraryは初回に `cc` で一時dirへ組み、終了時に消す。LinuxのC compilerとheadersが必要になる。
  - 書き込めるのは捨てる `/tmp` だけ
  - 時限（3 秒）を過ぎれば bwrap ごと殺す
- 記録係（`recorder.sh`）は、命を走らせずに argv を残す
  - PATH は空の dir で、名だけの命は見つからず `command_not_found_handle` が何もせずに返る
  - 道を書いた命は file が無いゆえ exec が落ちる（`execfail` で続ける）
  - `exec`・`source`・`.`・`kill`・`trap`・`enable` は `enable -n` で外す
  - argv は xtrace（展開・引用の除去・`$IFS` の分割・brace 展開の後）で fd 9 へ出す。陽性対照の痕は fd 8 へ分ける
- 陽性対照（`controls.ts`）は、群れを渡す前に毎回撃つ
  - 緩めた箱で痕が残る形が、記録係の箱では痕を残さぬことを、対で見る
  - 実在する二経路（`/oracle/sh` と `/proc/self/exe`）も、禁止を外した箱では痕が出ることと対にして検める。
  - 従来の五つも見る: touch が走らぬ・shell を呼び直せぬ・lo の待ち受けに届かぬ・家と repo が見えず `/tmp` の他に書けぬ・外した組み込みが効かぬ
  - 一つでも落ちれば群れは渡さぬ

## 物差しで取れる物と取れぬ物

取れる物:

- 上の層の単純命令（組み込み・関数の名・道を書いた命を含む）
- 命令置換・プロセス置換・パイプの中の命
- 引用せぬ heredoc の本文の命令置換の中の命
- 呼ばれた関数の中の命と、eval の中の命

取れぬ物:

- **走らぬ枝の命**: 偽の条件の先、`&&` や `||` で飛ぶ先、呼ばれぬ関数、`exit` の後
- **実の環境の値**: 箱の中の値（HOME は `/tmp`、変数は空、glob は箱の中の file）で展開する
- **別の shell に渡す字の中の命**: `bash -c '…'`・`sh <<EOF`。次のshellの起動を拒むため、字のままargvに残る
- **記録を止める形の後の命**: `set +x` と `shopt -u execfail` の後。xtrace を止められると、その後の命は残らぬ
- **alias**: 対話でない bash は展開せぬ
- **終わらぬ繰り返し**: 時限までの分だけが残る

## 比べと分け

`compare.ts` は argv の集まり（重なりを畳み、並びは比べぬ）で比べる。

- 解き手の側: 上の層の命に、命令置換の中身を解き直した命を足す（深さ 3 まで）
- bash の側: 複合命令の頭（`[[`・`case`・`for`・`select`・`((`）は単純命令ではないゆえ除く

違う件は `test/fixtures/guard-bash-oracle.jsonl` に、次の三つに分けて記録する。

- **解き手の読み違い**: 判じに効く物（`impact: true`）は、#56 の群れにも今の門の判じのまま入れる
- **物差しの限り**
- **比べの形の違い**

## 撃ち方

```
bun test test/guard-bash-oracle.test.ts       # 陽性対照と、違いが記録どおりか
bun run test:guard-bash-oracle                # 違いの一覧を出す
bun run test:guard-bash-oracle --update       # 記録を書き換える（新しい件は「未分類」。分けと訳を手で付ける）
```

- 要る物は bubblewrap と、素の利用者の名前空間
- 箱が作れぬ環境では、試験も script も撃たずに飛ばす（落ちぬ）
- 全件を撃つのに手元で 15 秒ほどかかる
- CI（`.github/workflows/ci.yml`）では、bubblewrap を入れ、AppArmor の素の利用者の名前空間の止めを外してから `bun test` を撃つ
- `bin/honden-parse` が要る
  - 作業木で撃つ時は、その木で `cargo build --release -j 4 --manifest-path core/guard/Cargo.toml` を打つ
  - その後、その木の根で `ln -s core/guard/target/release bin` を張る（どちらも .gitignore の内）

## 読めない記録の扱い

xtraceの断片を語へ戻せなかった測定は比較も更新もしない。
`assertReadable` が対象の命と読めない断片を診断に含めて停止し、`--update` でも記録fileに触れない。
`shape` は読めた測定の差だけを表すため、読めない断片を通常の差としてgoldenに保存しない。
比較、記録への変換、更新の各入口でも同じ条件を検める。
