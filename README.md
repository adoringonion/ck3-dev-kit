# CK3 Mod DevKit

Crusader Kings III の MOD 開発向けに、最低限のパーサーと VSCode 補助をまとめたローカル拡張です。

## できること

- CK3 スクリプトとローカライズの簡易パース
- `namespace`、イベント ID、`scripted_effects`、`scripted_triggers`、ローカライズキーの索引
- 定義ジャンプ
- ホバー
- 参照検索
- 文脈つき補完
- ドキュメントシンボル / ワークスペースシンボル
- 括弧の不整合などの軽い診断
- CK3 用の `files.associations` をワークスペースに書くコマンド

## 使い方

1. このフォルダで `npm install`
2. `npm run build`
3. `npm test`
4. VSCode でこのフォルダを開く
5. `F5` で Extension Development Host を起動
6. コマンドパレットから `CK3 Mod DevKit: Write Workspace File Associations` を実行

## 通常インストール

`.vsix` を作って通常の VSCode 拡張として入れられます。

```bash
npm install
npm run package:vsix
code --install-extension ./ck3-devkit-0.1.0.vsix
```

インストール後は、MOD フォルダを VSCode で開いて `ck3ModDevkit.referenceRoots` を CK3 本体の `game` フォルダに合わせてください。たとえば `mod_dev/relic_of_the_first_empire` を開くなら、既定値の `${workspaceFolder}/../../game` でそのまま使えます。

## CLI

Codex やシェルから直接使うための JSON 出力 CLI を用意しています。機械的に読むときは `npm run` より `node dist/*.js` の直実行がおすすめです。

```bash
npm run build
node dist/cli.js ../.. ../../../game
node dist/find-symbol.js mod_dev_starter.0001 ../../relic_of_the_first_empire ../../../game
node dist/find-references.js mod_dev_starter.0001 ../../relic_of_the_first_empire ../../../game
node dist/cache-info.js ../../relic_of_the_first_empire ../../../game
node dist/rebuild-cache.js ../../relic_of_the_first_empire ../../../game
node dist/parse-file.js ../../relic_of_the_first_empire/events/mod_dev_starter_events.txt
node dist/diagnostics.js ../../relic_of_the_first_empire/events/mod_dev_starter_events.txt
node dist/validate-references.js ../../relic_of_the_first_empire ../../../game
node dist/generate-skill.js ../..
```

終了コード:

- `0`: 成功
- `1`: 実行エラー
- `2`: 該当なし、または診断あり
