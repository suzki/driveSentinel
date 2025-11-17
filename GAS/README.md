# Drive Sentinel

**Drive Sentinel** は、Google Driveにアップロードされたファイル（PDFや画像）を、Google CloudのVertex AI (Gemini) を利用して自動的に分類し、Discordに通知を送信するシステムです。手動でのファイル整理の手間を大幅に削減することを目的としています。

## ✨ 主な機能

- **AIによる自動分類**: Vertex AIの強力なマルチモーダルモデル (`gemini-2.0-pro`) を使用し、ファイルの内容を直接解析してカテゴリを判断します。
- **AIによるファイル名提案**: AIがファイル内容を要約し、`YYYY-MM-DD_内容の要約.拡張子` のような分かりやすいファイル名を自動で生成・提案します。
- **Discord連携**: 分類結果と承認ボタンをDiscordに通知し、ワンクリックでファイルのリネームと移動を実行できます。（※Discord Bot側の実装が必要です）
- **サーバーレス運用**: Google Apps Script (GAS) の時間ベースのトリガーで動作するため、追加のサーバーは不要です。
- **ローカルテスト環境**: Node.jsを使用して、GASにデプロイする前にAIの分類ロジックをローカルで迅速にテストできます。

## ⚙️ アーキテクチャ

```mermaid
graph TD
    subgraph "Google Cloud"
        GD[/"Google Drive<br/>(ファイルアップロード)"/] -- ファイルを検知 --> GAS[Google Apps Script<br/>(定時実行トリガー)]
        GAS -- 内容を解析 --> VertexAI[Vertex AI<br/>(Gemini 2.0 Pro)]
    end

    subgraph "通知 & 承認フロー"
        GAS -- 分類結果を通知 --> Discord[Discord<br/>(ユーザーへの通知)]
        Discord -- ユーザー操作<br/>(承認/却下) --> BotAPI[Discord Bot API<br/>(承認・却下処理)]
    end
```

## 🚀 セットアップガイド

### 1. 前提条件

- Googleアカウント
- 課金が有効になっているGoogle Cloud Platform (GCP) アカウント
- Node.js (ローカルでのテストに必要)
- ファイルの承認・リネーム処理を行うための自作のDiscord Bot APIエンドポイント

### 2. Google Cloud (GCP) の設定

1.  GCPコンソールで新規プロジェクトを作成するか、既存のプロジェクトを選択します。
2.  **プロジェクトID**をメモしておきます。
3.  **[APIとサービス] > [ライブラリ]** で、以下の2つのAPIを有効化します。
    - `Vertex AI API`
    - `Cloud Resource Manager API`

### 3. Google Driveの準備

1.  Google Driveで、アップロードされたファイルを一時的に受け取るためのフォルダ（例: `Inbox`）を作成します。
2.  作成したフォルダを開き、ブラウザのアドレスバーから**フォルダID**をコピーします。（`.../folders/` の後に続く文字列）

### 4. Google Apps Script (GAS) の設定

1.  Google Apps Scriptにアクセスし、新しいプロジェクトを作成します。
2.  `gcp/GAS/` ディレクトリにある以下のファイルの内容を、GASエディタにコピー＆ペーストします。
    - `drive_sentinel_file_watcher.gs`
    - `ai_classifier.gs` (新しいファイルとして作成)
3.  GASエディタの **[プロジェクトの設定] > [マニフェスト ファイル「appsscript.json」をエディタで表示する]** にチェックを入れ、`gcp/GAS/appsscript.json` の内容を貼り付けます。
4.  **[プロジェクトの設定]** に戻り、「GCPプロジェクト」セクションで **[プロジェクトを変更]** をクリックし、ステップ2でメモした**GCPプロジェクト番号**（IDではない）を入力して紐付けます。
5.  同じく **[プロジェクトの設定]** 内の **[スクリプト プロパティ]** に、以下のキーと値を設定します。

| プロパティ（キー） | 値の例 | 説明 |
| :--- | :--- | :--- |
| `INBOX_FOLDER_ID` | `1a2b3c4d5e6f7g8h9i0j` | ステップ3で準備したDriveフォルダのID。 |
| `GCP_PROJECT_ID` | `your-gcp-project-id` | ステップ2でメモしたGCPプロジェクトのID。 |
| `GCP_LOCATION` | `us-central1` | Vertex AIのリージョン。 |
| `BOT_API_URL` | `https://your-bot.example.com/api/approve` | 自作のDiscord BotのAPIエンドポイントURL。 |
| `GAS_API_KEY` | `your_secret_api_key` | Bot APIを保護するためのシークレットキー。 |

### 5. 権限の承認とトリガーの設定

1.  GASエディタ上部で、実行する関数として `checkNewFilesAndNotify` を選択し、**[実行]** ボタンを押します。
2.  承認要求のポップアップが表示されるので、画面の指示に従ってGoogleアカウントを選択し、すべての権限を許可します。（「安全ではない」という警告が表示された場合は、[詳細] > [（プロジェクト名）に移動] をクリックしてください）
3.  GASエディタの左メニューから **[トリガー]** を開き、「トリガーを追加」をクリックして以下のように設定します。
    - **実行する関数**: `checkNewFilesAndNotify`
    - **イベントのソース**: `時間主導型`
    - **時間ベースのタイマー**: `5分おき` （または任意の間隔）

以上で、設定した間隔で自動的にファイルが分類・通知されるようになります。

## 🧪 ローカルでのテスト方法

AIのプロンプトやカテゴリを修正した際に、素早く動作確認するためのテスト環境です。

1.  ターミナルでプロジェクトのルートディレクトリに移動します。

    ```bash
    cd c:\code\docsentinel
    ```

2.  必要なライブラリをインストールします。

    ```bash
    npm install @google-cloud/vertexai
    ```

3.  `gcp/src/test_runner.js` を実行します。

    ```bash
    node gcp/src/test_runner.js
    ```

    `test_runner.js` は `test_files` ディレクトリ内のファイルを読み込み、`gcp/src/ai_classifier.js` を使ってカテゴリ分類の結果と提案されたファイル名をコンソールに出力します。

    **※注意:** ローカルでテストを実行するには、`gcloud auth application-default login` コマンドを実行して、GCPへの認証を済ませておく必要があります。

## 📁 ファイル構成

```
docsentinel/
├── gcp/
│   ├── GAS/  (Google Apps Script用コード)
│   │   ├── drive_sentinel_file_watcher.gs  # メインロジック、トリガー関数
│   │   ├── ai_classifier.gs                # Vertex AI 分類ロジック (GAS版)
│   │   └── appsscript.json                 # GASマニフェストファイル
│   │
│   ├── src/  (Node.js ローカルテスト用コード)
│   │   ├── ai_classifier.js                # Vertex AI 分類ロジック (Node.js版)
│   │   └── test_runner.js                  # ローカルテスト実行スクリプト
│   │
│   └── test_files/ (テスト用のサンプルファイル)
│       └── sample.pdf
│
├── .gitignore
└── README.md
```