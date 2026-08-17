'use strict';

const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

/**
 * Одноразовый sshd для сквозной проверки: подключение, PTY и передача
 * данных должны проверяться против настоящего SSH-сервера, а не против
 * заглушки — иначе проверяется собственная выдумка, а не совместимость.
 *
 * Нужны sshd и ssh-keygen. В образе приложения (node:20-alpine) их нет,
 * поэтому набор помечается SKIP, а не падает.
 */

function binaryExists(command, args) {
  try {
    execFileSync(command, args, { stdio: 'ignore' });
    return true;
  } catch (err) {
    return err.code !== 'ENOENT';
  }
}

const SSHD_PATHS = ['/usr/sbin/sshd', '/usr/local/sbin/sshd', 'sshd'];

function findSshd() {
  for (const candidate of SSHD_PATHS) {
    try {
      execFileSync(candidate, ['-t', '-f', '/dev/null'], { stdio: 'ignore' });
      return candidate;
    } catch (err) {
      if (err.code !== 'ENOENT') return candidate;
    }
  }
  return null;
}

function isAvailable() {
  return Boolean(findSshd()) && binaryExists('ssh-keygen', ['-?']);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function waitForPort(port, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.connect(port, '127.0.0.1');
      socket.once('connect', () => {
        socket.destroy();
        resolve();
      });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() > deadline) reject(new Error(`sshd не поднялся на порту ${port}`));
        else setTimeout(attempt, 100);
      });
    };
    attempt();
  });
}

/**
 * @returns {Promise<{port:number, privateKey:string, hostKeyFingerprint:string,
 *                    username:string, stop:() => Promise<void>}>}
 */
async function start() {
  const sshdPath = findSshd();
  if (!sshdPath) throw new Error('sshd не найден');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webssh-sshd-'));
  const hostKey = path.join(dir, 'host_ed25519');
  const clientKey = path.join(dir, 'client');
  const authorizedKeys = path.join(dir, 'authorized_keys');
  const configPath = path.join(dir, 'sshd_config');

  execFileSync('ssh-keygen', ['-t', 'ed25519', '-f', hostKey, '-N', '', '-q']);
  execFileSync('ssh-keygen', ['-t', 'ed25519', '-f', clientKey, '-N', '', '-q']);
  fs.copyFileSync(`${clientKey}.pub`, authorizedKeys);
  fs.chmodSync(authorizedKeys, 0o600);

  const port = await freePort();
  const username = os.userInfo().username;

  // StrictModes no — каталог лежит в /tmp и проверку владельца не пройдёт.
  // UsePAM no — иначе sshd требует привилегий и системной настройки.
  fs.writeFileSync(
    configPath,
    [
      `Port ${port}`,
      'ListenAddress 127.0.0.1',
      `HostKey ${hostKey}`,
      `AuthorizedKeysFile ${authorizedKeys}`,
      'PermitRootLogin prohibit-password',
      'PasswordAuthentication no',
      'KbdInteractiveAuthentication no',
      'UsePAM no',
      'StrictModes no',
      'PrintMotd no',
      'X11Forwarding no',
      '',
    ].join('\n')
  );

  fs.mkdirSync('/run/sshd', { recursive: true });

  const child = spawn(sshdPath, ['-D', '-f', configPath], { stdio: ['ignore', 'ignore', 'pipe'] });
  const stderr = [];
  child.stderr.on('data', (chunk) => stderr.push(chunk.toString()));

  try {
    await waitForPort(port);
  } catch (err) {
    child.kill('SIGKILL');
    throw new Error(`${err.message}\n${stderr.join('')}`);
  }

  const fingerprintLine = execFileSync('ssh-keygen', ['-lf', `${hostKey}.pub`]).toString();
  const hostKeyFingerprint = fingerprintLine.split(/\s+/)[1];

  return {
    port,
    username,
    privateKey: fs.readFileSync(clientKey, 'utf8'),
    hostKeyFingerprint,
    stderr,
    async stop() {
      child.kill('SIGTERM');
      await new Promise((resolve) => {
        child.once('exit', resolve);
        setTimeout(() => {
          child.kill('SIGKILL');
          resolve();
        }, 3000).unref();
      });
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

module.exports = { start, isAvailable };
