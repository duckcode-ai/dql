import { readFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { resolve, extname } from 'node:path';
import { exec } from 'node:child_process';
import { compile } from '@duckcodeailabs/dql-compiler';

export interface RunFlags {
  data?: string;
  port?: number;
  watch?: boolean;
  noOpen?: boolean;
}

function openBrowser(url: string) {
  const cmd = process.platform === 'darwin' ? `open "${url}"`
            : process.platform === 'win32'  ? `start "${url}"`
            : `xdg-open "${url}"`;
  exec(cmd, () => {});
}

async function initDB(dataFile?: string) {
  const { default: Database } = await import('duckdb') as any;
  const db = new Database(':memory:');
  if (dataFile && existsSync(dataFile)) {
    const ext = extname(dataFile).toLowerCase();
    const quoted = dataFile.replace(/'/g, "''");
    const sql =
      ext === '.csv'     ? `CREATE TABLE data AS SELECT * FROM read_csv_auto('${quoted}')` :
      ext === '.parquet' ? `CREATE TABLE data AS SELECT * FROM read_parquet('${quoted}')` :
      ext === '.json'    ? `CREATE TABLE data AS SELECT * FROM read_json_auto('${quoted}')` : null;
    if (sql) {
      await new Promise<void>((ok, fail) => db.run(sql, (e: any) => e ? fail(e) : ok()));
      console.log(`  ✓ Loaded ${dataFile} → table "data"`);
    }
  }
  return db;
}

function runSQL(db: any, sql: string): Promise<{ columns: { name: string; type: string }[]; rows: Record<string, unknown>[] }> {
  return new Promise((ok, fail) =>
    db.all(sql, (err: any, rows: any[]) => {
      if (err) return fail(err);
      const columns = rows.length > 0
        ? Object.keys(rows[0]).map(k => ({ name: k, type: typeof rows[0][k] === 'number' ? 'number' : 'string' }))
        : [];
      ok({ columns, rows: rows ?? [] });
    })
  );
}

export async function runRun(file: string, flags: RunFlags) {
  const filePath = resolve(file);
  if (!existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exit(1);
  }

  const source = readFileSync(filePath, 'utf-8');
  process.stdout.write('  Compiling… ');
  const result = compile(source, { file: filePath });

  if (result.errors.length > 0) {
    console.error('\n  Errors:\n' + result.errors.map(e => `    ${e}`).join('\n'));
    process.exit(1);
  }
  if (!result.dashboards.length) {
    console.error('\n  No dashboards or blocks found.');
    process.exit(1);
  }
  console.log('done');

  const db = await initDB(flags.data);
  const port = flags.port ?? 4321;
  let currentHTML = result.dashboards[0].html;

  const server = createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');

    if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(currentHTML);
    }

    if (req.method === 'POST' && req.url === '/api/query') {
      let body = '';
      req.on('data', c => (body += c));
      req.on('end', async () => {
        try {
          const { sql, variables = {} } = JSON.parse(body);
          let finalSQL = sql as string;
          // substitute ${var} and {var} style params
          for (const [k, v] of Object.entries(variables)) {
            finalSQL = finalSQL.replace(new RegExp(`\\$\\{${k}\\}|\\{${k}\\}`, 'g'), String(v));
          }
          const data = await runSQL(db, finalSQL);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(data));
        } catch (e: any) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  });

  server.listen(port, () => {
    const url = `http://localhost:${port}`;
    console.log(`\n  DQL Viewer → ${url}\n`);
    if (!flags.noOpen) openBrowser(url);
  });

  // watch mode: recompile on file change
  if (flags.watch) {
    const { watch } = await import('node:fs');
    watch(filePath, () => {
      try {
        const src = readFileSync(filePath, 'utf-8');
        const r = compile(src, { file: filePath });
        if (!r.errors.length && r.dashboards.length) {
          currentHTML = r.dashboards[0].html;
          console.log(`  Reloaded ${new Date().toLocaleTimeString()}`);
        }
      } catch {}
    });
    console.log(`  Watching ${file} for changes…\n`);
  }

  process.on('SIGINT', () => { server.close(); process.exit(0); });
}
