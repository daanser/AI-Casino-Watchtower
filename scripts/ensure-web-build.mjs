/**
 * 确保观察台前端已经构建好 —— `npm start` / `npm run dev` 的 prestart 钩子。
 *
 * 为什么需要它：前端（Vite + React）的构建产物落在 `apps/server/public/app/`，
 * 而那是**不入库**的（见 .gitignore）。所以刚 clone 下来的人如果直接 `npm start`，
 * 服务会退回 `apps/server/public/index.html` 那个早期的单文件版观察台
 * —— 界面完全是另一套（深色），跟仓库里描述的对不上。
 *
 * 这个脚本让「clone → npm install → npm start」就够了：
 *   构建产物不存在      → 构建
 *   前端源码比产物新    → 重新构建（改了样式/组件不用记得手动 build）
 *   产物是最新的        → 跳过（不浪费每次启动的 1.5 秒）
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUILT = resolve(ROOT, 'apps/server/public/app/index.html');

/** 这些地方一动，就应该重建前端 */
const SOURCES = [
  'apps/web/src',
  'apps/web/index.html',
  'apps/web/vite.config.ts',
  'apps/web/package.json',
  'apps/web/tsconfig.json',
];

/** 目录里最新的修改时间（递归）；文件就直接取自己 */
function newestMtime(target) {
  if (!existsSync(target)) return 0;
  const st = statSync(target);
  if (!st.isDirectory()) return st.mtimeMs;
  let newest = 0;
  for (const entry of readdirSync(target, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const m = newestMtime(join(target, entry.name));
    if (m > newest) newest = m;
  }
  return newest;
}

function build(reason) {
  console.log(`  → ${reason}，正在构建观察台前端…`);
  try {
    execSync('npm run build:web', { cwd: ROOT, stdio: 'inherit' });
  } catch {
    console.error('');
    console.error('  ✗ 前端构建失败。服务仍会启动，但界面会退回早期的单文件版。');
    console.error('    可以手动重试：npm run build:web');
    console.error('');
    // 故意不退出：让服务照常起来，总比完全跑不起来强。
    process.exitCode = 0;
  }
}

if (!existsSync(BUILT)) {
  build('还没有构建过观察台前端');
} else if (newestMtime(SOURCES.reduce((a, p) => a.concat(resolve(ROOT, p)), [])) > statSync(BUILT).mtimeMs) {
  build('前端源码比构建产物新');
} else {
  console.log('  ✓ 观察台前端已是最新，跳过构建');
}
