'use strict';

const fs = require('fs');
const path = require('path');

const { config } = require('./config');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

const COLORS = {
  debug: '\x1b[90m',
  info: '\x1b[36m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
  success: '\x1b[32m',
  reset: '\x1b[0m',
};

let fileStream = null;

function logFilePath(date = new Date()) {
  const day = date.toISOString().slice(0, 10);
  return path.join(config.log.dir, `pokebot-${day}.log`);
}

function getStream() {
  if (!config.log.toFile) return null;
  if (fileStream) return fileStream;
  fs.mkdirSync(config.log.dir, { recursive: true });
  fileStream = fs.createWriteStream(logFilePath(), { flags: 'a' });
  return fileStream;
}

function closeLog() {
  if (fileStream) {
    fileStream.end();
    fileStream = null;
  }
}

/**
 * Structured log line: human-readable on the console, JSON in the logfile so
 * runs can be replayed or grepped after the fact.
 */
function log(level, message, meta = {}) {
  const threshold = LEVELS[config.log.level] ?? LEVELS.info;
  const severity = LEVELS[level] ?? LEVELS.info;
  const timestamp = new Date().toISOString();

  if (severity >= threshold) {
    const color = COLORS[meta.tone || level] || '';
    const tag = level.toUpperCase().padEnd(5);
    const extra = Object.keys(meta).filter((k) => k !== 'tone');
    const suffix = extra.length
      ? ' ' + extra.map((k) => `${k}=${format(meta[k])}`).join(' ')
      : '';
    const line = `${COLORS.debug}${timestamp}${COLORS.reset} ${color}${tag}${COLORS.reset} ${message}${suffix}`;
    (severity >= LEVELS.warn ? console.error : console.log)(line);
  }

  const stream = getStream();
  if (stream) {
    const { tone, ...rest } = meta;
    stream.write(JSON.stringify({ timestamp, level, message, ...rest }) + '\n');
  }
}

function format(value) {
  if (value === null || value === undefined) return String(value);
  if (typeof value === 'object') return JSON.stringify(value);
  if (typeof value === 'string' && value.includes(' ')) return JSON.stringify(value);
  return String(value);
}

const logger = {
  debug: (msg, meta) => log('debug', msg, meta),
  info: (msg, meta) => log('info', msg, meta),
  warn: (msg, meta) => log('warn', msg, meta),
  error: (msg, meta) => log('error', msg, meta),
  success: (msg, meta) => log('info', msg, { ...meta, tone: 'success' }),
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Interval with +/- jitter, so many watched products don't all fire on the
 * same tick and hammer the origin in a burst.
 */
function jitter(baseMs, jitterMs) {
  if (!jitterMs) return baseMs;
  const offset = Math.floor(Math.random() * (jitterMs * 2 + 1)) - jitterMs;
  return Math.max(0, baseMs + offset);
}

function humanDuration(ms) {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return rest ? `${minutes}m${rest}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${minutes % 60}m`;
}

/** Short label for log lines, so a long product title doesn't wrap the terminal. */
function truncate(text, max = 60) {
  const value = String(text ?? '');
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

module.exports = { logger, log, sleep, jitter, humanDuration, truncate, closeLog, logFilePath };
