// 测试辅助：假 CDP 服务器。HTTP 提供 /json/list，WS 接受 Network.enable 并推送事件。
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function frame(obj) {
  const payload = Buffer.from(JSON.stringify(obj));
  const len = payload.length;
  const head =
    len < 126
      ? Buffer.from([0x81, len])
      : Buffer.from([0x81, 126, len >> 8, len & 0xff]);
  return Buffer.concat([head, payload]);
}

function parseFrames(buf) {
  const msgs = [];
  let off = 0;
  while (off + 2 <= buf.length) {
    const masked = (buf[off + 1] & 0x80) !== 0;
    let len = buf[off + 1] & 0x7f;
    let start = off + 2;
    if (len === 126) {
      if (off + 4 > buf.length) break;
      len = buf.readUInt16BE(off + 2);
      start = off + 4;
    }
    let mask;
    if (masked) {
      if (start + 4 > buf.length) break;
      mask = buf.subarray(start, start + 4);
      start += 4;
    }
    if (start + len > buf.length) break;
    const data = Buffer.from(buf.subarray(start, start + len));
    if (masked) for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4];
    msgs.push(JSON.parse(data.toString()));
    off = start + len;
  }
  return { msgs, end: off };
}

export async function startFakeCdp() {
  const targets = new Map(); // id -> { url, ws }
  const state = { enables: [] };

  const server = createServer((req, res) => {
    if (req.url === '/json/list') {
      const list = [...targets].map(([id, t]) => ({
        id,
        type: 'page',
        url: t.url,
        webSocketDebuggerUrl: `ws://127.0.0.1:${server.address().port}/devtools/page/${id}`,
      }));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(list));
      return;
    }
    res.writeHead(404).end();
  });

  const api = {
    port: 0,
    state,
    lastBodies: new Map(), // reqId -> 响应体，记录器调 getResponseBody 时回它
    ensureTarget,
    // 漏回包用：指定 requestId 后，服务器对它的 getResponseBody 只收不回，模拟响应体永远不返回
    dropBodyFor: new Set(),
    send(id, msg) {
      const t = targets.get(id);
      if (!t?.ws) throw new Error(`target ${id} 未连接`);
      t.ws.write(frame(msg));
    },
    close() {
      for (const t of targets.values()) t.ws?.destroy();
      server.close();
    },
  };

  server.on('upgrade', (req, socket) => {
    const id = req.url.split('/').pop();
    const accept = createHash('sha1')
      .update(req.headers['sec-websocket-key'] + WS_GUID)
      .digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    const target = ensureTarget(id);
    target.ws = socket;
    let buf = Buffer.alloc(0);
    socket.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      const { msgs, end } = parseFrames(buf);
      buf = buf.subarray(end);
      for (const m of msgs) {
        state.enables.push({ id, method: m.method });
        if (m.method === 'Network.getResponseBody') {
          // 被点名的请求不回包：模拟"响应体永远不回来"
          if (api.dropBodyFor.has(m.params.requestId)) continue;
          const body = api.lastBodies.get(m.params.requestId) ?? '';
          socket.write(frame({ id: m.id, result: { body, base64Encoded: false } }));
        } else {
          socket.write(frame({ id: m.id, result: {} }));
        }
      }
    });
    socket.on('error', () => {});
  });

  function ensureTarget(id, url = `https://page.example.com/${id}`) {
    if (!targets.has(id)) targets.set(id, { url, ws: null });
    return targets.get(id);
  }

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  api.port = server.address().port;
  return api;
}
