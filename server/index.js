'use strict';
const path = require('path');
const express = require('express');
const config = require('../config');
const security = require('./security');
const session = require('./session');
const log = require('./lib/logger');
// Required for its side effect as much as its exports: loading the store is
// what teaches the logger where each endpoint's files go.
require('./lib/store');
const { router: api } = require('./routes/api');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', false);

app.use(security.baseHeaders);
app.use(security.hostGuard);

// The shell is gated on ?key=; assets are same-origin only (CSP) and carry no secrets.
app.get('/', security.shellGuard, (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.use('/assets', express.static(path.join(__dirname, '..', 'public'), {
  index: false, dotfiles: 'deny', etag: false, maxAge: 0,
}));

app.use('/api', security.apiGuard, security.rateLimiter({ windowMs: 60_000, max: 600 }));
app.use('/api/connect', security.rateLimiter({ windowMs: 60_000, max: 10 }));
app.use('/api', express.json({ limit: '2mb' }), api);

app.use((req, res) => res.status(404).json({ error: 'not found' }));

const server = app.listen(config.port, config.host, () => {
  const url = `http://${config.host}:${config.port}/?key=${security.BOOT_KEY}`;
  const line = '─'.repeat(72);
  process.stdout.write([
    '',
    line,
    '  MySQL Charset Migrator',
    `  เป้าหมาย: ${config.target.charset} / ${config.target.collation}`,
    '',
    '  เปิด URL นี้ในเบราว์เซอร์ (ต้องมี key ต่อท้าย):',
    `  ${url}`,
    '',
    `  bind: ${config.host}:${config.port} (loopback เท่านั้น)`,
    `  logs: ${config.paths.data} (แยกตามเครื่องปลายทางใต้ hosts/)`,
    '  รหัสฐานข้อมูลถูกเก็บในหน่วยความจำแบบเข้ารหัสเท่านั้น ไม่เขียนลงดิสก์ ไม่ส่งออกนอกเครื่อง',
    line,
    '',
  ].join('\n'));
  // `bind`, not `host`: this is the loopback address the console listens on,
  // and a line in the audit trail that says `host` must mean the database.
  log.audit('server.start', { bind: `${config.host}:${config.port}`, target: config.target, pid: process.pid });
  if (config.host !== '127.0.0.1' && config.host !== 'localhost' && config.host !== '::1') {
    process.stderr.write('\n  ⚠  คำเตือน: bind ไปยัง interface ที่ไม่ใช่ loopback — เครื่องอื่นในเครือข่ายอาจเข้าถึงแอปนี้ได้\n\n');
  }
});

async function shutdown(signal) {
  process.stdout.write(`\n[${signal}] ปิดการทำงาน...\n`);
  log.audit('server.stop', { signal });
  server.close();
  await session.destroyAll(`shutdown:${signal}`);
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (err) => log.audit('process.unhandledRejection', { error: err }));
process.on('uncaughtException', (err) => {
  log.audit('process.uncaughtException', { error: err });
  process.stderr.write(`uncaught: ${err && err.stack}\n`);
});

module.exports = { app, server };
