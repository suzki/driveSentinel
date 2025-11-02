// Drive Sentinel (DS) Project: Cloud Run Serverless Command Handler
const express = require('express');
const axios = require('axios');
const { verifyKeyMiddleware } = require('discord-interactions'); // Discordリクエスト検証用
const { ApplicationCommandOptionType } = require('discord.js');

// --- DS Configuration ---
// 環境変数から設定を読み込む (Cloud Runの環境変数として設定します)
const PUBLIC_KEY = process.env.DISCORD_PUBLIC_KEY; // Discord Developer Portalで取得
const GAS_WEBAPP_URL = process.env.DISCORD_GAS_SUBMIT_HANDLER_URL || process.env.GAS_WEBAPP_URL; // GAS WebアプリのURL
const APPLICATION_ID = process.env.DISCORD_APPLICATION_ID; // DiscordアプリケーションID
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN; // Discord Botのトークン (メッセージ編集に使用)
const DISCORD_CHANNEL_ID = process.env.DISCORD_CHANNEL_ID; // 通知を送信するDiscordチャンネルID
const GAS_API_KEY = process.env.GAS_API_KEY; // GASからのリクエストを検証するためのAPIキー

const app = express();
const port = process.env.PORT || 8080; // Cloud RunはPORT環境変数で指定されたポートをリッスンする必要があります

// JSONパーサーを適用（全エンドポイントで使用）
app.use(express.json());

// ヘルスチェックエンドポイント（GETリクエスト用）
app.get('/', (req, res) => {
    res.status(200).json({ 
        status: 'ok', 
        service: 'Drive Sentinel Bot',
        endpoints: ['/notify (POST)']
    });
});

