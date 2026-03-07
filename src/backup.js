'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('./db');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'newslog.db');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');

let isBackupInProgress = false;

async function getS3Client() {
  const { S3Client, PutObjectCommand, ListObjectsV2Command, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
  const client = new S3Client({
    region: process.env.S3_REGION || 'us-east-1',
    endpoint: process.env.S3_ENDPOINT,
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY,
      secretAccessKey: process.env.S3_SECRET_KEY,
    },
    forcePathStyle: !!process.env.S3_ENDPOINT && !process.env.S3_ENDPOINT.includes('amazonaws.com'),
  });
  return { client, PutObjectCommand, ListObjectsV2Command, GetObjectCommand, DeleteObjectCommand };
}

async function createBackupArchive(outPath) {
  const tar = require('tar');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'newslog-backup-'));

  // Atomic SQLite backup
  const db = getDb();
  const tmpDbPath = path.join(tmpDir, 'newslog.db');
  await new Promise((resolve, reject) => {
    db.backup(tmpDbPath).then(resolve).catch(reject);
  });

  // Copy uploads
  const tmpUploadsDir = path.join(tmpDir, 'uploads');
  if (fs.existsSync(UPLOADS_DIR)) {
    fs.cpSync(UPLOADS_DIR, tmpUploadsDir, { recursive: true });
  } else {
    fs.mkdirSync(tmpUploadsDir);
  }

  // Metadata
  const dbStats = db.prepare('SELECT COUNT(*) as cnt FROM blogs').get();
  const entryStats = db.prepare('SELECT COUNT(*) as cnt FROM entries').get();
  const metadata = {
    version: require('../package.json').version,
    date: new Date().toISOString(),
    blogs: dbStats.cnt,
    entries: entryStats.cnt,
    db_size: fs.statSync(tmpDbPath).size,
  };
  fs.writeFileSync(path.join(tmpDir, 'metadata.json'), JSON.stringify(metadata, null, 2));

  // Create tar.gz
  await tar.create({ gzip: true, file: outPath, cwd: tmpDir }, ['.']);

  // Cleanup temp dir
  fs.rmSync(tmpDir, { recursive: true });

  return metadata;
}

async function runBackup() {
  if (isBackupInProgress) throw new Error('Backup already in progress');
  isBackupInProgress = true;

  const db = getDb();
  const logId = uuidv4();
  const filename = `newslog-backup-${formatDate(new Date())}.tar.gz`;
  const tmpPath = path.join(os.tmpdir(), filename);

  try {
    db.prepare('INSERT INTO backup_log (id, type, status, filename) VALUES (?, ?, ?, ?)').run(logId, 'backup', 'in_progress', filename);

    const metadata = await createBackupArchive(tmpPath);
    const fileBuffer = fs.readFileSync(tmpPath);
    const fileSize = fileBuffer.length;

    if (process.env.S3_BACKUP_ENABLED === 'true') {
      const { client, PutObjectCommand, ListObjectsV2Command, DeleteObjectCommand } = await getS3Client();
      const bucket = process.env.S3_BUCKET;

      const putParams = {
        Bucket: bucket,
        Key: filename,
        Body: fileBuffer,
        ContentType: 'application/gzip',
      };
      if (process.env.S3_BACKUP_ENCRYPTION) {
        putParams.ServerSideEncryption = process.env.S3_BACKUP_ENCRYPTION;
      }
      await client.send(new PutObjectCommand(putParams));

      // Retention cleanup
      const retention = parseInt(process.env.S3_BACKUP_RETENTION || '30');
      const list = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: 'newslog-backup-' }));
      const objects = (list.Contents || []).sort((a, b) => a.LastModified - b.LastModified);
      if (objects.length > retention) {
        const toDelete = objects.slice(0, objects.length - retention);
        for (const obj of toDelete) {
          await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: obj.Key }));
        }
      }
    }

    db.prepare('UPDATE backup_log SET status = ?, size = ?, message = ? WHERE id = ?').run('completed', fileSize, JSON.stringify(metadata), logId);
    return { filename, size: fileSize, metadata };
  } catch (err) {
    db.prepare('UPDATE backup_log SET status = ?, message = ? WHERE id = ?').run('error', err.message, logId);
    throw err;
  } finally {
    isBackupInProgress = false;
    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
  }
}

async function listBackups() {
  if (process.env.S3_BACKUP_ENABLED !== 'true') return [];

  const { client, ListObjectsV2Command } = await getS3Client();
  const bucket = process.env.S3_BUCKET;
  const list = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: 'newslog-backup-' }));
  return (list.Contents || [])
    .sort((a, b) => b.LastModified - a.LastModified)
    .map(obj => ({ filename: obj.Key, size: obj.Size, date: obj.LastModified }));
}

async function restoreBackup(filename) {
  const tar = require('tar');
  const { broadcastToPublic } = require('./sse');

  // Download from S3
  const { client, GetObjectCommand } = await getS3Client();
  const bucket = process.env.S3_BUCKET;
  const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: filename }));

  const tmpPath = path.join(os.tmpdir(), filename);
  const writeStream = fs.createWriteStream(tmpPath);
  await new Promise((resolve, reject) => {
    response.Body.pipe(writeStream).on('finish', resolve).on('error', reject);
  });

  await performRestore(tmpPath);
  if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
}

async function restoreFromFile(filePath) {
  await performRestore(filePath);
}

async function performRestore(archivePath) {
  const tar = require('tar');
  const db = getDb();
  const { closeDb } = require('./db');

  const tmpExtractDir = fs.mkdtempSync(path.join(os.tmpdir(), 'newslog-restore-'));
  await tar.extract({ file: archivePath, cwd: tmpExtractDir });

  // Pre-restore safety backup
  const preRestoreDir = path.join(DATA_DIR, 'pre-restore-backup');
  fs.mkdirSync(preRestoreDir, { recursive: true });
  const safetyBackupPath = path.join(preRestoreDir, `pre-restore-${formatDate(new Date())}.tar.gz`);
  await createBackupArchive(safetyBackupPath);

  // Close DB, replace files
  closeDb();

  const extractedDb = path.join(tmpExtractDir, 'newslog.db');
  const extractedUploads = path.join(tmpExtractDir, 'uploads');

  if (fs.existsSync(extractedDb)) {
    fs.copyFileSync(extractedDb, DB_PATH);
  }
  if (fs.existsSync(extractedUploads)) {
    if (fs.existsSync(UPLOADS_DIR)) fs.rmSync(UPLOADS_DIR, { recursive: true });
    fs.cpSync(extractedUploads, UPLOADS_DIR, { recursive: true });
  }

  fs.rmSync(tmpExtractDir, { recursive: true });

  // Re-open DB
  getDb();
}

function formatDate(date) {
  return date.toISOString().replace(/[:.]/g, '').replace('T', '-').slice(0, 15);
}

function getLastBackupStatus() {
  const db = getDb();
  return db.prepare('SELECT * FROM backup_log ORDER BY created_at DESC LIMIT 1').get();
}

module.exports = { runBackup, listBackups, restoreBackup, restoreFromFile, getLastBackupStatus, createBackupArchive, formatDate };
