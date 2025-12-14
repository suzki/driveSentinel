// deploy-command.js

// .envファイルから環境変数を読み込む
require('dotenv').config(); 
const { REST, Routes, ApplicationCommandOptionType } = require('discord.js');

// 環境変数から設定を読み込む
const TOKEN = process.env.DISCORD_BOT_TOKEN;
const APPLICATION_ID = process.env.DISCORD_APPLICATION_ID;

if (!TOKEN || !APPLICATION_ID) {
    console.error('エラー: DISCORD_BOT_TOKEN と DISCORD_APPLICATION_ID の両方の環境変数を設定してください。');
    process.exit(1);
}

// コマンドの定義
const commands = [
    {
        name: 'approve',
        description: 'ファイルを指定されたフォルダに承認・移動します。',
        options: [
            {
                name: 'fileid',
                type: ApplicationCommandOptionType.String,
                description: '対象のファイルID',
                required: true,
            },
            {
                name: 'folder',
                type: ApplicationCommandOptionType.String,
                description: '移動先のフォルダ名',
                required: true,
            },
        ],
    },
    {
        name: 'exec',
        description: '手動で受信トレイのファイルチェックを実行します。',
    },
];

// RESTモジュールのインスタンスを作成
const rest = new REST({ version: '10' }).setToken(TOKEN);

// コマンドを登録する非同期関数
(async () => {
    try {
        console.log(`登録するコマンド:`, commands.map(c => c.name).join(', '));
        console.log('アプリケーションの (/) コマンドをリフレッシュしています...');

        // アプリケーションのコマンドを登録 (or 更新)
        // グローバルコマンドとして登録しています。特定のギルドに限定する場合は Routes.applicationGuildCommands(...) を使用します。
        const data = await rest.put(
            Routes.applicationCommands(APPLICATION_ID),
            { body: commands },
        );

        console.log(`正常に ${data.length} 個のアプリケーション (/) コマンドがリロードされました。`);
    } catch (error) {
        console.error('コマンドの登録中にエラーが発生しました:', error);
    }
})();
