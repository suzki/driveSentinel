# デプロイ手順 (Cloud Run)

## 前提

- `gcloud` と `docker` がインストール済みで、`gcloud auth login` と `gcloud auth configure-docker` が済んでいること。
- デプロイ用のサービスアカウントは最小限の権限を付与し、可能であれば Workload Identity を利用すること。
- 機微な値（`DISCORD_BOT_TOKEN`、`GAS_API_KEY` など）は GCP Secret Manager に保存して Cloud Run に注入する運用を推奨します。

## テンプレートの使い方

- リポジトリには `discord-bot/deploy_cloud_run.template.ps1` が含まれています。実動用に値を埋めたスクリプトをコミットしないでください。
- ローカルでデプロイする場合はテンプレートをコピーして `discord-bot/deploy_cloud_run.ps1` とし、ローカル環境変数や Secret Manager を利用して値を注入してください。

## ローカル (PowerShell) での簡単な手順例

1) 環境変数を設定（ローカルで一時的に設定する例）:

```powershell
# 実運用では Secret Manager を使い、このように平文で保存しないでください
$env:GCP_PROJECT_ID = 'your-gcp-project-id'
$env:REGION = 'asia-northeast1'
$env:IMAGE = "gcr.io/$($env:GCP_PROJECT_ID)/discord-bot:latest"
```

2) イメージをビルドして Container Registry / Artifact Registry に push:

```powershell
docker build -t $env:IMAGE ./discord-bot
docker push $env:IMAGE
# または Artifact Registry を使う場合のタグ付けと push を行ってください
```

3) Secret Manager にトークン等を登録（例）:

```powershell
# Secret 作成
gcloud secrets create discord-bot-token --project $env:GCP_PROJECT_ID --replication-policy="automatic"
# Secret に値を追加 (PowerShell ではエコーの違いに注意)
echo -n "YOUR_DISCORD_BOT_TOKEN" | gcloud secrets versions add discord-bot-token --project $env:GCP_PROJECT_ID --data-file=-
```

4) Cloud Run にデプロイ（Secret を環境変数としてマウント）:

```powershell
gcloud run deploy discord-bot `
  --image $env:IMAGE `
  --project $env:GCP_PROJECT_ID `
  --region $env:REGION `
  --platform managed `
  --allow-unauthenticated `
  --memory 512Mi `
  --set-secrets DISCORD_BOT_TOKEN=projects/$env:GCP_PROJECT_ID/secrets/discord-bot-token:latest
```

注: `--set-secrets` を使えるように gcloud のバージョンや権限を確認してください。

## CI でのデプロイ（概略）

- CI (GitHub Actions / Cloud Build 等) のシークレット機能と GCP Secret Manager を組み合わせます。
- CI ではサービスアカウントに必要な権限を付与し、Artifact Registry への push と Cloud Run への deploy を実行します。
- 実環境用のスクリプトは `discord-bot/deploy_cloud_run.template.ps1` を元に CI 内でパラメータ化して使うか、gcloud コマンドを直接 CI ステップに記述してください。

## テンプレート運用のおすすめワークフロー

1. `discord-bot/deploy_cloud_run.template.ps1` をリポジトリにコミット（このテンプレートは秘密情報を含まない）。
2. ローカルや CI でテンプレートをコピーして `deploy_cloud_run.ps1` を作り、機微情報は Secret Manager / CI シークレットで注入する。
3. `.gitignore` で `deploy_cloud_run.ps1` を無視して誤コミットを防ぐ（本リポジトリは既にそのルールを設定済み）。

---

以上。必要なら GitHub Actions の具体的例も作ります。
