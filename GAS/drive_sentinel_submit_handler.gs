// Drive Sentinel (DS) Project: Acknowledgment and File Mover
// This script is deployed as a Web App to receive approval requests from the Discord Bot.

// --- Main Function: Receives POST Request from Discord Bot ---
function doPost(e) {
  // デバッグ用: ログを収集する配列
  const debugLogs = [];
  debugLogs.push("=== doPost called ===");
  
  // Script Propertiesから定数を読み込む
  const properties = PropertiesService.getScriptProperties();
  const DESTINATION_ROOT_FOLDER_ID = properties.getProperty('DESTINATION_ROOT_FOLDER_ID');
  
  debugLogs.push("DESTINATION_ROOT_FOLDER_ID: " + (DESTINATION_ROOT_FOLDER_ID ? "SET" : "NOT SET"));
  
  try {
    // デバッグログ
    debugLogs.push("e.postData: " + (e.postData ? "exists" : "null"));
    if (e.postData) {
      debugLogs.push("e.postData.contents: " + e.postData.contents);
    }
    
    // 1. Parse the JSON data sent from the Discord Bot
    const requestData = JSON.parse(e.postData.contents);
    const fileId = requestData.fileId;
    const targetFolderName = requestData.folderName;
    const newFileName = requestData.newFileName; // 新しいファイル名を受け取る
    
    debugLogs.push("Parsed fileId: " + fileId);
    debugLogs.push("Parsed targetFolderName: " + targetFolderName);
    debugLogs.push("Parsed newFileName: " + newFileName);
    debugLogs.push("fileId type: " + typeof fileId); // 修正: ログのtypo
    debugLogs.push("fileId length: " + (fileId ? fileId.length : "null"));

    // fileIdの存在と型を厳密にチェック
    if (!fileId || typeof fileId !== 'string' || fileId.trim() === '' || !targetFolderName) {
      debugLogs.push("ERROR: Invalid request. fileId or folderName is missing or invalid.");
      // 400 Bad Request を返すのがより丁寧
      return ContentService.createTextOutput(JSON.stringify({ status: "error", message: "Invalid request parameters.", logs: debugLogs })).setMimeType(ContentService.MimeType.JSON);
    }

    // DESTINATION_ROOT_FOLDER_IDの確認
    if (!DESTINATION_ROOT_FOLDER_ID) {
      debugLogs.push("ERROR: DESTINATION_ROOT_FOLDER_ID is not set");
      return ContentService.createTextOutput("Error: DESTINATION_ROOT_FOLDER_ID is not configured.\nDebug:\n" + debugLogs.join("\n"));
    }

    // ファイルIDの前後の空白を削除
    const cleanFileId = fileId.trim();
    debugLogs.push("Cleaned fileId: " + cleanFileId);

    try {
      // 2. Dynamically create or retrieve the target folder
      debugLogs.push("Calling getOrCreateFolder");
      const targetFolder = getOrCreateFolder(targetFolderName, DESTINATION_ROOT_FOLDER_ID);
      debugLogs.push("Target folder ready: " + targetFolder.getName());

      // 3. Get the file object
      debugLogs.push("Attempting to get file by ID: " + cleanFileId);
      
      try {
        const file = DriveApp.getFileById(cleanFileId);
        debugLogs.push("File retrieved successfully: " + file.getName());
        debugLogs.push("File ID: " + file.getId());
        
        // 4. ファイルをリネームする (ロジックを簡素化)
        // discord-botから渡されたnewFileNameを唯一の正とする
        if (newFileName && newFileName !== file.getName()) {
          file.setName(newFileName);
          debugLogs.push("File renamed to: " + newFileName);
        } else {
          debugLogs.push("Skipping rename. Reason: newFileName not provided or is the same as the current name.");
          if(newFileName) {
            debugLogs.push(`(newFileName: ${newFileName}, currentName: ${file.getName()})`);
          }
        }
        
        // 5. ファイルを移動する
        file.moveTo(targetFolder);
        debugLogs.push("File moved successfully to: " + targetFolder.getName());
        
        // 6. 処理後に説明欄をクリアする
        file.setDescription("");
        debugLogs.push("File description cleared.");
        
        return ContentService.createTextOutput("Success: File moved.");
        
      } catch (fileError) {
        debugLogs.push("Error getting file: " + fileError.message);
        debugLogs.push("Error stack: " + (fileError.stack || "no stack"));
        debugLogs.push("File ID that failed: " + cleanFileId);
        
        // エラー時にデバッグ情報を含めて返す
        return ContentService.createTextOutput(`Error: Failed to get file.\nMessage: ${fileError.message}\n\nDebug Logs:\n${debugLogs.join("\n")}`);
      }

    } catch (folderError) {
      debugLogs.push("Error with folder operation: " + folderError.message);
      debugLogs.push("Folder error stack: " + (folderError.stack || "no stack"));
      return ContentService.createTextOutput(`Error: ${folderError.message}\n\nDebug Logs:\n${debugLogs.join("\n")}`);
    }

  } catch (parseError) {
    debugLogs.push("Parse error: " + parseError.message);
    debugLogs.push("Parse error stack: " + (parseError.stack || "no stack"));
    if (e.postData) {
      debugLogs.push("Raw postData: " + e.postData.contents);
    }
    return ContentService.createTextOutput(`Error: Failed to parse request.\nMessage: ${parseError.message}\n\nDebug Logs:\n${debugLogs.join("\n")}`);
  }
}

// --- Helper Functions ---

/**
 * Searches for a folder by name under the root and creates it if it doesn't exist.
 * @param {string} folderName The desired name for the subfolder.
 * @param {string} rootFolderId The ID of the root folder.
 * @return {GoogleAppsScript.Drive.Folder} The target folder object.
 */
function getOrCreateFolder(folderName, rootFolderId) {
  const debugLogs = [];
  debugLogs.push("getOrCreateFolder called");
  debugLogs.push("folderName: " + folderName);
  debugLogs.push("rootFolderId: " + rootFolderId);
  
  try {
    debugLogs.push("Attempting to get root folder");
    const rootFolder = DriveApp.getFolderById(rootFolderId);
    debugLogs.push("Root folder retrieved: " + rootFolder.getName());
    
    const folders = rootFolder.getFoldersByName(folderName);
    
    if (folders.hasNext()) {
      const folder = folders.next();
      debugLogs.push("Existing folder found: " + folder.getName());
      return folder;
    } else {
      // Sanitize folder name (remove quotes added by Discord Bot for approval command)
      const cleanFolderName = folderName.replace(/"/g, '');
      debugLogs.push("Creating new folder: " + cleanFolderName);
      const newFolder = rootFolder.createFolder(cleanFolderName);
      debugLogs.push("Folder created successfully: " + newFolder.getName());
      return newFolder;
    }
  } catch (error) {
    debugLogs.push("Error in getOrCreateFolder: " + error.message);
    debugLogs.push("Error stack: " + (error.stack || "no stack"));
    // エラーを再スローして、呼び出し元で処理
    throw new Error("getOrCreateFolder failed: " + error.message + "\nDebug: " + debugLogs.join("\n"));
  }
}
