/**
 * @fileoverview Service Account Authentication for Google Cloud Platform APIs
 *
 * This script provides functions to generate an OAuth2 access token using a
 * service account's JSON key stored in Script Properties. It does not
 * depend on any external libraries.
 */

/**
 * The scopes required for this project.
 * - cloud-platform: For Vertex AI API access.
 * - drive: For full access to Google Drive files and folders.
 */
const GCP_SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/drive'
].join(' ');

/**
 * Fetches an OAuth2 access token for the service account.
 * Caches the token for reuse to improve performance.
 *
 * @returns {string} The OAuth2 access token.
 */
function getGcpAuthToken() {
  const cache = CacheService.getScriptCache();
  const cachedToken = cache.get('gcp_access_token');

  if (cachedToken != null) {
    return cachedToken;
  }

  const serviceAccountKeyJson = PropertiesService.getScriptProperties().getProperty('GCP_SERVICE_ACCOUNT_KEY');
  if (!serviceAccountKeyJson) {
    throw new Error("Service account key ('GCP_SERVICE_ACCOUNT_KEY') is not set in Script Properties.");
  }
  const serviceAccountKey = JSON.parse(serviceAccountKeyJson);

  const privateKey = serviceAccountKey.private_key;
  const clientEmail = serviceAccountKey.client_email;
  const tokenUri = serviceAccountKey.token_uri;

  // 1. Create the JWT header.
  const jwtHeader = {
    alg: 'RS256',
    typ: 'JWT'
  };

  // 2. Create the JWT claim set.
  const now = Math.floor(Date.now() / 1000);
  const claimSet = {
    iss: clientEmail,
    scope: GCP_SCOPES,
    aud: tokenUri,
    exp: now + 3600, // Token valid for 1 hour
    iat: now
  };

  // 3. Encode the header and claim set.
  const encodedHeader = Utilities.base64EncodeWebSafe(JSON.stringify(jwtHeader));
  const encodedClaimSet = Utilities.base64EncodeWebSafe(JSON.stringify(claimSet));

  // 4. Create the signature input.
  const signatureInput = `${encodedHeader}.${encodedClaimSet}`;

  // 5. Sign the signature input.
  const signature = Utilities.computeRsaSha256Signature(signatureInput, privateKey);
  const encodedSignature = Utilities.base64EncodeWebSafe(signature);

  // 6. Form the complete JWT.
  const jwt = `${signatureInput}.${encodedSignature}`;

  // 7. Exchange the JWT for an access token.
  const options = {
    method: 'post',
    contentType: 'application/x-www-form-urlencoded',
    payload: {
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt
    }
  };

  const response = UrlFetchApp.fetch(tokenUri, options);
  const responseData = JSON.parse(response.getContentText());
  const accessToken = responseData.access_token;

  if (!accessToken) {
    throw new Error("Failed to obtain access token. Response: " + response.getContentText());
  }
  
  // Cache the token for 55 minutes (slightly less than expiry).
  cache.put('gcp_access_token', accessToken, 3300);

  return accessToken;
}
