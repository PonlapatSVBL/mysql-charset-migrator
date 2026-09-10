'use strict';
/**
 * Hardening middleware. The goal is a tool that physically cannot leak the
 * operator's DB credentials to a third party:
 *
 *  1. HTTP listener binds loopback only (see config.host / index.js).
 *  2. CSP forbids every outbound origin - no CDN, no fonts, no beacons, no
 *     images, no fetch to anything but 'self'. The page cannot phone home even
 *     if a dependency tried to.
 *  3. A per-process boot key (printed to the console at startup) is required on
 *     every API call, so no other program or website on the machine can drive
 *     the API even though it listens on localhost.
 *  4. Host/Origin pinning + custom-header requirement kills DNS-rebinding and
 *     cross-site request forgery.
 *  5. no-store on everything; nothing cacheable ever hits the disk cache.
 */
const crypto = require('crypto');
const config = require('../config');

const BOOT_KEY = process.env.CSMIG_BOOT_KEY || crypto.randomBytes(18).toString('base64url');

const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'",
].join('; ');

function baseHeaders(req, res, next) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  res.setHeader('Permissions-Policy', 'geolocation=(), camera=(), microphone=(), usb=(), payment=()');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');
  next();
}

function allowedHost(hostHeader) {
  if (!hostHeader) return false;
  const host = hostHeader.replace(/:\d+$/, '').toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === config.host.toLowerCase();
}

/** Reject DNS-rebinding / foreign Host headers before anything else runs. */
function hostGuard(req, res, next) {
  if (!allowedHost(req.headers.host)) {
    return res.status(421).json({ error: 'Host header ไม่ได้รับอนุญาต (ต้องเข้าผ่าน localhost เท่านั้น)' });
  }
  const origin = req.headers.origin;
  if (origin) {
    let ok = false;
    try { ok = allowedHost(new URL(origin).host); } catch { ok = false; }
    if (!ok) return res.status(403).json({ error: 'Origin ไม่ได้รับอนุญาต' });
  }
  next();
}

function timingSafeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/** Every /api call must carry the boot key in a custom header. */
function apiGuard(req, res, next) {
  const key = req.headers['x-app-key'];
  if (!key || !timingSafeEqual(key, BOOT_KEY)) {
    return res.status(401).json({ error: 'boot key ไม่ถูกต้อง — เปิดแอปจาก URL ที่พิมพ์ในเทอร์มินัล' });
  }
  next();
}

/** The single-page shell is only served when the boot key is in the URL. */
function shellGuard(req, res, next) {
  const key = req.query.key;
  if (!key || !timingSafeEqual(key, BOOT_KEY)) {
    res.status(401).type('html').send(
      `<!doctype html><meta charset="utf-8"><title>Locked</title>
       <body style="font:14px/1.6 system-ui;background:#0d1117;color:#e6edf3;padding:3rem">
       <h1 style="font-size:1.2rem">🔒 ต้องใช้ boot key</h1>
       <p>เปิดแอปด้วย URL ที่แสดงในเทอร์มินัลตอนสตาร์ท เช่น<br>
       <code>http://127.0.0.1:${config.port}/?key=…</code></p>
       <p>กลไกนี้กันไม่ให้โปรแกรมหรือเว็บอื่นบนเครื่องเรียก API ของแอปนี้ได้</p></body>`
    );
    return;
  }
  next();
}

/** Naive fixed-window limiter, enough to blunt local brute-force on connect. */
function rateLimiter({ windowMs = 60_000, max = 20 } = {}) {
  const hits = new Map();
  const t = setInterval(() => hits.clear(), windowMs);
  t.unref();
  return (req, res, next) => {
    const k = req.ip || 'local';
    const n = (hits.get(k) || 0) + 1;
    hits.set(k, n);
    if (n > max) return res.status(429).json({ error: 'คำขอถี่เกินไป กรุณารอสักครู่' });
    next();
  };
}

module.exports = { BOOT_KEY, baseHeaders, hostGuard, apiGuard, shellGuard, rateLimiter, CSP };
