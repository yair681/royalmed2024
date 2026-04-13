const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const { execSync } = require('child_process');

const PORT = 3000;

function openBrowser(url) {
  const { platform } = process;
  if (platform === 'win32') execSync(`start "" "${url}"`);
  else if (platform === 'darwin') execSync(`open "${url}"`);
  else execSync(`xdg-open "${url}"`);
}

function waitForServer(url, retries, cb) {
  if (retries <= 0) { console.log('Server did not start in time'); return; }
  http.get(url, (res) => {
    if (res.statusCode === 200 || res.statusCode === 302) cb();
    else setTimeout(() => waitForServer(url, retries - 1, cb), 500);
  }).on('error', () => setTimeout(() => waitForServer(url, retries - 1, cb), 500));
}

const serverPath = path.join(__dirname, 'server.js');
const child = spawn('node', [serverPath], {
  stdio: 'inherit',
  env: { ...process.env }
});

child.on('error', (err) => console.error('Failed to start server:', err));
child.on('exit', (code) => { if (code !== 0) console.error('Server exited with code', code); });

console.log('Starting RoyalMed...');
waitForServer(`http://localhost:${PORT}/`, 40, () => {
  console.log(`Opening http://localhost:${PORT}/`);
  openBrowser(`http://localhost:${PORT}/`);
});
