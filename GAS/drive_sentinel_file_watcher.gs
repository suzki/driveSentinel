/**
 * Drive Sentinel (DS) File Watcher
 *
 * This script runs on a time-based trigger to check the inbox folder for new files,
 * uses GCP Natural Language API for classification, and sends notifications to Discord via Webhook.
 *
 * Dependencies:
 * - config.js (for constants)
 * - Drive API (V2) Advanced Service
 */

// Script Propertiesから定数を取得するヘルパー関数
function getScriptProperty(key) {
  return PropertiesService.getScriptProperties().getProperty(key);
}


/**
 * Main function executed by the time-based trigger.
 * Checks for new files and initiates the classification and notification process.
 */
function checkNewFilesAndNotify() {
  Logger.log("--- Starting Drive Sentinel Check ---");
  try {
    // DriveAppが未定義の場合の予防策
    if (typeof DriveApp === 'undefined') {
        Logger.log("CRITICAL ERROR: DriveApp is not available.");
        return;
    }

    const INBOX_FOLDER_ID = getScriptProperty('INBOX_FOLDER_ID');
    if (!INBOX_FOLDER_ID) {
      Logger.log("ERROR: INBOX_FOLDER_ID is not set in Script Properties.");
      return;
    }

    const inbox = DriveApp.getFolderById(INBOX_FOLDER_ID);
    const files = inbox.getFiles();
    let fileCount = 0;

    while (files.hasNext()) {
      const file = files.next();
      // Skip files that are already processed or are too small/temporary
      if (file.getSize() === 0 || file.getDescription() === "xDS_PROCESSED_PENDING_APPROVAL") continue; 
      
      processFile(file);
      fileCount++;
      
      // Limit processing per execution to prevent hitting time limits
      if (fileCount >= 10) break;
    }
    
    Logger.log(`--- Finished. Processed ${fileCount} files. ---`);

  } catch (e) {
    Logger.log("Critical error in checkNewFilesAndNotify: " + e.message);
  }
}

/**
 * Processes a single file: extracts text, classifies it, and sends Discord notification.
 * @param {GoogleAppsScript.Drive.File} file The file object to process.
 */
function processFile(file) {
  Logger.log(`Processing file: ${file.getName()} (${file.getId()})`);

  // 1. Gemini Visionを使用してファイルを直接分類
  // この方法はOCRとキーワード分類を置き換えます。
  const GCP_PROJECT_ID = getScriptProperty('GCP_PROJECT_ID');
  const GCP_LOCATION = getScriptProperty('GCP_LOCATION'); // 例: 'us-central1'

  if (!GCP_PROJECT_ID || !GCP_LOCATION) {
      Logger.log("ERROR: GCP_PROJECT_ID or GCP_LOCATION is not set in Script Properties.");
      // エラー時の処理をここに記述
      return;
  }

  Logger.log("Starting AI classification with Gemini Vision...");
  const categoryName = classifyFileWithGemini_GAS(file, { projectId: GCP_PROJECT_ID, location: GCP_LOCATION });


  // ★★★★★ ここから追加 ★★★★★
  // 5. 新しいファイル名を生成 (日付 + カテゴリ)
  let newFileName = file.getName(); // デフォルトは元のファイル名
  if (categoryName !== "手動レビュー") {
    const creationDate = file.getDateCreated();
    const formattedDate = Utilities.formatDate(creationDate, Session.getScriptTimeZone(), "yyyy-MM-dd");
    const extension = newFileName.includes('.') ? `.${newFileName.split('.').pop()}` : '';
    newFileName = `${formattedDate}_${categoryName}${extension}`;
  }
  // ★★★★★ ここまで追加 ★★★★★

  // 2. Send Notification based on result
  if (categoryName && categoryName !== "手動レビュー") {
    Logger.log(`[SUCCESS] Classified as: ${categoryName}`);
    sendDiscordNotification("New File Ready for Approval", `File classified as **${categoryName}**. Please click the button to approve.`, file.getName(), file.getId(), categoryName, newFileName);
    
    // Mark file to prevent re-processing in the next trigger run
    try { file.setDescription("DS_PROCESSED_PENDING_APPROVAL"); } catch (e) { Logger.log("Warning: Could not set file description (permission issue)."); }

  } else {
    Logger.log(`[ERROR] Classification failed or category not mapped for file: ${file.getName()}`);
    // "Manual Review" から "手動レビュー" に変更
    sendDiscordNotification("AI Classification Failed", `Warning: Could not classify document: ${file.getName()}. Reason: ${categoryName}. Manual review needed.`, file.getName(), file.getId(), "手動レビュー", file.getName());
    
    // Mark file as processed (Manual Review)
    try { file.setDescription("DS_PROCESSED_MANUAL_REVIEW"); } catch (e) { Logger.log("Warning: Could not set file description (permission issue)."); }
  }
}

