/**
 * @fileoverview Google Apps Script module for file classification using Vertex AI Gemini.
 * This module is designed to be used within the Google Apps Script environment.
 */

/**
 * Classifies a file from Google Drive using the Gemini Vision model via Vertex AI API.
 * This version uses a file ID and UrlFetchApp to work with service account authentication.
 *
 * @param {string} fileId The ID of the file in Google Drive.
 * @param {object} options Configuration options.
 * @param {string} options.projectId Your Google Cloud Project ID.
 * @param {string} options.location The GCP location for the Vertex AI endpoint (e.g., 'us-central1').
 * @param {string} authToken The OAuth2 token for authentication, obtained via the service account.
 * @returns {{category: string, fileName: string}|{category: string, fileName: null}} The classified category and suggested new file name, or a manual review category with a null file name on error.
 */
function classifyFileWithGemini_GAS(fileId, options, authToken) {
  const { projectId, location } = options;
  const manualReviewCategory = "手動レビュー";

  if (!projectId || !location) {
    Logger.log("ERROR in classifyFileWithGemini_GAS: projectId and location must be provided.");
    return { category: `${manualReviewCategory} (設定エラー)`, fileName: null };
  }

  try {
    const driveApiHeaders = { 'Authorization': 'Bearer ' + authToken };
    const driveApiFetchOptions = {
      method: 'get',
      headers: driveApiHeaders,
      muteHttpExceptions: true
    };
    
    // 1. Get file metadata using Drive API v2
    const fileMetadataUrl = `https://www.googleapis.com/drive/v2/files/${fileId}?fields=mimeType,title,downloadUrl,fileSize`;
    const metaResponse = UrlFetchApp.fetch(fileMetadataUrl, driveApiFetchOptions);
    const metaResponseCode = metaResponse.getResponseCode();

    if (metaResponseCode !== 200) {
      Logger.log(`Failed to fetch file metadata for ID ${fileId}. Code: ${metaResponseCode}. Response: ${metaResponse.getContentText()}`);
      return { category: `${manualReviewCategory} (Drive APIエラー)`, fileName: null };
    }
    const fileMetadata = JSON.parse(metaResponse.getContentText());
    const mimeType = fileMetadata.mimeType;
    const originalFileName = fileMetadata.title;
    
    // MimeType Enums are part of DriveApp, so we use strings here.
    const supportedMimeTypes = [ "application/pdf", "image/png", "image/jpeg", "image/gif", "image/bmp", "image/webp" ];
    if (!supportedMimeTypes.includes(mimeType)) {
      Logger.log(`Unsupported MIME type: ${mimeType} for file: ${originalFileName}`);
      return { category: `${manualReviewCategory} (非対応ファイル)`, fileName: null };
    }
    
    // Handle Google Docs, which don't have a downloadUrl and require export. This is complex, so we'll treat them as manual for now.
    if (!fileMetadata.downloadUrl) {
      Logger.log(`File is likely a Google Doc or has no content, which is not directly downloadable. File: ${originalFileName}`);
      return { category: `${manualReviewCategory} (DL不可ファイル)`, fileName: null };
    }

    // 2. Download file content
    const fileContentResponse = UrlFetchApp.fetch(fileMetadata.downloadUrl, driveApiFetchOptions);
    const fileBlob = fileContentResponse.getBlob();
    const fileBytes = fileBlob.getBytes();
    const fileBase64 = Utilities.base64Encode(fileBytes);

    // --- Classification Logic (mostly unchanged) ---
    const categories = [
      "学校・教育", "請求書・領収書", "マニュアル・保証書", "公共料金",
      "税金・公的書類", "金融・保険", "医療・健康", "仕事関連", "チラシ・広告", "その他"
    ];

    const prompt = `# 指示
あなたはドキュメント分類アシスタントです。
添付されたドキュメントの内容を分析し、以下の2つのタスクを実行してください。

1.  **カテゴリ分類**: 以下の「カテゴリリスト」から最も適切なカテゴリを1つ選んでください。
2.  **ファイル名提案**: ドキュメントの内容が分かりやすいように、日本語で20文字以内の新しいファイル名を提案してください。拡張子は含めないでください。

# カテゴリリスト
- ${categories.join("\n- ")}

# 出力形式
以下のJSON形式で回答してください。他の説明や言葉は一切含めないでください。
\`\`\`json
{
  "category": "（ここにカテゴリ名）",
  "fileName": "（ここに提案ファイル名）"
}
\`\`\`

# 制約
- \`category\`には、必ず「カテゴリリスト」の中から1つを選んでください。
- \`fileName\`は、ドキュメントの内容を要約した、分かりやすい日本語のファイル名にしてください。
- 判断が難しい場合は\`category\`を「その他」にしてください。`;

    const modelName = 'gemini-2.5-flash';
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
      "generationConfig": {
        "responseMimeType": "application/json",
      }
    };

    const vertexApiFetchOptions = {
      method: 'post',
      contentType: 'application/json',
      headers: {
        'Authorization': 'Bearer ' + authToken
      },
      payload: JSON.stringify(requestPayload),
      muteHttpExceptions: true
    };

    const response = UrlFetchApp.fetch(apiEndpoint, vertexApiFetchOptions);
    const responseCode = response.getResponseCode();
    const responseBody = response.getContentText();

    if (responseCode !== 200) {
      Logger.log(`Vertex AI API Error (HTTP ${responseCode}): ${responseBody}`);
      return { category: `${manualReviewCategory} (APIエラー)`, fileName: null };
    }

    const jsonResponse = JSON.parse(responseBody);
    const candidate = jsonResponse[0].candidates[0];
    const result = candidate.content.parts[0].text;
    const { category, fileName } = JSON.parse(result);

    if (categories.includes(category) && fileName && typeof fileName === 'string' && fileName.length > 0) {
      return { category, fileName };
    } else {
      Logger.log(`[AI WARNING] Model returned an invalid response: category="${category}", fileName="${fileName}".`);
      return { category: manualReviewCategory, fileName: null };
    }
  } catch (err) {
    Logger.log(`[FATAL ERROR] in classifyFileWithGemini_GAS. Error: ${err.message}. Stack: ${err.stack}`);
    return { category: `${manualReviewCategory} (GASエラー)`, fileName: null };
  }
}