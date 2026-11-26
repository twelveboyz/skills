// CDP http 层的形状测试：它要能被塞进 createOsaApi 当 http 用，且出错时说人话。
// 不连真浏览器（连上的路径只能在有 Chrome 的机器上验），只覆盖不需要浏览器的那几条错路。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCdpHttp } from '../lib/osa-cdp.mjs';
import { createOsaApi } from '../lib/osa-api.mjs';

test('是 (url, { method, form }) => Response 形状的函数，可以直接喂给适配器', () => {
  const http = createCdpHttp({ port: 1 });
  assert.equal(typeof http, 'function');
  assert.equal(typeof createOsaApi({ http }).batchStatus, 'function');
});

test('连不上 Chrome：报「连不上调试端口」并给出先开页面的提示', async () => {
  const http = createCdpHttp({ port: 1 });
  await assert.rejects(
    () => http('http://10.19.105.29:8080/osa_web/a/x', { method: 'POST', form: '' }),
    (e) => {
      assert.match(e.message, /连不上 Chrome 调试端口 1/);
      assert.match(e.message, /browser --url osa/);
      return true;
    },
  );
});

test('适配器没拿到 http 层：立刻报错，别等到 fetch 时才炸成 undefined', () => {
  assert.throws(() => createOsaApi({}), /需要一个 http 层/);
});