// GASからの通知を受け取るエンドポイント（verifyKeyMiddlewareの前に定義）
app.post('/notify', async (req, res) => {
    // APIキーで認証（シンプルな保護）
    const apiKey = req.headers['x-api-key'];
    if (!GAS_API_KEY || apiKey !== GAS_API_KEY) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
        const { title, description, fileName, fileId, category, newFileName } = req.body;

        // ★★★ デバッグ用ログを追加 ★★★
        console.log('Received request on /notify:', JSON.stringify(req.body, null, 2)); // newFileNameが含まれているか確認

        if (!fileId || !category) {
            return res.status(400).json({ error: 'Missing required fields: fileId, category' });
        }

        // ボタンのカスタムIDをシンプルに変更
        const approveId = `DS_APPROVE`;
        const rejectId = `DS_REJECT`;

        // Discord APIを使ってボタン付きメッセージを送信
        const discordPayload = {
            embeds: [{
                title: title || "New File Ready for Approval",
                description: description || `File classified as **${category}**. Please click the button to approve.`,
                color: category === "Manual Review" ? 16750848 : 3447003, // Orange for warning, Blue for success
                fields: [
                    { name: "File Name", value: fileName || "Unknown", inline: true },
                    { name: "Predicted Category", value: category, inline: true },
                    { name: "New File Name", value: newFileName || fileName, inline: false }, // 新しいファイル名を表示
                    { name: "Google Drive Link", value: `[Open File](https://drive.google.com/file/d/${fileId}/view)`, inline: false }
                ],
                footer: { // footerにfileIdを確実に格納
                    text: `Processed by DS | File ID: ${fileId}`
                },
                timestamp: new Date().toISOString()
            }],
            components: [{
                type: 1, // Action Row
                components: [
                    {
                        type: 2, // Button
                        style: 3, // Success (Green)
                        label: "承認 (Approve)",
                        custom_id: approveId
                    },
                    {
                        type: 2, // Button
                        style: 4, // Danger (Red)
                        label: "拒否 (Reject)",
                        custom_id: rejectId
                    }
                ]
            }]
        };

        const discordResponse = await axios.post(
            `https://discord.com/api/v10/channels/${DISCORD_CHANNEL_ID}/messages`,
            discordPayload,
            {
                headers: {
                    'Authorization': `Bot ${BOT_TOKEN}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        res.status(200).json({ 
            success: true, 
            messageId: discordResponse.data.id 
        });

    } catch (error) {
        console.error('Discord notification error:', error.response?.data || error.message);
        res.status(500).json({ 
            error: 'Failed to send Discord notification',
            details: error.message 
        });
    }
});

// 2. メインのインタラクションエンドポイント
// Discordからのリクエストを検証するミドルウェアをこのエンドポイントに直接適用
app.post('/', verifyKeyMiddleware(PUBLIC_KEY), async (req, res) => {
    const interaction = req.body;

    // DiscordからのPINGリクエストへの応答
    if (interaction.type === 1) { // PING
        return res.send({ type: 1 });
    }

    // スラッシュコマンド処理
    if (interaction.type === 2) { // APPLICATION_COMMAND
        const { name } = interaction.data;

        if (name === 'approve') {
            const options = interaction.data.options;
            // オプションからファイルIDとフォルダ名を取得
            const fileId = options.find(opt => opt.name === 'fileid').value;
            const folderName = options.find(opt => opt.name === 'folder').value;

            // 即座に応答し、GASへの処理を非同期で行う (Deferred Response)
            res.send({ 
                type: 5, // DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE
                data: {
                    content: `✅ 承認リクエストを受信しました。ファイルID: \`${fileId}\` をフォルダ: \`${folderName}\` へ移動します...`
                }
            });

            // 3. GAS Webアプリへのリクエスト送信 (非同期処理)
            try {
                console.log('Sending to GAS:', {
                    fileId: fileId,
                    fileIdType: typeof fileId,
                    fileIdLength: fileId?.length,
                    folderName: folderName
                });
                const gasResponse = await axios.post(GAS_WEBAPP_URL, {
                    fileId: fileId,
                    folderName: folderName
                });

                let responseMessage;
                if (gasResponse.data.includes("Success")) {
                    responseMessage = `[DS] 整理完了: ファイルはフォルダ \`${folderName}\` へ移動されました。`;
                } else {
                    responseMessage = `[DS] 整理エラーが発生しました。GASからの応答: \n\`${gasResponse.data}\``;
                }
                
                // Discordに最終的な結果を通知
                // interaction.tokenを使って、Deferred Responseを更新します
                await axios.patch(`https://discord.com/api/v10/webhooks/${APPLICATION_ID}/${interaction.token}/messages/@original`, {
                    content: responseMessage
                });

            } catch (error) {
                console.error('GAS Request Error:', {
                    message: error.message,
                    status: error.response?.status,
                    data: error.response?.data, // ここにデバッグ情報が含まれます
                    url: error.config?.url
                });
                // エラー時もユーザーに通知
                await axios.patch(`https://discord.com/api/v10/webhooks/${APPLICATION_ID}/${interaction.token}/messages/@original`, {
                    content: `❌ **[DS] 致命的なエラー**\nGASへのリクエスト中に問題が発生しました。\nステータス: ${error.response?.status}\n詳細: ${error.response?.data || error.message}`,
                    embeds: interaction.message.embeds
                });
            }
        }
    }

    // ボタンインタラクション処理 (type 3: MESSAGE_COMPONENT)
    if (interaction.type === 3) { // MESSAGE_COMPONENT
        const customId = interaction.data.custom_id;
        
        // ボタンのcustom_idをパース: APPROVE_ファイルID_カテゴリ名 または REJECT_ファイルID_カテゴリ名
        if (customId === 'DS_APPROVE') {
            // 承認ボタンの処理
            // ★★★★★ 変更点: custom_idからではなく、embedから情報を取得 ★★★★★
            const originalEmbed = interaction.message.embeds[0];
            const footerText = originalEmbed.footer.text; // "Processed by DS | File ID: xxx"
            const categoryField = originalEmbed.fields.find(f => f.name === "Predicted Category");
            const newFileNameField = originalEmbed.fields.find(f => f.name === "New File Name"); // 新しいファイル名を取得

            // 正規表現でfooterからfileIdを安全に抽出
            const fileIdMatch = footerText.match(/File ID: ([\w-]+)/);
            
            if (fileIdMatch && fileIdMatch[1] && categoryField && newFileNameField) {
                const fileId = fileIdMatch[1];

                // ★★★★★ 念のため、抽出したfileIdをログに出力 ★★★★★
                console.log(`Extracted from embed footer - File ID: [${fileId}], Length: ${fileId.length}`);

                const category = categoryField.value;
                const newFileName = newFileNameField.value;
                // 即座に応答 (ボタンを無効化して、処理中であることを示す)
                res.send({ 
                    type: 7, // UPDATE_MESSAGE
                    data: {
                        content: `⏳ 承認処理を実行中です... ファイルID: \`${fileId}\` をフォルダ: \`${category}\` へ移動します。`,
                        components: [] // ボタンを無効化
                    }
                });

                // GAS Webアプリへのリクエスト送信 (非同期処理)
                try {
                    console.log('Sending to GAS:', {
                        fileId: fileId,
                        fileIdType: typeof fileId,
                        fileIdLength: fileId?.length,
                        folderName: category,
                        newFileName: newFileName, // 新しいファイル名をGASに渡す
                        url: GAS_WEBAPP_URL
                    });
                    
                    const gasResponse = await axios.post(GAS_WEBAPP_URL, {
                        fileId: fileId,
                        folderName: category,
                        newFileName: newFileName // 新しいファイル名をGASに渡す
                    });

                    // GASからの応答を詳細にログ出力
                    console.log('GAS Response:', {
                        status: gasResponse.status,
                        statusText: gasResponse.statusText,
                        data: gasResponse.data,
                        dataType: typeof gasResponse.data,
                        dataLength: gasResponse.data?.length
                    });

                    let responseMessage;
                    if (gasResponse.data && gasResponse.data.includes("Success")) {
                        responseMessage = `✅ **[DS] 整理完了**\nファイルはフォルダ \`${category}\` へ移動されました。`;
                    } else {
                        // エラーレスポンスの場合、詳細をログに出力してから表示
                        const errorDetails = gasResponse.data || "No response data";
                        
                        // 詳細なエラー情報をログに出力
                        console.error('GAS returned error response:', {
                            status: gasResponse.status,
                            statusText: gasResponse.statusText,
                            data: errorDetails,
                            dataType: typeof errorDetails,
                            dataLength: typeof errorDetails === 'string' ? errorDetails.length : 'N/A',
                            headers: gasResponse.headers
                        });
                        
                        // デバッグログが長い場合は、Discordメッセージ用に要約
                        // 詳細はCloud Runのログで確認可能
                        let errorPreview;
                        if (typeof errorDetails === 'string') {
                            errorPreview = errorDetails.length > 1500 
                                ? errorDetails.substring(0, 1500) + "\n...(詳細はCloud Runログを確認)"
                                : errorDetails;
                        } else {
                            errorPreview = JSON.stringify(errorDetails, null, 2);
                        }
                        
                        responseMessage = `❌ **[DS] 整理エラー**\nGASからの応答:\n\`\`\`\n${errorPreview}\n\`\`\``;
                    }
                    
                    // 元のメッセージを更新 (interaction tokenを使うため認証不要)
                    await axios.patch(`https://discord.com/api/v10/webhooks/${APPLICATION_ID}/${interaction.token}/messages/@original`, {
                        content: responseMessage,
                        embeds: interaction.message.embeds // 元のembedを保持
                    });

                } catch (error) {
                    console.error('GAS Request Error:', error.message);
                    // エラー時もユーザーに通知
                    await axios.patch(`https://discord.com/api/v10/webhooks/${APPLICATION_ID}/${interaction.token}/messages/@original`, {
                        content: `❌ **[DS] 致命的なエラー**\nGASへのリクエスト中に問題が発生しました。コンソールを確認してください。\nエラー: ${error.message}`,
                        embeds: interaction.message.embeds
                    });
                }
            } else {
                // custom_idの形式が正しくない場合
                res.send({ 
                    type: 4, // CHANNEL_MESSAGE_WITH_SOURCE
                    data: {
                        content: '❌ エラー: ボタンのID形式が正しくありません。',
                        flags: 64 // EPHEMERAL (本人のみに見える)
                    }
                });
            }
        } else if (customId === 'DS_REJECT') {
            // 拒否ボタンの処理 (同様にembedから情報を取得)
            const originalEmbed = interaction.message.embeds[0];
            const footerText = originalEmbed.footer.text;
            const fileIdMatch = footerText.match(/File ID: ([\w-]+)/);

            if (fileIdMatch && fileIdMatch[1]) {
                const fileId = fileIdMatch[1];
                // 即座に応答 (ボタンを無効化)
                res.send({ 
                    type: 7, // UPDATE_MESSAGE
                    data: {
                        content: `🚫 承認が拒否されました。ファイルID: \`${fileId}\` は手動レビューが必要です。`,
                        components: [] // ボタンを無効化
                    }
                });
            }
        }
    }
});

// 404ハンドラー（最後に追加）
app.use((req, res) => {
    res.status(404).json({ 
        error: 'Not Found',
        path: req.path,
        method: req.method
    });
});

app.listen(port, () => {
    console.log(`Cloud Run listening on port ${port}`);
    console.log(`Environment variables check:`);
    console.log(`- PUBLIC_KEY: ${PUBLIC_KEY ? 'SET' : 'NOT SET'}`);
    console.log(`- BOT_TOKEN: ${BOT_TOKEN ? 'SET' : 'NOT SET'}`);
    console.log(`- DISCORD_CHANNEL_ID: ${DISCORD_CHANNEL_ID ? 'SET' : 'NOT SET'}`);
    console.log(`- GAS_API_KEY: ${GAS_API_KEY ? 'SET' : 'NOT SET'}`);
});
