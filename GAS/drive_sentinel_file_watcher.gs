/**
 * Drive Sentinel (DS) File Watcher (Service Account Version)
 *
 * This script runs on a time-based trigger to check the inbox folder for new files,
 * uses GCP Vertex AI for classification, and sends notifications to Discord.
 * It uses UrlFetchApp with a service account token for all Google API interactions.
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
  Logger.log("--- Starting Drive Sentinel Check (Service Account) ---");
  try {
    const INBOX_FOLDER_ID = getScriptProperty('INBOX_FOLDER_ID');
    if (!INBOX_FOLDER_ID) {
      Logger.log("ERROR: INBOX_FOLDER_ID is not set in Script Properties.");
      return;
    }

    // Get the service account auth token once for this execution run.
    const authToken = getGcpAuthToken();
    const driveApiHeaders = { 'Authorization': 'Bearer ' + authToken };

    // Find files in the inbox folder that are not trashed.
    const searchQuery = `'${INBOX_FOLDER_ID}' in parents and trashed = false`;
    const listUrl = `https://www.googleapis.com/drive/v2/files?q=${encodeURIComponent(searchQuery)}&maxResults=20&fields=items(id,title,description,fileSize,createdDate)`;
    
    const response = UrlFetchApp.fetch(listUrl, {
      method: 'get',
      headers: driveApiHeaders,
      muteHttpExceptions: true
    });

    const responseCode = response.getResponseCode();
    if (responseCode !== 200) {
      Logger.log(`Failed to list files. Code: ${responseCode}. Response: ${response.getContentText()}`);
      return;
    }

    const fileList = JSON.parse(response.getContentText());
    let fileCount = 0;

    if (fileList.items) {
      for (const file of fileList.items) {
        // Skip files that are already processed, are folders, or are too small/temporary.
        if (file.fileSize === 0 || (file.description && file.description.startsWith("DS_"))) {
            continue;
        }
        
        processFile(file, authToken);
        fileCount++;
        
        // Limit processing per execution to prevent hitting time limits.
        if (fileCount >= 10) {
            Logger.log("Processing limit reached for this run.");
            break;
        }
      }
    }
    
    Logger.log(`--- Finished. Processed ${fileCount} files. ---`);

  } catch (e) {
    Logger.log(`Critical error in checkNewFilesAndNotify: ${e.message}\nStack: ${e.stack}`);
  }
}

/**
 * Processes a single file: classifies it and sends a Discord notification.
 * @param {object} file The Drive API v2 file resource object.
 * @param {string} authToken The service account OAuth2 token.
 */
function processFile(file, authToken) {
  Logger.log(`Processing file: ${file.title} (${file.id})`);

  const GCP_PROJECT_ID = getScriptProperty('GCP_PROJECT_ID');
  const GCP_LOCATION = getScriptProperty('GCP_LOCATION');

  if (!GCP_PROJECT_ID || !GCP_LOCATION) {
      Logger.log("ERROR: GCP_PROJECT_ID or GCP_LOCATION is not set in Script Properties.");
      return;
  }

  Logger.log("Starting AI classification with Gemini Vision...");
  const classificationResult = classifyFileWithGemini_GAS(file.id, { projectId: GCP_PROJECT_ID, location: GCP_LOCATION }, authToken);
  const { category, fileName: suggestedName } = classificationResult;

  let finalNewFileName = file.title;
  const categoryForNotification = category || "手動レビュー";

  if (category && !category.startsWith("手動レビュー") && suggestedName) {
    Logger.log(`[SUCCESS] Classified as: ${category}. Suggested name: "${suggestedName}"`);
    
    const creationDate = new Date(file.createdDate);
    const formattedDate = Utilities.formatDate(creationDate, Session.getScriptTimeZone(), "yyyy-MM-dd");
    const extension = file.title.includes('.') ? `.${file.title.split('.').pop()}` : '';
    finalNewFileName = `${formattedDate}_${suggestedName}${extension}`;

    const description = `File classified as **${category}**. Please click the button to approve.`;
    sendDiscordNotification("New File Ready for Approval", description, file.title, file.id, category, finalNewFileName);
    
    // Update file description to mark it as pending approval
    updateFileDescription(file.id, `DS_PENDING_RENAME::${finalNewFileName}`, authToken);

  } else {
    const reason = category || "Unknown error";
    Logger.log(`[ERROR] Classification failed for file: ${file.title}. Reason: ${reason}`);
    
    const description = `Warning: Could not classify document: ${file.title}. Reason: ${reason}. Manual review needed.`;
    sendDiscordNotification("AI Classification Failed", description, file.title, file.id, categoryForNotification, finalNewFileName);
    
    updateFileDescription(file.id, "DS_PROCESSED_MANUAL_REVIEW", authToken);
  }
}

/**
 * Updates a file's description using the Drive API.
 * @param {string} fileId The ID of the file to update.
 * @param {string} description The new description.
 * @param {string} authToken The service account OAuth2 token.
 */
function updateFileDescription(fileId, description, authToken) {
  try {
    const updateUrl = `https://www.googleapis.com/drive/v2/files/${fileId}`;
    const payload = JSON.stringify({ description: description });
    
    const response = UrlFetchApp.fetch(updateUrl, {
      method: 'patch',
      contentType: 'application/json',
      headers: { 'Authorization': 'Bearer ' + authToken },
      payload: payload,
      muteHttpExceptions: true
    });

    if (response.getResponseCode() !== 200) {
      Logger.log(`Warning: Could not set file description for ${fileId}. Error: ${response.getContentText()}`);
    }
  } catch (e) {
    Logger.log(`Warning: Exception while setting file description for ${fileId}. Error: ${e.message}`);
  }
}

/**
 * Sends a notification message to Discord Bot via API endpoint.
 * (This function does not require changes as it already uses UrlFetchApp).
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
    category: japaneseCategory,
    newFileName: newFileName
  };

  const options = {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    headers: { 'X-API-Key': GAS_API_KEY },
    muteHttpExceptions: true
  };

  try {
    const response = UrlFetchApp.fetch(BOT_API_URL, options);
    const responseCode = response.getResponseCode();
    if (responseCode === 200) {
      Logger.log(`Discord notification sent successfully for file: ${fileName}`);
    } else {
      Logger.log(`Discord notification error (HTTP ${responseCode}): ${response.getContentText()}`);
    }
  } catch (e) {
    Logger.log("Discord Bot API Error: " + e.message);
  }
}

