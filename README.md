# DWG Viewer（ビューア）Chrome拡張

DWGをブラウザ内で読み込み表示します。解析・描画はすべてローカル（WASM）で完結し、
ファイルは外部に送信されません。**ドラッグ&ドロップ**でファイルを開けます。

`dwg-compare`（重ね合わせ差分ビューア）を参考に、単一DWGの閲覧用として作成しました。

## 主な機能
- DWGの読み込み（ボタン選択 / **ドラッグ&ドロップ**）
- パン（ドラッグ）・ズーム（ホイール）・全体表示（フィット）
- **レイヤ別の表示ON/OFF**（レイヤパネル。色スウォッチ・件数つき）
- レイヤ色 / エンティティ色（TrueColor・ACI）での描画
- 白背景 / 黒背景の切替（ACI 7=前景色は背景に応じて黒/白で描画）
- **印刷**（表示中の図面をA4横・白背景・高解像度でレンダリングして印刷）

## インストール（未パッケージ拡張として読み込み）
1. Chromeで `chrome://extensions` を開く
2. 右上の「デベロッパーモード」をON
3. 「パッケージ化されていない拡張機能を読み込む」→ この `dwg_viewer` フォルダを選択
4. ツールバーの拡張アイコンをクリック → 専用タブでビューアが開く

## 使い方
1. 「DWGを開く」でファイルを選択、または画面にDWGをドラッグ&ドロップ
2. ドラッグでパン、ホイールでズーム、「全体表示」でフィット
3. 「レイヤ」ボタンでレイヤパネルを開閉。各レイヤの表示ON/OFFを切替
4. 「印刷」で現在表示している図面を印刷（A4横）

## 対応エンティティ
LINE / CIRCLE / ARC / ELLIPSE / LWPOLYLINE / POLYLINE（bulge対応）/ POINT /
TEXT / MTEXT / ATTRIB / ATTDEF（幅係数・整列・縦書き対応）/ SPLINE（折れ線近似）/
SOLID / 3DFACE / DIMENSION（寸法：匿名ブロックの計算済み幾何を展開して描画）。
未対応エンティティ（INSERT・HATCH等）は件数のみ画面下に表示。

## 構成
```
dwg_viewer/
  manifest.json        … MV3。アイコンクリックでviewerタブを開く
  background.js        … action.onClicked → タブ生成
  viewer.html / .css   … UI（ドロップゾーン・レイヤパネル・印刷ボタン）
  viewer.js            … 描画・レイヤ管理・パン/ズーム・D&D・印刷（解析はsandboxへ委譲）
  sandbox.html / .js   … WASM解析を隔離実行（unsafe-eval許可ページ）
  vendor/
    dist/libredwg-web.js   … 高レベルAPI（ESM）
    wasm/libredwg-web.js   … Emscriptenローダ
    wasm/libredwg-web.wasm … LibreDWG本体（約6MB）
  tests/               … Playwright（MV3拡張をロードして検証）
  test_data/           … サンプルDWG（リポジトリには含めていません。テスト実行時に各自配置）
```

## アーキテクチャ（なぜsandboxを使うか）
libredwg-web は実行時に WASM(embind) が `eval` を使うため、MV3の通常拡張ページ
（`unsafe-eval` 不可）では動きません。そこで解析だけを **sandboxページ(iframe)** に隔離し、
親へは「数値・文字列だけの描画プリミティブ」を postMessage で返します
（描画・UIは通常ページ側）。WASMモジュール再利用で2回目以降の解析が失敗する問題を避けるため、
**解析ごとに専用iframeを生成し、終了後に破棄**します。

## テスト
```
npm install
npx playwright install chromium
npm test
```
- 拡張ロード・UI表示
- sandbox+WASM の初期化と解析RPCの往復
- 実DWG（`test_data/TB3Y.dwg`）の解析 → 図形・レイヤ・色の抽出検証

> 注: Canvas2Dの実描画を伴うテストは、ヘッドレス環境（WSL2等でGPUラスタライズが
> 使えない場合）では `fillRect` でレンダラが停止するため自動的に **skip** されます。
> 実ブラウザでは正常に描画されます。

## 既知の制限
- ブロック(INSERT)は未展開のため非表示（未対応として件数のみ表示）。以前は挿入点に枠＋ブロック名を描いていたが、実在しない図形に見えるため廃止。
- SPLINE はフィット点／制御点を結ぶ折れ線近似（真のNURBS評価ではない）。
- OCS/押し出し方向は未考慮（通常の平面図 Z上向き前提）。
- 寸法(DIMENSION)は匿名ブロックの計算済み幾何を展開して描画（線・矢印・寸法値）。ブロックを持たない寸法は未描画。
- テキストはSHXフォントを sans-serif で代替するため、AutoCADと字形・サイズが厳密には一致しない。
- HATCH・MLINE 等は未描画（件数は画面下に表示）。
- libredwg の限界により一部のDWG（独自オブジェクト等）は開けない場合があります。

ライセンス注意：libredwg-web は GPL-3.0。再配布時は条件に従ってください。