/**
 * Converts file (PDF/Image/Document) to text content.
 * @param {GoogleAppsScript.Drive.File} file The file object.
 * @returns {string | null} The extracted text content or null on error/failure.
 * @deprecated This function is no longer needed when using direct classification with Gemini Vision.
 */
function extractTextFromFile(file) {
  const mimeType = file.getMimeType();
  
  if (mimeType.indexOf('text') > -1 || mimeType.indexOf('document') > -1) {
    // Standard text or Google Doc file
    try {
        return DocumentApp.openById(file.getId()).getBody().getText();
    } catch (e) {
        Logger.log("DocumentApp.openById Error: " + e.message);
        return null;
    }
  }

  // PDFや画像の場合は、一時的にGoogleドキュメントに変換してOCRを実行
  if (mimeType === MimeType.PDF || mimeType.indexOf('image') > -1) {
    if (typeof Drive === 'undefined') {
        Logger.log("CRITICAL ERROR: Drive API (V2) Advanced Service is not enabled.");
        return null; 
    }

    try {
      const ocrFile = Drive.Files.copy(
        { title: 'OCR Temp Document', mimeType: MimeType.GOOGLE_DOCS }, 
        file.getId(), 
        { ocr: true } // OCRを有効にする
      );
      
      const doc = DocumentApp.openById(ocrFile.id);
      const text = doc.getBody().getText();
      Drive.Files.remove(ocrFile.id); // 一時ファイルを削除
      return text;

    } catch (e) {
      Logger.log("OCR Error during Drive.Files.copy/DocumentApp.openById: " + e.message);
      return null;
    }
  }
  
  Logger.log(`Skipping file type: ${mimeType}`);
  return null;
}

/**
 * Calls the Gemini API for classification.
 * ★★★ 改善点: この関数をGemini APIを利用するように全面的に書き換え ★★★
 * @param {string} content The text content of the file.
 * @returns {string} The primary category name in Japanese, or "手動レビュー" if classification fails.
 * @deprecated This function is replaced by classifyFileWithGemini_GAS which handles files directly.
 */
