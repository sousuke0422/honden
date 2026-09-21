# 借り物である

このディレクトリのものは、こちらが書いたものではない。

```
出所    https://github.com/github/gh-stack
        skills/gh-stack（SKILL.md と references/ 三枚）
版      2bd699a544a0  2026-08-27T13:34:37-04:00
免許    MIT（LICENSE に全文。著作の表示は GitHub, Inc.）
```

**一字も手を入れていない。**
SKILL.md も references/（commands.md・stack-design.md・troubleshooting.md）も上流のままである。
書き換えれば上流の更新と食い違うからである。
上流は追う——取り直す時はこの版の欄を改めること。

## この陣の事情（上流の書には無い話）

この skill は `gh stack` の拡張が入っていることを前提とする。
実測（2026-09-21）では、この陣の二つの gh の**双方**に v0.1.0 が入っている。

```
gh.exe（Windows 側）      gh stack  github/gh-stack  v0.1.0
/usr/bin/gh（WSL 側）     gh stack  github/gh-stack  v0.1.0
```

拡張は gh ごとに属する。片方に入れても、もう片方には入らない。
無い方で叩くなら `gh extension install github/gh-stack` で足す。

この陣には「GitHub への書き込みは `gh.exe` で行う」定めがある
（WSL の gh は task 系の repo で 403 になる・実測済み）。
`gh stack push` や `gh stack submit` のような書き込みの命を task 系で使うなら、
`env -u GH_TOKEN gh.exe stack …` の形で gh.exe 側を使うこと。
読み取り（`gh stack view` など）はどちらでもよい。
