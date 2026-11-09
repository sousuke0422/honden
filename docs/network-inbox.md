# 網越しの inbox

外の agent は鍵で名乗り、自分の inbox を取りに来ます。
外の相手は鍵を持って網の口からのみ動け、手元の CLI では環境変数や差出名でその相手を名乗れません。
将軍と家老は自分の名乗りで `honden inbox read --agent 相手名` を使い、能力を絞った相手や取消済みの相手の受け箱も覗けます。
この覗きで相手の報せを既読にすることはありません。
待受は既定で閉じており、将軍が IP アドレスを明示して設定した時だけ `network serve` で開けます。
読むだけの dashboard と書き込みを許す口を別にし、dashboard の認証や用途を変えずに運用します。

## 相手を登録する

将軍の pane で次を実行します。
`agent` の相手名は手元の宛名にもなります。
名簿の名と衝突する名前は登録できません。

```sh
honden network peer add --name visitor --kind agent \
  --capabilities inbox.read,inbox.write,report.submit --destinations gunshi,karo
```

出力の `key` は一度だけ表示されます。
秘密を保管できる経路で相手へ渡してください。
正本に保存するのは SHA-256 hash だけで、状態表示や ledger には鍵を出しません。
権限を渡さない口は `capabilities` から省き、書いてよい手元の宛先だけを `destinations` に列挙します。
`report.submit` は宛先設定と独立に軍師へ固定されます。

```sh
honden network peer rotate --name visitor
honden network peer revoke --name visitor
honden network peers
```

切り直すと旧鍵は即座に使えなくなります。
取消は相手の履歴を残したまま認証を止めます。
切り直しで認証を再開できます。
能力と宛先は登録時に固定されるため、運用中に変更する口は今回設けていません。

## 待受を設定する

```sh
honden network configure --host 127.0.0.1 --port 8789
timeout 20m honden network serve
honden network configure --disable
```

ここで示す loopback は手元の試用例です。
別の機から使う時は、その接続を受ける特定のインターフェースの IP を設定してください。
`0.0.0.0`、`::`、それらの同値な IPv6 表記は拒否します。
ホスト名も受け付けず、名前解決による待受先の変化を避けます。
設定と鍵の管理は将軍だけが行えます。
`--disable` は次の起動を止める設定であり、稼働中の待受を止める時はその process も終了してください。

HTTP の待受自体は TLS を終端しません。
loopback 以外で使う時は、信頼する private transport または TLS の終端を経由し、Bearer 鍵を平文の網へ流さない構成にしてください。
本文の上限は UTF-8 の JSON 全体で 64 KiB です。
常駐の芯は相手を pane として扱いません。
相手は 5 秒程度の間隔で未読の数を問い合わせ、未読があれば本文を読みます。
長く待つ接続を持たないため、再接続と取消の扱いが単純になります。

## HTTP の口

`HONDEN_URL` と `HONDEN_KEY` は利用者が接続先と鍵を設定した環境変数です。
コマンド履歴や共有ログに鍵を展開した値を残さないでください。

```sh
curl -H "Authorization: Bearer $HONDEN_KEY" "$HONDEN_URL/v1"
curl -H "Authorization: Bearer $HONDEN_KEY" "$HONDEN_URL/v1/inbox/unread"
curl -H "Authorization: Bearer $HONDEN_KEY" "$HONDEN_URL/v1/inbox/read"
```

| 口 | 必要な能力 | 結果 |
| --- | --- | --- |
| `GET /v1` | 有効な鍵 | 版、instance ID、許された能力と宛先、poll 間隔、本文上限 |
| `GET /v1/inbox/unread` | `inbox.read` | 己の未読数 |
| `GET /v1/inbox/read` | `inbox.read` | 己の未読を最大 100 件と、既読にできる ID の写し |
| `POST /v1/inbox/ack` | `inbox.read` | 直近に読んだ己の ID を既読にする |
| `POST /v1/inbox/write` | `inbox.write` と宛先許可 | 封筒を手元の宛先へ一度だけ届ける |
| `POST /v1/report/submit` | `report.submit` | 己が握る仕事の報告を軍師へ届ける |

鍵の無い要求、違う鍵、取り消された鍵は 401 です。
許していない能力、宛先、差出人、仕事は 403、本文や封筒の形式違いと許す刻の範囲外は 400、重複 ID の内容違いと既読化の競合は 409、本文の超過は 413 です。
司令、手形、布陣の変更や他の者の inbox を読む口はありません。