function classifyDocumentWithGemini(content) {
  const GEMINI_API_KEY = getScriptProperty('GEMINI_API_KEY');
  if (!GEMINI_API_KEY) {
    Logger.log("ERROR: GEMINI_API_KEY is not set in Script Properties.");
    return "手動レビュー";
  }

  const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${GEMINI_API_KEY}`;

  // Geminiに分類してほしいカテゴリのリスト。キーワード分類のものを再利用します。
  const categories = [
    "学校・教育", "請求書・領収書", "マニュアル・保証書", "公共料金", 
    "税金・公的書類", "金融・保険", "医療・健康", "仕事関連", "チラシ・広告", "その他"
  ];

  // Geminiへの指示（プロンプト）
  const prompt = `
以下のテキストを読んで、最も適切だと思われるカテゴリを下記のリストから1つだけ選んでください。
リストにないカテゴリは使用しないでください。判断が難しい場合は「その他」と回答してください。
回答はカテゴリ名のみで、他の言葉は含めないでください。

カテゴリリスト:
${categories.join(", ")}

--- テキスト ---
${content.substring(0, 8000)}
--- テキスト終 ---

カテゴリ:
`;

  const payload = {
    "contents": [{
      "parts": [{
        "text": prompt
      }]
    }]
  };

  const options = {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  try {
    const response = UrlFetchApp.fetch(apiUrl, options);
    const responseText = response.getContentText();
    const jsonResponse = JSON.parse(responseText);

    // Geminiからの回答を抽出
    const category = jsonResponse.candidates[0].content.parts[0].text.trim();
    Logger.log(`[Gemini SUCCESS] Classified as: ${category}`);
    
    // 念のため、カテゴリリストに含まれるかチェック
    return categories.includes(category) ? category : "手動レビュー";
  } catch (e) {
    Logger.log(`[Gemini ERROR] Failed to classify document. Error: ${e.message}`);
    return "手動レビュー";
  }
}

/**
 * テキスト内のキーワードに基づいてドキュメントの種類を分類します。
 * @param {string} content - 抽出されたテキストコンテンツ。
 * @returns {string} 分類されたドキュメントの種類（日本語）。一致しない場合は "不明" を返します。
 * @deprecated This function is no longer needed when using direct classification with Gemini.
 */
function classifyByKeywords(content) {
  // ドキュメントの種類と、それに関連するキーワードの対応表
  // このルールをカスタマイズして、分類の精度を上げることができます。
  // キーワードは正規表現も利用可能です。
  // 生活に密着したカテゴリとキーワードのルール。上から順に評価されます。
  const keywordRules = {
    "請求書": [/請求書/, /ご請求/, /invoice/i],
    "領収書": [/領収書/, /receipt/i],
    "取扱説明書": [/取扱説明書/, /instruction manual/i, /セットアップガイド/],
    "保証書": [/保証書/, /warranty/i],
    "給与明細": [/給与明細/, /支給/],
    "契約書": [/契約書/, /agreement/i, /業務委託/],
    "チラシ・DM": [/キャンペーン/, /限定/],
    // 必要に応じてルールを追加
    // ★★★ 改善点: 生活に密着したカテゴリとキーワードを追加・整理 ★★★
    "学校・教育": [/保護者様/, /PTA/, /学年だより/, /学校だより/, /進路/, /給食/, /授業参観/, /教育委員会/],
    "請求書・領収書": [/請求書/, /ご請求/, /ご利用明細/, /領収書/, /invoice/i, /receipt/i],
    "マニュアル・保証書": [/取扱説明書/, /保証書/, /instruction manual/i, /セットアップガイド/, /ユーザーガイド/, /warranty/i],
    "公共料金": [/電気/, /ガス/, /水道/, /検針/, /使用量のお知らせ/],
    "税金・公的書類": [/確定申告/, /納税/, /住民税/, /固定資産税/, /年金/, /マイナンバー/, /役所/, /市役所/, /区役所/],
    "金融・保険": [/銀行/, /保険/, /証券/, /契約者貸付/, /生命保険/, /損害保険/],
    "医療・健康": [/病院/, /クリニック/, /診療明細書/, /健康診断/, /検査結果/],
    "仕事関連": [/契約書/, /agreement/i, /業務委託/, /給与明細/, /源泉徴収票/, /辞令/],
    "チラシ・広告": [/キャンペーン/, /限定/, /セール/, /広告/],
  };

  // 各ルールを順番にチェック
  for (const docType in keywordRules) {
    const keywords = keywordRules[docType];
    for (const keyword of keywords) {
      // 大文字・小文字を区別せずにマッチさせる
      const regex = new RegExp(keyword.source, 'i');
      if (content.match(regex)) {
        Logger.log(`Keyword match found: Document type is "${docType}"`);
        return docType;
      }
    }
  }

  // どのキーワードにも一致しなかった場合
  return "不明";
}

/**
 * AIが分類した英語のカテゴリ名を、対応する日本語のフォルダ名に変換します。
 * @param {string} englishCategory - AIが返した英語のカテゴリ名 (例: "Finance", "Software")
 * @returns {string} 日本語のフォルダ名 (例: "経理", "ソフトウェア")。対応表にない場合は "手動レビュー" を返します。
 */
function convertCategoryToJapanese(englishCategory) {
  // ★★★ 改善点: この関数はGemini導入により不要になりますが、互換性のために残します ★★★
  // Geminiは直接日本語カテゴリを返すため、この変換処理は実質的に使われなくなります。
  // もし古いロジック(classifyDocument)を呼び出す箇所が残っている場合に備え、
  // 単純にカテゴリ名をそのまま返すか、手動レビューにフォールバックさせます。
  Logger.log(`Warning: convertCategoryToJapanese is deprecated and should not be called. Input: ${englishCategory}`);
  return englishCategory || "手動レビュー";
}

/**
 * Sends a notification message to Discord Bot via API endpoint.
 * The Bot will then send the message to Discord with button components.
 * @param {string} title The title of the Discord embed.
 * @param {string} description The main body of the message.
 * @param {string} fileName The name of the file.
 * @param {string} fileId The ID of the file.
 * @param {string} japaneseCategory The predicted category name (or "手動レビュー").
 * @param {string} newFileName The proposed new file name.
 */
function sendDiscordNotification(title, description, fileName, fileId, japaneseCategory, newFileName) {
  const BOT_API_URL = getScriptProperty('BOT_API_URL');
  const GAS_API_KEY = getScriptProperty('GAS_API_KEY');
  
  if (!BOT_API_URL || !GAS_API_KEY) {
    Logger.log("ERROR: BOT_API_URL or GAS_API_KEY is not set in Script Properties.");
    return;
  }

  const payload = {
    title: title,
    description: description,
    fileName: fileName,
    fileId: fileId,
    category: japaneseCategory, // 日本語カテゴリを送信
    newFileName: newFileName    // 新しいファイル名を送信
  };

  const options = {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    headers: {
      'X-API-Key': GAS_API_KEY
    },
    muteHttpExceptions: true
  };

  try {
    const response = UrlFetchApp.fetch(BOT_API_URL, options);
    const responseCode = response.getResponseCode();
    const responseText = response.getContentText();
    
    if (responseCode === 200) {
      Logger.log(`Discord notification sent successfully for file: ${fileName}`);
    } else {
      Logger.log(`Discord notification error (HTTP ${responseCode}): ${responseText}`);
    }
  } catch (e) {
    Logger.log("Discord Bot API Error: " + e.message);
  }
}
