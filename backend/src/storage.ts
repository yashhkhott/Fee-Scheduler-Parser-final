import 'dotenv/config';
import { BlobServiceClient, BlobSASPermissions, generateBlobSASQueryParameters, StorageSharedKeyCredential } from '@azure/storage-blob';
import fs from 'fs';
import path from 'path';

const connStr = process.env.AZURE_STORAGE_CONNECTION_STRING || '';
const containerName = 'fee-schedules';

let blobServiceClient: BlobServiceClient | null = null;
let useCloudStorage = false;

if (connStr && connStr !== 'your_storage_connection_string_here') {
  try {
    blobServiceClient = BlobServiceClient.fromConnectionString(connStr);
    useCloudStorage = true;
    console.log('\x1b[32m[STORAGE] Connected to Azure Blob Storage successfully.\x1b[0m');
  } catch (err: any) {
    console.error('[STORAGE ERROR] Failed to connect to Azure Blob Storage:', err.message);
  }
}

if (!useCloudStorage) {
  console.log('\x1b[33m[STORAGE] ⚠️ Running in LOCAL STORAGE mode. Files will be saved in backend/uploads/.\x1b[0m');
}

/**
 * Generates an upload URL. In cloud mode, this is a secure SAS URL directly to Blob Storage.
 * In local mode, it returns a local upload API URL.
 */
export async function getUploadUrl(blobName: string): Promise<{ uploadUrl: string; isCloud: boolean }> {
  if (useCloudStorage && blobServiceClient) {
    const containerClient = blobServiceClient.getContainerClient(containerName);
    await containerClient.createIfNotExists();
    const blobClient = containerClient.getBlockBlobClient(blobName);
    
    // Parse connection string to get account credentials for SAS generation
    const matches = connStr.match(/AccountName=([^;]+);AccountKey=([^;]+)/);
    if (matches) {
      const accountName = matches[1];
      const accountKey = matches[2];
      const credential = new StorageSharedKeyCredential(accountName, accountKey);
      
      const sasToken = generateBlobSASQueryParameters({
        containerName,
        blobName,
        permissions: BlobSASPermissions.parse("w"), // write permission
        startsOn: new Date(),
        expiresOn: new Date(new Date().valueOf() + 15 * 60 * 1000) // 15 mins expiry
      }, credential).toString();

      return {
        uploadUrl: `${blobClient.url}?${sasToken}`,
        isCloud: true
      };
    }
  }

  // Local fallback: client uploads back to Fastify /api/jobs directly
  return {
    uploadUrl: 'http://localhost:4000/api/jobs',
    isCloud: false
  };
}

/**
 * Downloads a fee-schedule PDF from Blob Storage (or copies from local directory).
 */
export async function downloadFile(sourcePath: string, destPath: string): Promise<void> {
  // Ensure destination directory exists
  const destDir = path.dirname(destPath);
  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
  }

  if (useCloudStorage && blobServiceClient && !sourcePath.startsWith('/')) {
    const containerClient = blobServiceClient.getContainerClient(containerName);
    const blobClient = containerClient.getBlockBlobClient(sourcePath);
    console.log(`[STORAGE] Downloading ${sourcePath} from Azure Blob Storage...`);
    await blobClient.downloadToFile(destPath);
    console.log(`[STORAGE] Finished downloading to: ${destPath}`);
    return;
  }

  // Local fallback: sourcePath is already a local path, so copy it or verify it exists
  if (sourcePath !== destPath && fs.existsSync(sourcePath)) {
    fs.copyFileSync(sourcePath, destPath);
  }
}
