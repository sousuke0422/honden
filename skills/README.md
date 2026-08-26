# skills

この棚は、他所へまるごと繋いで使う前提で置いてある。

```
skills/
  competitive-survey/     自作
  external-to-honden/     自作
  vendor/                 借り物。免許が付く
    find-skills/          MIT — vercel-labs/skills
  find-skills -> vendor/find-skills    近道
```

## 借り物は vendor/ へ

自作と混ぜると、次に触る者が「変えてよいもの」と
「変えれば免許に触れるもの」を見分けられない。

借り物には `NOTICE.md` を置き、出所・版・免許・**こちらが変えた箇所**を書く。
版を書かないと、後から「いつのものか」が辿れない。

## 近道は相対で貼る

`skills/` を他所へ繋ぐ前提ゆえ、**絶対で貼ると繋いだ先で解けない。**

```bash
cd skills && ln -sfn vendor/find-skills find-skills
```

`.gitignore` は白名簿である。近道は一本ごとに許可を書く——
`skills/*` を丸ごと開けると、白名簿にした意味が消える。

## 借り物の手順が、この布陣の決めと食い違う時

**消さずに、断りを添えて残す。** 消すと、元の手順を読んだ者が
「なぜ違うのか」を辿れなくなる。

`vendor/find-skills/SKILL.md` の頭がその例。元の Step 6 は
`npx skills add -g -y` を指図しているが、この布陣では D010-AT / D011-AT で
禁じている。手順は残し、頭に「探すのは可・入れるのは STOP-and-report」と置いた。
