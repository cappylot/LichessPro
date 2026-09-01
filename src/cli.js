#!/usr/bin/env node
/**
 * Terminal entry point. `npm start` runs this.
 *
 * Everything that only makes sense for a process you launched yourself lives
 * here — reading `.env` from the working directory, handling Ctrl-C, exiting
 * with a status code — so that none of it fires when the desktop app imports
 * `startServer`.
 */
import { loadEnvFile } from './config.js';
import { logger } from './log.js';
import { startServer } from './server.js';

const log = logger('cli');

loadEnvFile();

// A terminal server is usually meant to be reachable at the address the user
// typed, so default to all interfaces unless told otherwise. The desktop app
// pins 127.0.0.1 instead.
const instance = await startServer({ host: process.env.HOST ?? '0.0.0.0' }).catch((err) => {
  if (err.code === 'EADDRINUSE') {
    log.error(`Port ${process.env.PORT ?? 8080} is already in use. Set PORT to something else, or stop the other process.`);
  } else {
    log.error(`Failed to start: ${err.stack ?? err.message}`);
  }
  process.exit(1);
});

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  log.info(`${signal} received, shutting down`);
  await instance.close();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
