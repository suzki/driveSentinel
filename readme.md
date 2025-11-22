# システム仕様書: Drive Sentinel

## 1. 概要

Drive Sentinelは、Google Driveにアップロードされたファイルを自動的に分類し、Discord上での簡単な承認操作で指定のフォルダに整理するシステムです。請求書、領収書、契約書などのドキュメントを、AIによる内容解析とリネーム提案を経て、手間なくファイリングすることを目的とします。

## 2. システム構成図

```mermaid
sequenceDiagram
    actor User
    participant GDrive as Google Drive<br>(Inbox)
    participant GAS_Watcher as GAS (File Watcher)
    participant VertexAI as Vertex AI<br>(Gemini)
    participant Bot as Discord Bot<br>(Cloud Run)
    participant Discord
    participant GAS_Handler as GAS (Submit Handler)
    participant GDrive_Dest as Google Drive<br>(Destination)

    User->>GDrive: ファイルをアップロード
    GAS_Watcher->>GDrive: 定期的に新着ファイルをチェック
    GAS_Watcher->>VertexAI: ファイルを送信し、分類とファイル名提案を依頼
    VertexAI-->>GAS_Watcher: 分類カテゴリと提案ファイル名を返す
    GAS_Watcher->>Bot: ファイル情報、カテゴリ、新ファイル名案を通知 (POST /notify)
    Bot->>Discord: 「承認」ボタン付きメッセージを投稿
    User->>Discord: 「承認」ボタンをクリック
    Discord->>Bot: ボタン操作を通知 (POST /)
    Bot->>GAS_Handler: ファイルID、カテゴリ、新ファイル名をPOST
    GAS_Handler->>GDrive: ファイル名を変更
    GAS_Handler->>GDrive_Dest: ファイルを対応するカテゴリフォルダへ移動
    GAS_Handler-->>Bot: 処理完了を報告
    Bot->>Discord: 元のメッセージを「整理完了」に更新
```

## 3. 主要機能

*   **ファイル自動監視:** 指定されたGoogle Driveフォルダを定期的に監視し、新しいファイルを自動で検知します。
*   **AIによる自動分類とリネーム:**
    *   **AI分類:** Vertex AI (Gemini) のマルチモーダル機能を利用し、PDFや画像ファイルの内容を直接解析して、最適なカテゴリを推測します。
    *   **AIによるファイル名提案:** AIがファイル内容を分析し、`YYYY-MM-DD_内容の要約.拡張子` のような、日付と内容に基づいた分かりやすいファイル名を自動で生成・提案します。
*   **Discordによる承認ワークフロー:** 分類結果と提案ファイル名をDiscordに通知します。ユーザーは「承認」ボタンをクリックするだけで、ファイルの整理を実行できます。
*   **自動リネームとフォルダ移動:** 承認されると、ファイルはAIによって提案された名前にリネームされ、指定されたカテゴリのフォルダへ自動的に移動します。

## 4. コンポーネント詳細

### 4.1. Google Apps Script (GAS)

#### a. `drive_sentinel_file_watcher.gs`
時間ベースのトリガーで定期実行されるスクリプトです。

*   **役割:** 受信トレイフォルダを監視し、新着ファイルの分類とDiscordへの通知を行います。
*   **処理フロー:**
    1.  新着ファイルを検知します。
    2.  `classifyFileWithGemini_GAS`関数を呼び出し、ファイル（PDF、画像など）をVertex AI (Gemini)に送信します。
    3.  Vertex AIがファイル内容を解析し、①分類カテゴリ と ②新しいファイル名 を返します。
    4.  AIからの分類結果とファイル名提案を元に、最終的なファイル名を決定します。
    5.  `sendDiscordNotification`関数で、Discord Botの`/notify`エンドポイントに処理結果をPOSTします。

#### b. `drive_sentinel_submit_handler.gs`
Webアプリとしてデプロイされ、Discord Botからのリクエストを受け付けます。

*   **役割:** 承認されたファイルの移動とリネーム処理を実行します。
*   **処理フロー:**
    1.  `doPost`関数で、BotからのPOSTリクエスト（`fileId`, `folderName`, `newFileName`）を受け取ります。
    2.  `getOrCreateFolder`関数で、指定されたカテゴリ名のフォルダがなければ作成します。
    3.  ファイルIDを元にファイルを取得し、指定された新しいファイル名にリネームします。
    4.  ファイルをカテゴリフォルダに移動します。
    5.  Botに成功メッセージを返します。

### 4.2. Discord Bot (Node.js on Cloud Run)

`app.js`として実装され、サーバーレスコンテナ環境（Cloud Run）で稼働します。

*   **役割:** GASとDiscordの間のインタラクションを仲介します。
*   **エンドポイント:**
    *   `POST /notify`: GASからのファイル分類結果を受け取ります。APIキーでリクエストを認証し、ボタン付きのEmbedメッセージをDiscordに投稿します。
    *   `POST /`: Discordからのボタンインタラクションを受け取ります。公開鍵でリクエストを検証し、承認/拒否の処理を振り分けます。
        *   **承認時:** GASのSubmit Handler (`doPost`) にファイル整理を依頼し、GASからの応答に応じて元のDiscordメッセージを更新します。
        *   **拒否時:** 元のDiscordメッセージを「拒否されました」に更新し、ボタンを無効化します。

## 5. 設定項目

### 5.1. GAS スクリプトプロパティ

| キー                           | 説明                                                               |
| ------------------------------ | ------------------------------------------------------------------ |
| `INBOX_FOLDER_ID`              | 監視対象のGoogle DriveフォルダのID。                               |
| `DESTINATION_ROOT_FOLDER_ID`   | 分類済みファイルを保存する親フォルダのID。                         |
| `GCP_PROJECT_ID`               | Vertex AI (Gemini) を使用するためのGCPプロジェクトID。            |
| `GCP_LOCATION`                 | Vertex AIのエンドポイントリージョン (例: `us-central1`)。          |
| `BOT_API_URL`                  | Discord Bot (Cloud Run) の `/notify` エンドポイントのURL。         |
| `GAS_API_KEY`                  | Botへのリクエストを認証するための共有APIキー。                     |

### 5.2. Discord Bot 環境変数 (Cloud Run)

| 環境変数                         | 説明                                                               |
| -------------------------------- | ------------------------------------------------------------------ |
| `DISCORD_PUBLIC_KEY`             | Discordアプリケーションの公開鍵。                                  |
| `GAS_WEBAPP_URL`                 | GAS Submit HandlerのWebアプリURL。                                 |
| `DISCORD_APPLICATION_ID`         | DiscordアプリケーションのID。                                      |
| `DISCORD_BOT_TOKEN`              | Discord Botのトークン。                                            |
| `DISCORD_CHANNEL_ID`             | 通知を送信するDiscordチャンネルのID。                              |
| `GAS_API_KEY`                    | GASからのリクエストを認証するための共有APIキー。                   |
