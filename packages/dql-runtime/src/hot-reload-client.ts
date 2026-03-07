export function initHotReload(wsUrl?: string): void {
  if (typeof WebSocket === 'undefined') return;

  const url = wsUrl ?? `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/__dql_hmr`;
  let reconnectAttempts = 0;

  function connect(): void {
    const ws = new WebSocket(url);

    ws.onopen = () => {
      console.log('[DQL] Hot-reload connected');
      reconnectAttempts = 0;
    };

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.type === 'reload') {
        location.reload();
      }
    };

    ws.onclose = () => {
      if (reconnectAttempts < 10) {
        reconnectAttempts++;
        setTimeout(connect, Math.min(1000 * 2 ** reconnectAttempts, 10000));
      }
    };
  }

  connect();
}
