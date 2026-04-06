# Obsidian System Recording

macOSのシステム音声（Zoom / Google Meet / Teams等）とマイク音声を録音し、M4A(AAC)ファイルとしてVault内に保存するObsidianプラグイン。

## Requirements

- macOS 13.0+
- Obsidian Desktop

## Features

- ScreenCaptureKitによるシステム音声キャプチャ（追加ドライバ不要）
- マイク音声との同時録音
- リボンボタン / コマンドパレットから操作
- 録音中はステータスバーに経過時間を表示
- 録音完了時に現在のノートへ自動リンク挿入

## Installation

1. Releases から最新版をダウンロード
2. `main.js`, `manifest.json`, `styles.css`, `system-recorder` を Vault の `.obsidian/plugins/system-recording/` に配置
3. Obsidian の設定 → Community plugins → System Recording を有効化
4. 初回の録音開始時に「画面収録」と「マイク」の権限許可ダイアログが表示されます

## Usage

- 左サイドバーのマイクアイコンをクリックして録音開始/停止
- コマンドパレット (`Cmd+P`) → "Start recording" / "Stop recording"

## Settings

- **Recording folder**: 録音ファイルの保存先フォルダ（デフォルト: `recordings/`）
- **File name template**: ファイル名テンプレート（デフォルト: `recording-YYYY-MM-DD-HHmm`）

## Development

```bash
# Install dependencies
npm install

# Build Swift helper
cd swift-helper && swift build -c release && cd ..
cp swift-helper/.build/release/SystemRecorder system-recorder

# Build plugin (dev mode with watch)
npm run dev

# Build plugin (production)
npm run build
```
