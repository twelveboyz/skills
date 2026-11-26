// 测试夹具：把 stdin 的 JSON 拆成 headers/body 两路，走脱敏公开函数后回吐 JSON。
import { redactHeaders, redactText } from '../../lib/redact.mjs';

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (raw += d));
process.stdin.on('end', () => {
  const input = JSON.parse(raw);
  const out = {};
  if (input.headers) out.headers = redactHeaders(input.headers);
  if (input.body)
    out.body =
      typeof input.body === 'string'
        ? redactText(input.body)
        : JSON.parse(redactText(JSON.stringify(input.body)));
  process.stdout.write(JSON.stringify(out));
});
