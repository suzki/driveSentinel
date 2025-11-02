# Drive Sentinel (DS) Project: Cloud Run Dockerfile
# Node.js 20を使用
FROM node:20-slim

# アプリケーションディレクトリの作成
WORKDIR /usr/src/app

# パッケージ定義ファイルのコピーと依存関係のインストール
COPY package*.json ./
RUN npm install --omit=dev

# アプリケーションのソースコードのコピー
COPY . .

# Cloud Runがリッスンするポートを指定
EXPOSE 8080

# アプリケーションの実行コマンド
CMD [ "npm", "start" ]
