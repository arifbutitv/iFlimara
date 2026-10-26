const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const repo = path.resolve(__dirname, '../..');
const lock = path.join(repo, '.local-update.lock');
const logFile = path.join(repo, '.local-update.log');
const files = ['shiatube.json', 'shiatube-sources.json', 'shiatube-state.json'].map(f => path.join(repo, 'nuvio-addon/data', f));
const env = { ...process.env, NODE_USE_SYSTEM_CA: '1', GIT_TERMINAL_PROMPT: '0' };
let held = false, committed = false, backups;
function log(message) {
  const line = `${new Date().toISOString()} ${message}\n`;
  fs.appendFileSync(logFile, line);
  process.stdout.write(line);
}
function run(exe, args, cwd = repo) {
  try {
    const output = execFileSync(exe, args, { cwd, env, encoding: 'utf8', windowsHide: true, timeout: 2400000, maxBuffer: 4000000 });
    if (output?.trim()) log(output.trim());
    return output?.trim() || '';
  } catch (error) {
    if (error.stdout) log(String(error.stdout));
    if (error.stderr) log(String(error.stderr));
    throw new Error(`${path.basename(exe)} failed (status ${error.status})`);
  }
}
try {
  if (fs.existsSync(lock) && Date.now() - fs.statSync(lock).mtimeMs > 7200000) fs.unlinkSync(lock);
  try { fs.writeFileSync(lock, String(process.pid), { flag: 'wx' }); held = true; }
  catch { log('Another update is running; skipping'); process.exit(0); }
  log('Starting local ShiaTube content update');
  if (run('git', ['status', '--porcelain'])) throw new Error('Updater checkout has local changes; inspect it before retrying');
  if (run('git', ['branch', '--show-current']) !== 'main') throw new Error('Updater must use main');
  run('git', ['pull', '--ff-only', 'origin', 'main']);
  const addon = path.join(repo, 'nuvio-addon');
  const digestFile = path.join(repo, '.local-update-deps.sha256');
  const digest = crypto.createHash('sha256').update(fs.readFileSync(path.join(addon, 'package-lock.json'))).digest('hex');
  if (!fs.existsSync(path.join(addon, 'node_modules')) || !fs.existsSync(digestFile) || fs.readFileSync(digestFile, 'utf8') !== digest) {
    if (process.platform === 'win32') run(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm ci --no-audit --no-fund'], addon);
    else run('npm', ['ci', '--no-audit', '--no-fund'], addon);
    fs.writeFileSync(digestFile, digest);
  }
  backups = files.map(file => [file, fs.readFileSync(file)]);
  for (const script of ['update-shiatube.js', 'index-shiatube-sources.js', 'write-shiatube-state.js']) run(process.execPath, [`scripts/${script}`], addon);
  run(process.execPath, ['--test'], addon);
  const relative = files.map(file => path.relative(repo, file).replace(/\\/g, '/'));
  run('git', ['add', ...relative]);
  const changed = run('git', ['diff', '--cached', '--name-only']);
  if (changed) {
    run('git', ['-c', 'user.name=iFlimara updater', '-c', 'user.email=arifbutitv@users.noreply.github.com', 'commit', '-m', 'Update ShiaTube content index']);
    committed = true;
  }
  // Also retry any earlier update whose commit succeeded but push was interrupted.
  run('git', ['push', 'origin', 'HEAD:main']);
  log(changed ? 'Content updated and published successfully' : 'No content changes; current index remains valid');
} catch (error) {
  log(`ERROR: ${error.message}`);
  if (backups && !committed) {
    for (const [file, bytes] of backups) fs.writeFileSync(file, bytes);
    try { run('git', ['restore', '--staged', '--', ...files.map(file => path.relative(repo, file).replace(/\\/g, '/'))]); } catch { /* Preserve error details in log. */ }
  }
  process.exitCode = 1;
} finally {
  if (held) fs.unlinkSync(lock);
}
