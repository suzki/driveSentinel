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
  
  // 1. Extract Text Content (OCR for images/PDFs)
  const textContent = extractTextFromFile(file);

  // === ERROR CHECK (1): Text Content Missing ===
  if (!textContent || textContent.trim().length === 0) {
    const message = `Warning: Could not extract meaningful text from document: ${file.getName()}. Manual review needed.`;
    Logger.log(`[ERROR] Text extraction failed or resulted in empty string for file: ${file.getName()}`);
    sendDiscordNotification("AI Classification Failed", message, file.getName(), file.getId(), "Manual Review");
    
    // Mark file as processed (Manual Review)
    try { file.setDescription("DS_PROCESSED_MANUAL_REVIEW"); } catch (e) { Logger.log("Warning: Could not set file description (permission issue)."); }
    return; // Stop processing this file
  }

  // 2. キーワードに基づいてドキュメントの種類を分類
  let categoryName = classifyByKeywords(textContent);

  // 3. キーワードで分類できなかった場合、AIによる分類を試みる
  if (categoryName === "不明") {
    Logger.log("Keyword classification failed. Falling back to AI classification.");
    const englishCategory = classifyDocument(textContent);
    categoryName = convertCategoryToJapanese(englishCategory);
  }

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

  // 4. Send Notification based on result
  if (categoryName && categoryName !== "手動レビュー") {
    Logger.log(`[SUCCESS] Classified as: ${categoryName}`);
    sendDiscordNotification("New File Ready for Approval", `File classified as **${categoryName}**. Please click the button to approve.`, file.getName(), file.getId(), categoryName, newFileName);
    
    // Mark file to prevent re-processing in the next trigger run
    try { file.setDescription("DS_PROCESSED_PENDING_APPROVAL"); } catch (e) { Logger.log("Warning: Could not set file description (permission issue)."); }

  } else {
    Logger.log(`[ERROR] Classification failed or category not mapped for file: ${file.getName()}`);
    // "Manual Review" から "手動レビュー" に変更
    sendDiscordNotification("AI Classification Failed", `Warning: Could not classify document: ${file.getName()}. Manual review needed.`, file.getName(), file.getId(), "手動レビュー", file.getName());
    
    // Mark file as processed (Manual Review)
    try { file.setDescription("DS_PROCESSED_MANUAL_REVIEW"); } catch (e) { Logger.log("Warning: Could not set file description (permission issue)."); }
  }
}

/**
 * Converts file (PDF/Image/Document) to text content.
 * @param {GoogleAppsScript.Drive.File} file The file object.
 * @returns {string | null} The extracted text content or null on error/failure.
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
 * Calls the GCP Natural Language API for classification.
 * @param {string} content The text content of the file.
 * @returns {string | null} The primary category name or null if classification fails.
 */
function classifyDocument(content) {
  const GCP_PROJECT_ID = getScriptProperty('GCP_PROJECT_ID');
  if (!GCP_PROJECT_ID) {
    Logger.log("ERROR: GCP_PROJECT_ID is not set in Script Properties.");
    return "Manual Review"; // この関数内では英語のまま返す
  }

  const apiUrl = `https://language.googleapis.com/v1/documents:classifyText`;
  
  let contentToSend = content;
  
  // 1. 日本語対応のため、テキストを英語に翻訳
  try {
    contentToSend = LanguageApp.translate(content, 'ja', 'en');
    Logger.log(`[TRANSLATION] Japanese detected. Translated to English for GCP classification.`);
  } catch (e) {
      Logger.log(`[TRANSLATION ERROR] Failed to translate: ${e.message}`);
      // 翻訳失敗時は元のコンテンツで続行し、API側でエラーが出る可能性を許容
      // またはここで処理を中断する（今回は続行）
  }
  
  // APIへのリクエストペイロード
  const payload = {
    document: {
      content: contentToSend, // 翻訳後のコンテンツを使用
      type: 'PLAIN_TEXT'
    }
  };

  const options = {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true, 
    
    headers: {
      'Authorization': 'Bearer ' + ScriptApp.getOAuthToken(),
      'X-Goog-User-Project': GCP_PROJECT_ID 
    }
  };

  try {
    const response = UrlFetchApp.fetch(apiUrl, options);
    const responseCode = response.getResponseCode();
    const responseText = response.getContentText();
    const jsonResponse = JSON.parse(responseText);
    
    if (responseCode !== 200) {
      Logger.log(`[NL API ERROR] HTTP Status: ${responseCode}, Response: ${responseText}`);
      return "Manual Review"; // APIエラー時は手動レビューへ
    }
    
    if (jsonResponse.categories && jsonResponse.categories.length > 0) {
      const categoryPath = jsonResponse.categories[0].name;
      const parts = categoryPath.split('/');
      // パスの一番最後の要素をフォルダ名として使用
      return parts[parts.length - 1] || "Uncategorized"; 
    }
    
    return "Manual Review"; // カテゴリが見つからなかった場合 (英語)

  } catch (e) {
    Logger.log("UrlFetch Error during classification: " + e.message);
    return "Manual Review"; // ネットワーク/JSONパースエラー時も手動レビューへ (英語)
  }
}

