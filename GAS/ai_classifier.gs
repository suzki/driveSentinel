/**
 * @fileoverview Google Apps Script module for file classification using Vertex AI Gemini.
 * This module is designed to be used within the Google Apps Script environment.
 */

/**
 * Classifies a file from Google Drive using the Gemini Vision model via Vertex AI API.
 *
 * @param {GoogleAppsScript.Drive.File} file The file object from DriveApp.
 * @param {object} options Configuration options.
 * @param {string} options.projectId Your Google Cloud Project ID.
 * @param {string} options.location The GCP location for the Vertex AI endpoint (e.g., 'us-central1').
 * @returns {string} The classified category name (e.g., "請求書・領収書", "手動レビュー").
 */
function classifyFileWithGemini_GAS(file, options) {
  const { projectId, location } = options;

  if (!projectId || !location) {
    Logger.log("ERROR in classifyFileWithGemini_GAS: projectId and location must be provided.");
    return "手動レビュー (設定エラー)";
  }

  const mimeType = file.getMimeType();
  const supportedMimeTypes = [
      MimeType.PDF, MimeType.PNG, MimeType.JPEG, MimeType.GIF, MimeType.BMP, MimeType.WEBP
  ];

  if (!supportedMimeTypes.includes(mimeType)) {
    Logger.log(`Unsupported MIME type: ${mimeType} for file: ${file.getName()}`);
    return "手動レビュー (非対応ファイル)";
  }

  const fileBlob = file.getBlob();
  const fileBytes = fileBlob.getBytes();
  const fileBase64 = Utilities.base64Encode(fileBytes);

  const categories = [
    "学校・教育", "請求書・領収書", "マニュアル・保証書", "公共料金",
    "税金・公的書類", "金融・保険", "医療・健康", "仕事関連", "チラシ・広告", "その他"
  ];

  const prompt = `# 指示
あなたはドキュメント分類アシスタントです。
添付されたドキュメントの内容を分析し、以下の「カテゴリリスト」から最も適切なカテゴリを1つだけ選び、そのカテゴリ名を**完全に一致する形**で回答してください。

# カテゴリリスト
- ${categories.join("\n- ")}

# 制約
- 必ず「カテゴリリスト」の中から1つを選んでください。
- 回答はカテゴリ名のみとし、他の説明や言葉は一切含めないでください。
- リストにない単語や、リストの単語を省略した形（例：「税」）で回答してはいけません。
- 判断が難しい場合は「その他」と回答してください。

# 回答`;

  // ご指定の最新モデルを使用
  const modelName = 'gemini-2.0-pro';

  const apiEndpoint = `https://${location}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${location}/publishers/google/models/${modelName}:streamGenerateContent`;

  const requestPayload = {
    contents: [
      {
        role: 'user',
        parts: [
          { inlineData: { mimeType: mimeType, data: fileBase64 } },
          { text: prompt },
        ],
      },
    ],
  };

  const fetchOptions = {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'Authorization': 'Bearer ' + ScriptApp.getOAuthToken()
    },
    payload: JSON.stringify(requestPayload),
    muteHttpExceptions: true
  };

  try {
    const response = UrlFetchApp.fetch(apiEndpoint, fetchOptions);
    const responseCode = response.getResponseCode();
    const responseBody = response.getContentText();

    if (responseCode !== 200) {
      Logger.log(`Vertex AI API Error (HTTP ${responseCode}): ${responseBody}`);
      return "手動レビュー (APIエラー)";
    }

    const jsonResponse = JSON.parse(responseBody);
    // streamGenerateContentは配列で返ってくる
    const candidate = jsonResponse[0].candidates[0];
    const category = candidate.content.parts[0].text.trim();

    if (categories.includes(category)) {
      return category;
    } else {
      Logger.log(`[AI WARNING] Model returned an unknown category: "${category}".`);
      return "手動レビュー";
    }
  } catch (err) {
    Logger.log(`[FATAL ERROR] Failed to call Vertex AI API. Error: ${err.message}`);
    return "手動レビュー (GASエラー)";
  }
}