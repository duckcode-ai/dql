import { exec } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { resolve, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

function openBrowser(url: string) {
  const cmd =
    process.platform === 'darwin' ? `open "${url}"` :
    process.platform === 'win32'  ? `start "${url}"` :
    `xdg-open "${url}"`;
  exec(cmd, () => {});
}

function mimeType(filePath: string): string {
  switch (extname(filePath).toLowerCase()) {
    case '.html': return 'text/html; charset=utf-8';
    case '.js':   return 'application/javascript';
    case '.css':  return 'text/css';
    case '.svg':  return 'image/svg+xml';
    case '.wasm': return 'application/wasm';
    case '.json': return 'application/json';
    case '.png':  return 'image/png';
    default:      return 'application/octet-stream';
  }
}

export async function runNotebook(flags: Record<string, unknown>) {
  const dataFile  = flags.data  ? String(flags.data)         : undefined;
  const port      = flags.port  ? Number(flags.port)         : 4321;
  const noOpen    = Boolean(flags.noOpen);

  // ── Dev mode: inside the monorepo, use the Vite dev server for hot reload ──
  const notebookAppDir = resolve(__dirname, '../../../../apps/notebook');
  if (existsSync(join(notebookAppDir, 'package.json'))) {
    console.log('Starting DQL Notebook (dev)…\n');
    const child = exec(`pnpm dev --port ${port}`, { cwd: notebookAppDir });
    child.stdout?.pipe(process.stdout);
    child.stderr?.pipe(process.stderr);
    process.on('SIGINT', () => { child.kill(); process.exit(0); });
    return;
  }

  // ── Installed mode: serve the pre-built static bundle ──
  const notebookDistDir = resolve(__dirname, '../notebook-dist');
  if (!existsSync(notebookDistDir)) {
    console.error(
      'DQL Notebook files not found. Reinstall the CLI:\n' +
      '  npm install -g @duckcodeailabs/dql-cli\n'
    );
    process.exit(1);
  }

  const server = createServer((req, res) => {
    // SharedArrayBuffer requires COOP + COEP headers
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');

    const url = req.url ?? '/';

    // Endpoint: return the local data file so the browser can load it
    if (req.method === 'GET' && url === '/api/local-data') {
      if (dataFile && existsSync(dataFile)) {
        const ext = extname(dataFile).toLowerCase();
        const contentType = ext === '.csv' ? 'text/csv' : 'application/octet-stream';
        const name = dataFile.replace(/\\/g, '/').split('/').pop()!.replace(/\.[^.]+$/, '');
        res.writeHead(200, {
          'Content-Type': contentType,
          'X-Table-Name': name,
          'Access-Control-Allow-Origin': '*',
        });
        return res.end(readFileSync(dataFile));
      }
      res.writeHead(204);
      return res.end();
    }

    // Static file serving with SPA fallback
    const safePath = url.split('?')[0].replace(/\.\./g, '');
    let filePath = join(notebookDistDir, safePath === '/' ? 'index.html' : safePath);
    if (!existsSync(filePath)) filePath = join(notebookDistDir, 'index.html');

    try {
      const content = readFileSync(filePath);
      res.writeHead(200, { 'Content-Type': mimeType(filePath) });
      res.end(content);
    } catch {
      res.writeHead(404);
      res.end('Not found');
    }
  });

  server.listen(port, () => {
    const url = `http://localhost:${port}`;
    console.log(`\n  DQL Notebook → ${url}\n`);
    if (dataFile) {
      console.log(`  Pre-loaded:   ${dataFile}  (query it as  FROM data)\n`);
    } else {
      console.log('  Tip: pass --data <file.csv> to pre-load your own data file\n');
    }
    if (!noOpen) openBrowser(url);
  });

  process.on('SIGINT', () => { server.close(); process.exit(0); });
}