/**
 * テキスト内のキーワードに基づいてドキュメントの種類を分類します。
 * @param {string} content - 抽出されたテキストコンテンツ。
 * @returns {string} 分類されたドキュメントの種類（日本語）。一致しない場合は "不明" を返します。
 */
function classifyByKeywords(content) {
  // ドキュメントの種類と、それに関連するキーワードの対応表
  // このルールをカスタマイズして、分類の精度を上げることができます。
  // キーワードは正規表現も利用可能です。
  const keywordRules = {
    "請求書": [/請求書/, /ご請求/, /invoice/i],
    "領収書": [/領収書/, /receipt/i],
    "取扱説明書": [/取扱説明書/, /instruction manual/i, /セットアップガイド/],
    "保証書": [/保証書/, /warranty/i],
    "給与明細": [/給与明細/, /支給/],
    "契約書": [/契約書/, /agreement/i, /業務委託/],
    "チラシ・DM": [/キャンペーン/, /限定/],
    // 必要に応じてルールを追加
  };

  // 各ルールを順番にチェック
  for (const docType in keywordRules) {
    const keywords = keywordRules[docType];
    for (const keyword of keywords) {
      if (content.match(keyword)) {
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
  // 英語カテゴリと日本語フォルダ名の対応表
  // ここの対応表を、ご自身の分類したいフォルダに合わせてカスタマイズしてください。
  const categoryMap = {
    // --- 一般的なカテゴリの例 ---
    "Arts & Entertainment": "アート・エンタメ",
    "Autos & Vehicles": "自動車",
    "Beauty & Fitness": "美容・フィットネス",
    "Books & Literature": "書籍・文学",
    "Business & Industrial": "ビジネス・産業",
    "Computers & Electronics": "コンピュータ・電子機器",
    "Finance": "経理・財務",
    "Food & Drink": "食品・飲料",
    "Games": "ゲーム",
    "Health": "健康",
    "Hobbies & Leisure": "趣味・レジャー",
    "Home & Garden": "ホーム・ガーデン",
    "Internet & Telecom": "インターネット",
    "Jobs & Education": "仕事・教育",
    "Law & Government": "法律・行政",
    "News": "ニュース",
    "Online Communities": "オンラインコミュニティ",
    "People & Society": "社会",
    "Pets & Animals": "ペット・動物",
    "Real Estate": "不動産",
    "Reference": "リファレンス",
    "Science": "科学",
    "Shopping": "ショッピング",
    "Sports": "スポーツ",
    "Travel": "旅行",
    "World Localities": "地域",
    // --- 特殊なカテゴリ ---
    "Uncategorized": "未分類",
    "Manual Review": "手動レビュー" // 手動レビューも日本語に
  };

  // 対応表にカテゴリが存在すれば日本語名を、なければ "手動レビュー" を返す
  return categoryMap[englishCategory] || "手動レビュー";
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
