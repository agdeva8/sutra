#!/usr/bin/env node
/**
 * Unified dev server runner for Sutra.
 *
 * Supports:
 *   - Auto-killing old processes occupying the chosen ports
 *   - Configurable ports via CLI arguments, env vars, or defaults
 *   - Works cleanly with pnpm workspaces without triggering ERR_PNPM_OTHER_PM_EXPECTED
 *   - Propagates REACT_APP_BACKEND_URL to frontend and updates CORS / Next URL configs
 *   - Graceful shutdown of both servers on SIGINT / SIGTERM
 *
 * Usage:
 *   node scripts/dev.js
 *   node scripts/dev.js --api 4000 --web 3000
 *   node scripts/dev.js --api=4002 --web=3002
 *   API_PORT=4000 WEB_PORT=3000 node scripts/dev.js
 */

const { spawn, execSync } = require('child_process');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const apiDir = path.join(rootDir, 'api');
const frontendDir = path.join(rootDir, 'frontend');

// Parse CLI args
const args = process.argv.slice(2);
let apiPort = process.env.API_PORT || '4000';
let webPort = process.env.WEB_PORT || process.env.PORT || '3000';

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--api' && args[i + 1]) {
    apiPort = args[++i];
  } else if (arg.startsWith('--api=')) {
    apiPort = arg.split('=')[1];
  } else if ((arg === '--web' || arg === '--frontend' || arg === '-p') && args[i + 1]) {
    webPort = args[++i];
  } else if (arg.startsWith('--web=') || arg.startsWith('--frontend=')) {
    webPort = arg.split('=')[1];
  } else if (arg === '--help' || arg === '-h') {
    console.log(`
Usage: node scripts/dev.js [options]

Options:
  --api <port>       Port for Next.js API server (default: 4000)
  --web <port>       Port for React frontend (default: 3000)
                     (linked git worktrees auto-advance to the next free pair: 3001/4001, 3002/4002, …)
  -h, --help         Show this help message

Environment variables:
  API_PORT           Same as --api
  WEB_PORT / PORT    Same as --web
`);
    process.exit(0);
  }
}

/** True when this checkout is a linked git worktree (not the main checkout). */
function isLinkedWorktree() {
  try {
    const run = (a) =>
      execSync(`git ${a}`, { cwd: rootDir, stdio: ['ignore', 'pipe', 'ignore'] })
        .toString()
        .trim();
    return run('rev-parse --git-dir') !== run('rev-parse --git-common-dir');
  } catch (_) {
    return false;
  }
}

/** PIDs of processes LISTENING on a port (ignores plain client sockets). */
function listeners(port) {
  try {
    return execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t`, {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim()
      .split(/\s+/)
      .filter(Boolean);
  } catch (_) {
    return [];
  }
}

// Port convention: the main checkout owns 4000 (API) / 3000 (web). A linked
// git worktree must not steal them, so it auto-advances to the next free PAIR
// — worktree #1 -> 3001/4001, #2 -> 3002/4002, and so on. Explicit
// --api/--web (or API_PORT/WEB_PORT) always wins and is honored exactly.
const explicitApi = args.some((a) => a.startsWith('--api')) || !!process.env.API_PORT;
const explicitWeb =
  args.some(
    (a) =>
      a === '--web' ||
      a === '--frontend' ||
      a.startsWith('--web=') ||
      a.startsWith('--frontend='),
  ) || !!process.env.WEB_PORT || !!process.env.PORT;
if (!explicitApi && !explicitWeb && isLinkedWorktree()) {
  let chosen = null;
  for (let k = 1; k <= 20; k++) {
    if (listeners(4000 + k).length === 0 && listeners(3000 + k).length === 0) {
      chosen = { api: 4000 + k, web: 3000 + k };
      break;
    }
  }
  if (!chosen) {
    console.error('[dev] no free worktree port pair found (tried 4001..4020 / 3001..3020)');
    process.exit(1);
  }
  console.log(
    `\x1b[36m[worktree]\x1b[0m linked worktree — using ${chosen.web}/${chosen.api} (main checkout owns 3000/4000)`,
  );
  apiPort = String(chosen.api);
  webPort = String(chosen.web);
}

function freePort(port) {
  try {
    const pids = execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t`, { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
    if (pids) {
      console.log(`\x1b[33m[cleanup]\x1b[0m Freeing port ${port} (killing PID: ${pids.replace(/\n/g, ', ')})`);
      for (const pid of pids.split(/\s+/)) {
        if (pid) {
          try {
            process.kill(Number(pid), 'SIGKILL');
          } catch (_) {}
        }
      }
    }
  } catch (_) {
    // Port is free
  }
}

console.log(`\x1b[36m========================================\x1b[0m`);
console.log(`\x1b[36m  Sutra Development Server Launcher\x1b[0m`);
console.log(`  API (Next.js):     \x1b[32mhttp://localhost:${apiPort}\x1b[0m`);
console.log(`  Frontend (React):  \x1b[32mhttp://localhost:${webPort}\x1b[0m`);
console.log(`\x1b[36m========================================\x1b[0m\n`);

// Free conflicting ports
freePort(apiPort);
freePort(webPort);

const apiEnv = {
  ...process.env,
  PORT: apiPort,
  NEXT_PUBLIC_APP_URL: `http://localhost:${apiPort}`,
  AUTH_URL: `http://localhost:${apiPort}`,
  CORS_ALLOWED_ORIGIN: `http://localhost:${webPort}`,
};

const webEnv = {
  ...process.env,
  PORT: webPort,
  REACT_APP_BACKEND_URL: `http://localhost:${apiPort}`,
  // Prevent react-scripts from attempting to open browser automatically if desired
  BROWSER: process.env.BROWSER || 'none',
};

// Spawn API Next.js process
const apiProc = spawn('npx', ['next', 'dev', '-p', apiPort], {
  cwd: apiDir,
  env: apiEnv,
  stdio: 'pipe',
});

// Spawn Frontend CRA process directly with node to avoid pnpm/yarn PM check conflicts
const webProc = spawn('node', ['node_modules/@craco/craco/dist/scripts/start.js'], {
  cwd: frontendDir,
  env: webEnv,
  stdio: 'pipe',
});

function prefixOutput(stream, prefix, colorCode) {
  let buffer = '';
  stream.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop(); // keep partial line
    for (const line of lines) {
      if (line.trim()) {
        console.log(`\x1b[${colorCode}m[${prefix}]\x1b[0m ${line}`);
      }
    }
  });
}

prefixOutput(apiProc.stdout, 'API', '34');
prefixOutput(apiProc.stderr, 'API', '31');
prefixOutput(webProc.stdout, 'WEB', '35');
prefixOutput(webProc.stderr, 'WEB', '31');

function shutdown() {
  console.log(`\n\x1b[33m[shutdown]\x1b[0m Stopping servers...`);
  if (apiProc && !apiProc.killed) apiProc.kill('SIGINT');
  if (webProc && !webProc.killed) webProc.kill('SIGINT');
  setTimeout(() => {
    freePort(apiPort);
    freePort(webPort);
    process.exit(0);
  }, 1000);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

apiProc.on('exit', (code) => {
  if (code !== 0 && code !== null) {
    console.error(`\x1b[31m[API]\x1b[0m Next.js exited with code ${code}`);
  }
});

webProc.on('exit', (code) => {
  if (code !== 0 && code !== null) {
    console.error(`\x1b[31m[WEB]\x1b[0m Frontend exited with code ${code}`);
  }
});
