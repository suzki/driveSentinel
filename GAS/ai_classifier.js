const { VertexAI } = require('@google-cloud/vertexai');
const fs = require('fs');
const path = require('path');

// --- Helper Functions ---
const MimeTypes = {
    '.pdf': 'application/pdf',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.bmp': 'image/bmp',
    '.webp': 'image/webp',
};

function getMimeType(filePath) {
    return MimeTypes[path.extname(filePath).toLowerCase()] || null;
}

/**
 * ファイルパスを受け取り、Geminiで直接分類する
 * @param {string} filePath - 分類するファイルのパス
 * @param {object} options - 設定オプション
 * @param {string} options.projectId - Google CloudプロジェクトID
 * @param {string} options.location - Vertex AIのロケーション (例: 'us-central1')
 * @returns {Promise<string>} 分類されたカテゴリ名
 */
async function classifyFileWithGemini(filePath, options) {
    const { projectId, location } = options;

    if (!projectId || !location) {
        throw new Error("projectId and location must be provided.");
    }

    const mimeType = getMimeType(filePath);
    if (!mimeType) {
        // サポートされていないファイルタイプの場合は専用のカテゴリを返す
        return "手動レビュー (非対応ファイル)";
    }

    // Vertex AIクライアントを初期化
    const vertex_ai = new VertexAI({ project: projectId, location: location });
    const model = 'gemini-1.0-pro-vision'; // 安定したモデルバージョンを指定

    const generativeModel = vertex_ai.getGenerativeModel({ model });

    const fileContent = fs.readFileSync(filePath).toString('base64');

    const categories = [
        "学校・教育", "請求書・領収書", "マニュアル・保証書", "公共料金",
        "税金・公的書類", "金融・保険", "医療・健康", "仕事関連", "チラシ・広告", "その他"
    ];

    const prompt = `
このドキュメント（画像またはPDF）の内容を分析し、最も適切だと思われるカテゴリを下記のリストから1つだけ選んでください。
リストにないカテゴリは使用しないでください。判断が難しい場合は「その他」と回答してください。
回答はカテゴリ名のみで、他の言葉は含めないでください。

カテゴリリスト:
${categories.join(", ")}

---
カテゴリ:
`;

    const request = {
        contents: [
            {
                role: 'user',
                parts: [
                    { inlineData: { mimeType: mimeType, data: fileContent } },
                    { text: prompt },
                ],
            },
        ],
    };

    try {
        const streamingResp = await generativeModel.generateContentStream(request);
        const aggregatedResponse = await streamingResp.response;
        
        if (!aggregatedResponse.candidates || aggregatedResponse.candidates.length === 0) {
            throw new Error("Model returned no candidates.");
        }

        const fullTextResponse = aggregatedResponse.candidates[0].content.parts[0].text;
        const category = fullTextResponse.trim();
        
        // モデルがリスト内のカテゴリを返したか検証
        if (categories.includes(category)) {
            return category;
        } else {
            console.warn(`  [AI WARNING] Model returned an unknown category: "${category}".`);
            return "手動レビュー"; // 不明なカテゴリは手動レビューへ
        }
    } catch (err) {
        console.error(`  [AI ERROR] Failed to classify file with Gemini.`, err);
        return "手動レビュー (エラー)"; // APIエラー時
    }
}

module.exports = { classifyFileWithGemini };