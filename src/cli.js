#!/usr/bin/env node
'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { runBackup, listBackups, restoreBackup, restoreFromFile } = require('./backup');

async function main() {
  const [,, command, subCommand, ...args] = process.argv;

  if (command === 'backup') {
    if (subCommand === 'run') {
      console.log('Starting backup...');
      const result = await runBackup();
      console.log(`Backup completed: ${result.filename} (${(result.size / 1024 / 1024).toFixed(2)} MB)`);
    } else if (subCommand === 'list') {
      const backups = await listBackups();
      if (backups.length === 0) {
        console.log('No backups found.');
      } else {
        backups.forEach((b, i) => {
          console.log(`${i + 1}. ${b.filename} (${(b.size / 1024 / 1024).toFixed(2)} MB) — ${new Date(b.date).toLocaleDateString('it-IT')}`);
        });
      }
    } else if (subCommand === 'restore') {
      const filename = args[0];
      if (filename === '--latest') {
        const backups = await listBackups();
        if (!backups.length) {
          console.error('No backups available.');
          process.exit(1);
        }
        console.log(`Restoring latest: ${backups[0].filename}...`);
        await restoreBackup(backups[0].filename);
        console.log('Restore completed.');
      } else if (filename) {
        if (require('fs').existsSync(filename)) {
          console.log(`Restoring from local file: ${filename}...`);
          await restoreFromFile(filename);
        } else {
          console.log(`Restoring from S3: ${filename}...`);
          await restoreBackup(filename);
        }
        console.log('Restore completed.');
      } else {
        console.error('Usage: backup restore <filename|--latest>');
        process.exit(1);
      }
    } else {
      console.log('Usage: node src/cli.js backup [run|list|restore <filename|--latest>]');
    }
  } else {
    console.log('Available commands:');
    console.log('  backup run                        Run a manual backup');
    console.log('  backup list                       List available backups');
    console.log('  backup restore <filename>         Restore a specific backup');
    console.log('  backup restore --latest           Restore the latest backup');
  }
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
