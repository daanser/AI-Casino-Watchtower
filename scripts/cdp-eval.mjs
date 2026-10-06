/**
 * 用 CDP 在已打开的观察台上跑一段表达式，把结果打出来。
 *
 * 用法: node scripts/cdp-eval.mjs <port> <url> <expr> <waitMs> <evalTimeoutMs>
 *
 * ⚠️ 第 5 个参数是 `Runtime.evaluate` 的等待上限，**必须大于表达式自身耗时**。
 *    表达式里 await sleep(22000) 做两次采样时，默认的 20s 会先超时，
 *    报 `CDP 超时: Runtime.evaluate` —— 那不是页面卡住，是我自己掐太早了。
 */
import WebSocket from 'ws';

const PORT = Number(process.argv[2] ?? 9333);
const URL = process.argv[3] ?? 'http://127.0.0.1:5173/app/';
const EXPR = process.argv[4];
const WAIT = Number(process.argv[5] ?? 9000);
const EVAL_TIMEOUT = Number(process.argv[6] ?? 20_000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const target = await (
  await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })
).json();
const ws = new WebSocket(target.webSocketDebuggerUrl, { origin: `http://127.0.0.1:${PORT}` });

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
    }, EVAL_TIMEOUT);
  });

await send('Page.enable');
await send('Page.navigate', { url: URL });
await sleep(WAIT);

const out = await send('Runtime.evaluate', { expression: EXPR, returnByValue: true, awaitPromise: true });

// ⚠️ 页面里抛异常时，`result.value` 是 undefined，异常藏在 `exceptionDetails` 里。
//    只打印 value 会得到一行 `undefined`，完全看不出发生了什么 —— 必须显式检查。
if (out.exceptionDetails) {
  const d = out.exceptionDetails;
  console.error('页面内表达式抛异常:');
  console.error('  ', d.exception?.description ?? d.text ?? JSON.stringify(d));
  process.exitCode = 1;
} else {
  console.log(typeof out.result.value === 'string' ? out.result.value : JSON.stringify(out.result.value, null, 2));
}
ws.close();
