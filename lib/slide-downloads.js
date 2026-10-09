'use strict';
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { randomBytes } = require('crypto');
function createDownloadStore() {
  const entries = new Map(), ttl = 15 * 60 * 1000; let directory;
  async function cleanup() { for (const [token, entry] of entries) if (entry.expires <= Date.now()) { entries.delete(token); await fs.rm(entry.path, { force: true }); } }
  const timer = setInterval(() => cleanup().catch(() => {}), 60000); timer.unref();
  async function put(buffer, filename) {
    await cleanup();
    while (entries.size >= 3) { const [token, entry] = entries.entries().next().value; entries.delete(token); await fs.rm(entry.path, { force: true }); }
    if (!directory) directory = await fs.mkdtemp(path.join(os.tmpdir(), 'oracle-slides-'));
    const token = randomBytes(32).toString('hex'), file = path.join(directory, token + '.pptx'), expires = Date.now() + ttl;
    await fs.writeFile(file, buffer, { mode: 0o600 }); entries.set(token, { path: file, filename, expires });
    return { downloadUrl: '/api/slides/download/' + token, expiresAt: new Date(expires).toISOString() };
  }
  async function get(token) { await cleanup(); return /^[a-f0-9]{64}$/.test(token) ? entries.get(token) : undefined; }
  async function close() { clearInterval(timer); entries.clear(); if (directory) await fs.rm(directory, { recursive: true, force: true }); }
  return { put, get, close };
}
module.exports = { createDownloadStore };
