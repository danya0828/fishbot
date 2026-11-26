import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const base = 'https://cdn.jsdelivr.net/gh/danya0828/fishbot@main/';

for (const f of ['bot.js', 'persona.md']) {
  const res = await fetch(`${base}${f}?t=${Date.now()}`);
  if (!res.ok) {
    console.log(`${f} 下载失败 ${res.status}`);
    process.exitCode = 1;
    continue;
  }
  fs.writeFileSync(path.join(dir, f), await res.text());
  console.log(`已更新 ${f}`);
}
console.log('完成，重启 node bot.js 生效');
