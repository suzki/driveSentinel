// Drive Sentinel (DS) Project: Acknowledgment and File Mover (Service Account Version)
// This script is deployed as a Web App to receive approval requests from the Discord Bot.

function doPost(e) {
  const log = (message) => Logger.log(message);
  log("=== doPost called (Service Account) ===");

  try {
    // 1. Authenticate and get properties
    const authToken = getGcpAuthToken();
    const DESTINATION_ROOT_FOLDER_ID = PropertiesService.getScriptProperties().getProperty('DESTINATION_ROOT_FOLDER_ID');

    if (!DESTINATION_ROOT_FOLDER_ID) {
      log("CRITICAL: DESTINATION_ROOT_FOLDER_ID is not set.");
      return createJsonResponse({ status: "error", message: "Server configuration error: Root folder not set." }, 500);
    }

    // 2. Parse request
    const requestData = JSON.parse(e.postData.contents);
    const fileId = requestData.fileId ? requestData.fileId.trim() : null;
    const targetFolderName = requestData.folderName;
    const newFileName = requestData.newFileName;

    if (!fileId || !targetFolderName || !newFileName) {
      log(`ERROR: Invalid request. fileId=${fileId}, folderName=${targetFolderName}, newFileName=${newFileName}`);
      return createJsonResponse({ status: "error", message: "Invalid request: fileId, folderName, and newFileName are required." }, 400);
    }

    // 3. Get file's current state (we need its original parents to move it)
    const fileInfo = getFileMetadata(fileId, authToken, "parents, title");
    if (!fileInfo) {
      log(`ERROR: Could not retrieve metadata for file ID: ${fileId}`);
      return createJsonResponse({ status: "error", message: `File not found or access denied for ID: ${fileId}` }, 404);
    }
    const originalParentIds = fileInfo.parents.map(p => p.id).join(',');

    // 4. Get or create the destination folder
    const targetFolderId = getOrCreateFolder(targetFolderName, DESTINATION_ROOT_FOLDER_ID, authToken);
    if (!targetFolderId) {
      log(`ERROR: Failed to get or create target folder '${targetFolderName}'`);
      return createJsonResponse({ status: "error", message: "Could not create destination folder." }, 500);
    }

    // 5. Update the file (rename and clear description)
    // Moving is done in a separate step with add/remove parents
    const updatePayload = {
      title: newFileName,
      description: ""
    };
    
    const patchUrl = `https://www.googleapis.com/drive/v2/files/${fileId}`;
    
    const patchResponse = UrlFetchApp.fetch(patchUrl, {
        method: 'patch',
        contentType: 'application/json',
        headers: { 'Authorization': 'Bearer ' + authToken },
        payload: JSON.stringify(updatePayload),
        muteHttpExceptions: true
    });

    if (patchResponse.getResponseCode() !== 200) {
      log(`ERROR: Failed to rename/clear-desc for file ${fileId}. Response: ${patchResponse.getContentText()}`);
      // Continue to try moving the file anyway
    }

    // 6. Move the file
    const moveUrl = `https://www.googleapis.com/drive/v2/files/${fileId}?addParents=${targetFolderId}&removeParents=${originalParentIds}`;
    const moveResponse = UrlFetchApp.fetch(moveUrl, {
        method: 'patch', // Using PATCH for this, though it's more of a metadata update
        headers: { 'Authorization': 'Bearer ' + authToken },
        muteHttpExceptions: true
    });

    if (moveResponse.getResponseCode() !== 200) {
        log(`ERROR: Failed to move file ${fileId}. Response: ${moveResponse.getContentText()}`);
        return createJsonResponse({ status: "error", message: "Failed to move file after renaming." }, 500);
    }


    log(`SUCCESS: File ${fileInfo.title} (${fileId}) renamed to ${newFileName} and moved to folder ${targetFolderName} (${targetFolderId})`);
    return createJsonResponse({ status: "success", message: "File processed successfully." });

  } catch (err) {
    Logger.log(`FATAL ERROR in doPost: ${err.message}\nStack: ${err.stack}`);
    return createJsonResponse({ status: "error", message: "An unexpected server error occurred." }, 500);
  }
}

function createJsonResponse(data, statusCode = 200) {
  const output = ContentService.createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MmeType.JSON);
  return output;
}

function getFileMetadata(fileId, authToken, fields = "id,title,description") {
    const url = `https://www.googleapis.com/drive/v2/files/${fileId}?fields=${encodeURIComponent(fields)}`;
    const response = UrlFetchApp.fetch(url, {
        method: 'get',
        headers: { 'Authorization': 'Bearer ' + authToken },
        muteHttpExceptions: true
    });
    if (response.getResponseCode() === 200) {
        return JSON.parse(response.getContentText());
    }
    return null;
}

function getOrCreateFolder(folderName, rootFolderId, authToken) {
  const cleanFolderName = folderName.replace(/"/g, ''); // Sanitize name
  const log = (message) => Logger.log(message);
  const driveApiHeaders = { 'Authorization': 'Bearer ' + authToken };

  // 1. Search for the folder
  const searchQuery = `title = '${cleanFolderName}' and mimeType = 'application/vnd.google-apps.folder' and '${rootFolderId}' in parents and trashed = false`;
  const searchUrl = `https://www.googleapis.com/drive/v2/files?q=${encodeURIComponent(searchQuery)}&fields=items(id)`;
  
  const searchResponse = UrlFetchApp.fetch(searchUrl, { method: 'get', headers: driveApiHeaders });
  const searchResult = JSON.parse(searchResponse.getContentText());

  if (searchResult.items && searchResult.items.length > 0) {
    log(`Found existing folder '${cleanFolderName}' with ID: ${searchResult.items[0].id}`);
    return searchResult.items[0].id;
  }

  // 2. Create the folder if not found
  log(`Creating new folder: '${cleanFolderName}'`);
  const createUrl = `https://www.googleapis.com/drive/v2/files`;
  const createPayload = {
    title: cleanFolderName,
    mimeType: "application/vnd.google-apps.folder",
    parents: [{ id: rootFolderId }]
  };

  const createResponse = UrlFetchApp.fetch(createUrl, {
    method: 'post',
    contentType: 'application/json',
    headers: driveApiHeaders,
    payload: JSON.stringify(createPayload),
    muteHttpExceptions: true
  });

  const createResponseCode = createResponse.getResponseCode();
  if (createResponseCode === 200) {
    const newFolder = JSON.parse(createResponse.getContentText());
    log(`Created new folder with ID: ${newFolder.id}`);
    return newFolder.id;
  } else {
    log(`ERROR: Failed to create folder. Code: ${createResponseCode}. Response: ${createResponse.getContentText()}`);
    return null;
  }
}

