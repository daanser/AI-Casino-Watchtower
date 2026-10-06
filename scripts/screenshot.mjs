/**
 * 用 CDP 打开观察台，真实等待若干秒（让 WebSocket 把实时帧喂进来），然后截图。
 *
 * 为什么不用 chrome --screenshot？那个模式下的 --virtual-time-budget
 * 会加速页面时钟，而 WebSocket 消息按真实时间到达 —— 结果是截到一张
 * 「连上了但一条实时数据都还没有」的空页面。
 *
 * ── 用法 ────────────────────────────────────────────────────────
 *   1) 先**以后台任务方式**起 Chrome（不能写成 `chrome ... &`：
 *      子 shell 里的进程会在那次工具调用结束时被回收，下一句就 ECONNREFUSED）。
 *
 *      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
 *        --headless=new --no-sandbox --disable-setuid-sandbox \
 *        --remote-allow-origins='*' \
 *        --disable-gpu --use-angle=swiftshader --disable-dev-shm-usage \
 *        --no-first-run --no-default-browser-check --disable-extensions \
 *        --hide-scrollbars --remote-debugging-port=9333 \
 *        --user-data-dir=/tmp/pg-chrome-profile --window-size=1680,1050 about:blank
 *
 *      两个参数是**必须**的，缺一个都跑不通：
 *        --no-sandbox             不加 → 子进程 "sandbox initialization failed:
 *                                 Operation not permitted"，GPU 进程 exit_code=6，
 *                                 最后 FATAL: GPU process isn't usable. Goodbye.
 *                                 （注意这跟 GPU 无关，别去折腾 --in-process-gpu）
 *        --remote-allow-origins=* 不加 → CDP WebSocket 握手返回 403
 *
 *   2) node scripts/screenshot.mjs 9333 http://127.0.0.1:5173/app/ out.png 11000 1680 1050
 */

import WebSocket from 'ws';
import { writeFileSync } from 'node:fs';

const PORT = Number(process.argv[2] ?? 9333);
const URL = process.argv[3] ?? 'http://127.0.0.1:5173/app/';
const OUT = process.argv[4] ?? '/tmp/pg-live.png';
const WAIT_MS = Number(process.argv[5] ?? 9000);
const WIDTH = Number(process.argv[6] ?? 1680);
const HEIGHT = Number(process.argv[7] ?? 1050);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // 每次都新开一个空白页再导航过去。
  // 不要复用 /json/list 里的旧 target —— 无头 Chrome 的 renderer 进程
  // 有可能已经僵死（Browser 域还能应答，但 Page/Runtime 域完全不响应）。
  const target = await (
    await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })
  ).json();
  if (!target?.webSocketDebuggerUrl) {
    throw new Error('拿不到新的调试 target，Chrome 可能没起来');
  }

  const ws = new WebSocket(target.webSocketDebuggerUrl, { origin: `http://127.0.0.1:${PORT}` });

  // ⚠️ 监听器必须在 open 之前挂上：Chrome 有时会在握手完成后立刻推事件，
  //    等 await open 之后再挂就会丢掉这些消息（甚至包括命令响应）。
  let seq = 0;
  const pending = new Map();
  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  });

  await new Promise((res, rej) => {
    ws.once('open', res);
    ws.once('error', rej);
  });

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`CDP 超时: ${method}`));
        }
      }, 20_000);
    });

  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: WIDTH,
    height: HEIGHT,
    deviceScaleFactor: 1,
    mobile: false,
  });

  console.log(`  → 打开 ${URL}`);
  await send('Page.navigate', { url: URL });

  console.log(`  → 真实等待 ${WAIT_MS}ms，让实时帧流进来…`);
  await sleep(WAIT_MS);

  const probe = await send('Runtime.evaluate', {
    expression: `JSON.stringify({
      title: document.title,
      panes: document.querySelectorAll('.pane').length,
      livePanes: document.querySelectorAll('.pane.live').length,
      feedItems: document.querySelectorAll('.feed-item').length,
      walletChips: document.querySelectorAll('.wchip').length,
      reasonLines: Array.from(document.querySelectorAll('.reason-line .txt')).map(e => e.textContent).slice(0,4),
      topbar: (document.querySelector('.topbar')?.innerText ?? '').replace(/\\n/g, ' | '),
    })`,
    returnByValue: true,
  });
  console.log('  → 页面探针:', probe.result.value);

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
  console.log(`  → 截图已保存: ${OUT}`);

  ws.close();
}

main().catch((err) => {
  console.error('截图失败:', err.message);
  process.exit(1);
});
