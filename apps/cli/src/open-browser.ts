import { spawn } from 'node:child_process';

export function maybeOpenBrowser(url: string, shouldOpen: boolean): void {
  if (!shouldOpen) return;

  const command = browserCommand();
  if (!command) return;

  try {
    const child = spawn(command.bin, [...command.args, url], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
  } catch {
    // best-effort only; keep CLI flow quiet if no browser opener exists
  }
}

function browserCommand(): { bin: string; args: string[] } | null {
  switch (process.platform) {
    case 'darwin':
      return { bin: 'open', args: [] };
    case 'win32':
      return { bin: 'cmd', args: ['/c', 'start', ''] };
    default:
      return { bin: 'xdg-open', args: [] };
  }
}
