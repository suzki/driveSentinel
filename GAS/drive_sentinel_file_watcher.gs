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

  const GCP_PROJECT_ID = getScriptProperty('GCP_PROJECT_ID');
  const GCP_LOCATION = getScriptProperty('GCP_LOCATION');

  if (!GCP_PROJECT_ID || !GCP_LOCATION) {
      Logger.log("ERROR: GCP_PROJECT_ID or GCP_LOCATION is not set in Script Properties.");
      return;
  }

  Logger.log("Starting AI classification with Gemini Vision...");
  // 1. AI分類とファイル名提案を取得
  const classificationResult = classifyFileWithGemini_GAS(file, { projectId: GCP_PROJECT_ID, location: GCP_LOCATION });
  const { category, fileName: suggestedName } = classificationResult;

  let finalNewFileName = file.getName(); // デフォルトは元のファイル名
  const originalFileName = file.getName();
  const categoryForNotification = category || "手動レビュー"; // 通知用のカテゴリ名

  // 2. 分類結果に基づいて処理を分岐
  if (category && !category.startsWith("手動レビュー") && suggestedName) {
    // 成功時：AIの提案を採用
    Logger.log(`[SUCCESS] Classified as: ${category}. Suggested name: "${suggestedName}"`);
    
    // 日付プレフィックスと拡張子を維持して新しいファイル名を生成
    const creationDate = file.getDateCreated();
    const formattedDate = Utilities.formatDate(creationDate, Session.getScriptTimeZone(), "yyyy-MM-dd");
    const extension = originalFileName.includes('.') ? `.${originalFileName.split('.').pop()}` : '';
    finalNewFileName = `${formattedDate}_${suggestedName}${extension}`;

    const description = `File classified as **${category}**. Please click the button to approve.`;
    sendDiscordNotification("New File Ready for Approval", description, originalFileName, file.getId(), category, finalNewFileName);
    
    try {
      // 説明欄にリネーム後のファイル名を埋め込む
      file.setDescription(`DS_PENDING_RENAME::${finalNewFileName}`);
    } catch (e) {
      Logger.log(`Warning: Could not set file description (permission issue). Error: ${e.message}`);
    }

  } else {
    // 失敗時：手動レビュー
    const reason = category || "Unknown error"; // categoryがnullの場合のフォールバック
    Logger.log(`[ERROR] Classification failed or manual review needed for file: ${originalFileName}. Reason: ${reason}`);
    
    const description = `Warning: Could not classify document: ${originalFileName}. Reason: ${reason}. Manual review needed.`;
    sendDiscordNotification("AI Classification Failed", description, originalFileName, file.getId(), categoryForNotification, finalNewFileName);
    
    try {
      file.setDescription("DS_PROCESSED_MANUAL_REVIEW");
    } catch (e) {
      Logger.log(`Warning: Could not set file description (permission issue). Error: ${e.message}`);
    }
  }
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
