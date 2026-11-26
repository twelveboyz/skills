// S3：脱敏在 recorder 落盘时做。只测公开函数边界，不碰 CDP。
import { test } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PROBE = fileURLToPath(new URL('./helpers/probe-redact.mjs', import.meta.url));

function redact(input) {
  const out = execFileSync(process.execPath, [PROBE], {
    input: JSON.stringify(input),
    encoding: 'utf8',
  });
  return JSON.parse(out);
}

test('AC6 敏感头的值被替换且原文不出现在任何字节里', () => {
  const out = redact({
    headers: { Cookie: 'a=b', Authorization: 'Bearer x', accept: '*/*' },
  });
  assert.match(out.headers.Cookie, /^<REDACTED:\d+ chars>$/);
  assert.match(out.headers.Authorization, /^<REDACTED:\d+ chars>$/);
  assert.strictEqual(out.headers.accept, '*/*');
  assert.ok(!JSON.stringify(out).includes('Bearer x'));
  assert.ok(!JSON.stringify(out).includes('a=b'));
});

test('AC6 请求体里的 phone 键被打码', () => {
  const out = redact({ body: { phone: '13812345678', name: '张三' } });
  assert.strictEqual(out.body.phone, '138****5678');
  assert.ok(!JSON.stringify(out).includes('13812345678'));
});

test('AC6 表单体里的密码与令牌按键名脱敏，明文不落盘', () => {
  const form = redact({ body: 'grant_type=password&username=admin&password=P@ssw0rd!&note=hi' });
  assert.ok(!JSON.stringify(form).includes('P@ssw0rd'), JSON.stringify(form));
  assert.ok(!JSON.stringify(form).includes('ssw0rd'), JSON.stringify(form));
  assert.match(form.body, /grant_type=password/);
  assert.match(form.body, /username=admin/);
  assert.match(form.body, /note=hi/);

  const tok = redact({ body: 'access_token=TOPSECRET123&uid=1' });
  assert.ok(!JSON.stringify(tok).includes('TOPSECRET123'), JSON.stringify(tok));
  assert.match(tok.body, /uid=1/);
});

test('S1 手机号键只看前缀，phone_desc 这类旁键不误打码', () => {
  const out = redact({ body: { phone: '13812345678', phone_desc: '主号 abc', phonetype: 'mobile' } });
  assert.strictEqual(out.body.phone, '138****5678');
  assert.strictEqual(out.body.phonetype, 'mobile');
  assert.strictEqual(out.body.phone_desc, '主号 abc', '带下划线后缀的不是手机号键');
});

test('S1 手机号键的常见后缀写法仍然打码', () => {
  const out = redact({ body: { phoneNumber: '13812345678', mobile_number: '13912345678' } });
  assert.strictEqual(out.body.phoneNumber, '138****5678');
  assert.strictEqual(out.body.mobile_number, '139****5678');
});

test('S1 手机号前缀键在中文文本里也能打码', () => {
  const out = redact({ body: { phone: '手机13812345678' } });
  assert.strictEqual(out.body.phone, '手机138****5678');
});
test('AC6c 非结构化文本里不带敏感键名的手机号与邮箱照样打码', () => {
  const out = redact({ body: 'sms_code=13812345678&x=1&contact=zhangsan@example.com' });
  assert.ok(!JSON.stringify(out).includes('13812345678'), JSON.stringify(out));
  assert.match(out.body, /138\*\*\*\*5678/);
  assert.match(out.body, /x=1/);
  // 值域兜底没有键名可依，前缀只能保 2 位：zhangsan → zh，contact= 也在前缀里算作 2 位
  assert.match(out.body, /co\*\*\*@example\.com/);
});

test('AC6c 被截断的 JSON 文本里敏感键的值也不能落盘', () => {
  const cut = redact({ body: '{"items":[{"access_token":"TOPSECRET12345"' });
  assert.ok(!JSON.stringify(cut).includes('TOPSECRET12345'), JSON.stringify(cut));
  const flat = redact({ body: '{"access_token":"TOPSECRET12345"' });
  assert.ok(!JSON.stringify(flat).includes('TOPSECRET12345'), JSON.stringify(flat));
});

test('AC6 邮箱保留前 2 位后打码', () => {
  const out = redact({ body: { mail: 'zhangsan@example.com' } });
  assert.match(out.body.mail, /^zh\*+@example\.com$/);
  assert.ok(!JSON.stringify(out).includes('zhangsan@'));
});