既読化には `read` が返した封筒 ID をそのまま使います。
`all` は直近の `read` が見せた分だけを既読にします。
`read` 後に新着があれば一件も既読にせず、読み直しを求めます。
読み取り件数を超えた古い未読を勝手に片付けることもありません。

```sh
curl -H "Authorization: Bearer $HONDEN_KEY" -H 'Content-Type: application/json' \
  -d '{"all":true}' "$HONDEN_URL/v1/inbox/ack"
```

## 封筒を届ける

封筒は次の七つの文字列を持ちます。
`id` は `相手名/相手側の一意な ID`、`origin` は登録した相手名です。
同じ ID を同じ本文で送り直しても inbox には一度しか入りません。
同じ ID に異なる内容を載せると 409 で拒否します。

`at` は、受け手が封筒を検める現在刻から前後 5 分までを許します。
ちょうど 5 分は通り、それを超える未来や過去の刻は 400 で断り、拒否を ledger に記録します。
`inbox.write` と `report.submit` の両方に適用します。
相手の機の時計は NTP などで合わせておいてください。
受け手の現在刻の値は応答に返しません。

刻の検めは重複の確認より先に行います。
既に受け入れた封筒も範囲外になった後の再送は 400 とし、古い刻を持つ封筒が再送だけで検めを通り抜けないようにします。
既に届いた報せが再送で増えることはありません。
下の `at` は例示であり、送信時は現在刻へ置き換えてください。

```json
{
  "id": "visitor/message-1",
  "origin": "visitor",
  "sender": "visitor",
  "recipient": "gunshi",
  "type": "review_request",
  "body": "自分の判断に不安があるため、確認を願います。",
  "at": "2026-01-01T00:00:00.000Z"
}
```

これを `envelope.json` に保存した場合の送信例です。

```sh
curl -H "Authorization: Bearer $HONDEN_KEY" -H 'Content-Type: application/json' \
  --data-binary @envelope.json "$HONDEN_URL/v1/inbox/write"
```

外から来た種別は内部のイベントとして発火させず、`external_notice` として収めます。
本文に相手名、元の種別、封筒 ID を付け、知らせと命を見分けられるようにします。
受信した封筒の全フィールドは `network_envelope` に保存します。
手元から送った報せを外の相手が読む時の ID は `instance ID/手元の ID` で、再読しても変わりません。

## 仕事を振り、報告を受ける

相手へ仕事を振る必要がある時は、家老が通常の `task assign` に登録した相手名を指定します。
報告にはその仕事番号が必要で、他の者の仕事や手放した仕事は報告できません。
報告の受け入れ条件の検査と軍師への経路は足軽と同じです。

報告では封筒の `recipient` を `gunshi`、`type` を `report.submit` とし、`body` に通常の報告 JSON を文字列として入れます。
その封筒を `POST /v1/report/submit` に送ります。
成功した報告の再送も同じ封筒なら重複させません。

```json
{
  "task_id": "ASSIGNED_TASK_ID",
  "status": "done",
  "summary": "資料の確認を終えました。",
  "acceptance": { "1": "一次資料を取得し、記載を照合しました。" }
}
```

外の相手に開発の仕事は原則振りません。
honden が振った仕事、軍師を通すよう明示された仕事、相手が自分で不安に思って持ち込む仕事だけを軍師へ回します。
普段の外部作業の全てに報告を要求する仕組みではありません。

## honden 同士への余地

相手の種に `honden` を登録でき、`名@相手` の宛名を解析できます。
`honden` の鍵で封筒を受ける時は、差出が `名@認証した相手` であることを確認します。
たとえば `other` の鍵は `karo@other` を差出にできますが、手元の `karo` は名乗れません。

今回の `honden` 相手は、許した手元の宛先への封筒の持ち込みまでです。
複数 agent の inbox の代理読み、相手の inbox へこちらから届けに行く送り手、遠方へ宛てた封筒の転送は実装していません。
方向は表に `pull` として持ち、版を変えずに将来の別 transport を明確に区別できる余地を残します。

## 記録を見る

全 HTTP 要求を、認証した相手、使った口、宛先、結果の status とともに ledger へ追記します。
認証に失敗した要求も記録します。
本文や鍵は ledger に写しません。
登録、切り直し、取消、待受設定の変更も記録されます。

```sh
honden network peers
honden status
honden log --actor visitor
```

`network peers` では許可、有効か否か、未読数、最後の接続が分かります。
待受の IP 設定は既存 DB に新しい表として加わり、既存の名簿、台帳、門の判じは変えません。
