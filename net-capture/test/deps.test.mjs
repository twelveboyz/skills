// S1 附带：AC10 零 npm 依赖，只用 node 内置模块。
import { test } from 'node:test';
import assert from 'node:assert';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
  );
}

test('AC10 只用内置模块，没有 package.json 依赖', () => {
  assert.ok(!existsSync(join(ROOT, 'package.json')), '不应有 package.json');
  const builtins = new Set(builtinModules);
  const files = walk(ROOT).filter((f) => f.endsWith('.mjs'));
  assert.ok(files.length > 0);
  for (const f of files) {
    const code = readFileSync(f, 'utf8');
    for (const [, spec] of code.matchAll(/from\s+['"]((?:node:)?[^'"]+)['"]/g)) {
      const name = spec.replace(/^node:/, '');
      const ok = spec.startsWith('node:') || builtins.has(name) || spec.startsWith('.');
      assert.ok(ok, `${f} 引入了非内置模块 ${spec}`);
    }
  }
});
