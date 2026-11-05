# Copilot の cloud agent で門を生かす

Copilot の cloud agent は GitHub Actions の runner で動きます。
runner には honden の本体（`bin/honden` など）が無いため、門（`.claude/hooks/guard.sh`）は検められない物は通さないとして、全ての命を断ります。
門を外さずに Copilot を働かせるため、`.github/workflows/copilot-setup-steps.yml` が、Copilot が始まる前に release の本体を降ろして `bin/` に置きます。

## 何をするか

1. 名指しした版の release から、`SHA256SUMS`、`SHA256SUMS.cosign.bundle`、linux-x64 の本体六本を降ろします。公開の release なので token は渡しません。
2. `SHA256SUMS` の署名を cosign で検めます。identity は、名指しした版の札で `release.yml` が署名した物に当てます。
3. 六本を `SHA256SUMS` で照らします。
4. 照らしが通った物を、門が探す名（`bin/honden` など、`-linux-x64` を外した名）で置きます。
5. 降ろした `bin/honden` で `honden guard check` を撃ち、通るはずの命が通り、止まるはずの命が止まることを確かめます。

どれかに落ちると job が落ち、本体は置かれません。
その時、門は今まで通り全ての命を断ります。
Copilot のためだけに門を緩める形は取りません。

## 版を上げる時

release の新しい札を打ったら、`copilot-setup-steps.yml` の `HONDEN_VERSION` を同じ札に替えます。
替えないと、Copilot の runner では古い版の門が働きます。
替えたら、その枝で workflow を `workflow_dispatch` で撃ち、緑になることを確かめます。

この workflow は既定の枝に在る時にだけ Copilot に効きます（GitHub の定め）。
