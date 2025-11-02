<#
deploy_cloud_run.template.ps1

Template PowerShell script for building and deploying the discord-bot to Cloud Run.
This template contains NO secrets. Replace placeholders or reference Secret Manager
in your CI/CD or local environment. Do NOT commit real credentials.

Usage (local):
  - Set environment variables locally (preferred: export from secure store / use Secret Manager):
      $env:GCP_PROJECT_ID = 'your-gcp-project'
      $env:REGION = 'asia-northeast1'
      $env:IMAGE = 'gcr.io/your-gcp-project/discord-bot:latest'

  - Build and push (example using Docker and gcloud):
      docker build -t $env:IMAGE .
      docker push $env:IMAGE

  - Deploy to Cloud Run (recommended to use Secret Manager and `--set-secrets`):
      gcloud run deploy discord-bot `
        --image $env:IMAGE `
        --project $env:GCP_PROJECT_ID `
        --region $env:REGION `
        --platform managed `
        --allow-unauthenticated `
        --memory 512Mi

Notes on secrets:
  - Store sensitive values (DISCORD_BOT_TOKEN, GAS_API_KEY, etc.) in Secret Manager.
  - Use `--set-secrets` to bind secrets as environment variables in Cloud Run:
      gcloud run deploy ... --set-secrets DISCORD_BOT_TOKEN=projects/PROJECT/secrets/discord-bot-token:latest

Example of using Secret Manager for an env var mapping:
  gcloud secrets create discord-bot-token --replication-policy="automatic"
  echo -n "YOUR_TOKEN" | gcloud secrets versions add discord-bot-token --data-file=-
  gcloud run deploy discord-bot \
    --image $env:IMAGE \
    --region $env:REGION \
    --project $env:GCP_PROJECT_ID \
    --set-secrets DISCORD_BOT_TOKEN=projects/$env:GCP_PROJECT_ID/secrets/discord-bot-token:latest

If you must pass non-secret values at deploy time, prefer `--update-env-vars` or parameterize
in your CI. Example env vars (non-secret):
  --update-env-vars DISCORD_CHANNEL_ID=123456789,GAS_ENDPOINT=https://script.google.com/...

Security recommendations:
  - Do not hardcode tokens / credentials in this file.
  - Do not commit any service account JSON files to the repo.
  - Use Workload Identity or a minimal service account rather than long-lived keys when possible.

# End of template

#>
