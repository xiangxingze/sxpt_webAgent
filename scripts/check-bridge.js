// 桥接服务自测：来源校验、健康检查、请求应答、事件广播、无面板时取消订阅
require('./source-loader');
const path = require('path');
const http = require('http');
const { WebSocket } = require('ws');
const { BridgeServer, isTrustedOrigin, isLocalTakeoverRequest, PROTOCOL_VERSION } = require(path.join(__dirname, '..', 'out', 'bridge', 'server.js'));

let fail = 0;
function expect(name, cond, extra) {
  if (cond) {
    console.log('ok ' + name);
  } else {
    console.error('FAIL ' + name + (extra ? ' -> ' + extra : ''));
    fail++;
  }
}

// ---------- 来源校验 ----------
expect('平台同源（经代理的 X-Forwarded-Host）', isTrustedOrigin({ origin: 'https://sxpt.example.com', 'x-forwarded-host': 'sxpt.example.com', host: '127.0.0.1:8845' }));
expect('直接访问时与 Host 同源', isTrustedOrigin({ origin: 'http://10.0.0.8:8844', host: '10.0.0.8:8844' }));
expect('多级代理的 X-Forwarded-Host 列表', isTrustedOrigin({ origin: 'http://192.168.100.187:8048', 'x-forwarded-host': 'gw.local, 192.168.100.187:8048' }));
expect('拒绝其他网站', !isTrustedOrigin({ origin: 'https://evil.example', 'x-forwarded-host': 'sxpt.example.com', host: '10.0.0.8:8844' }));
expect('拒绝端口不同的同主机', !isTrustedOrigin({ origin: 'http://10.0.0.8:9999', host: '10.0.0.8:8844' }));
expect('拒绝非法 Origin', !isTrustedOrigin({ origin: 'null', host: '10.0.0.8:8844' }));
expect('本机脚本不带 Origin', isTrustedOrigin({ host: '127.0.0.1:8845' }));

// ---------- 服务 ----------
function fakeService() {
  const listeners = new Set();
  return {
    listeners,
    handled: [],
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    async handle(msg) {
      this.handled.push(msg);
      if (msg.type === 'boom') throw new Error('炸了');
      return { ok: true, echo: msg.type };
    },
    emit(event) {
      for (const fn of listeners) fn(event);
    }
  };
}

function freePort() {
  return new Promise((resolve) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function getJson(port, p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body: body ? JSON.parse(body) : undefined }));
    }).on('error', reject);
  });
}

function connect(port, headers = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers });
    const inbox = [];
    ws.on('message', (d) => inbox.push(JSON.parse(d.toString())));
    ws.on('open', () => resolve({ ws, inbox, ok: true }));
    ws.on('unexpected-response', (_req, res) => resolve({ ok: false, status: res.statusCode }));
    ws.on('error', () => resolve({ ok: false }));
  });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, ms = 2000) {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await wait(10);
  return cond();
}

async function main() {
  const port = await freePort();
  const service = fakeService();
  const counts = [];
  const bridge = new BridgeServer(service, () => {}, port, '9.9.9', (n) => counts.push(n));
  expect('监听成功', await bridge.start());

  const health = await getJson(port, '/health');
  expect('健康检查', health.status === 200 && health.body.ok && health.body.version === '9.9.9' && health.body.protocol === PROTOCOL_VERSION);
  expect('其他路径 404', (await getJson(port, '/nope')).status === 404);

  const evil = await connect(port, { Origin: 'https://evil.example' });
  expect('其他网站的握手被拒绝', !evil.ok && evil.status === 403);

  const a = await connect(port, { Origin: 'http://platform.local', 'X-Forwarded-Host': 'platform.local' });
  const b = await connect(port);
  expect('平台面板可以连接', a.ok && b.ok);
  expect('有面板时订阅 Agent 事件', service.listeners.size === 1 && bridge.clientCount === 2);

  a.ws.send(JSON.stringify({ id: 7, type: 'hello' }));
  expect('请求得到带 replyTo 的应答', await until(() => a.inbox.some((m) => m.type === 'reply' && m.replyTo === 7 && m.data.echo === 'hello')));
  a.ws.send(JSON.stringify({ id: 8, type: 'boom' }));
  expect('处理异常时应答失败信息', await until(() => a.inbox.some((m) => m.replyTo === 8 && m.data.ok === false && m.data.message === '炸了')));
  a.ws.send('not json');
  a.ws.send(JSON.stringify({ type: 'stop' }));
  expect('无 id 的请求不应答、非法 JSON 被忽略', await until(() => service.handled.some((m) => m.type === 'stop')) && !a.inbox.some((m) => m.replyTo === undefined && m.type === 'reply'));

  service.emit({ type: 'textDelta', text: '你好' });
  expect('事件广播给所有面板', await until(() => a.inbox.some((m) => m.type === 'textDelta') && b.inbox.some((m) => m.type === 'textDelta' && m.text === '你好')));

  a.ws.close();
  b.ws.close();
  expect('面板全部断开后取消订阅（审批改用原生弹窗）', await until(() => service.listeners.size === 0 && bridge.clientCount === 0));
  expect('连接数变化有通知', counts.includes(2) && counts[counts.length - 1] === 0);

  // ---------- 接管请求来源校验 ----------
  expect('本机实例的接管请求被接受', isLocalTakeoverRequest({ 'x-sxpt-takeover': '1', host: '127.0.0.1:8845' }));
  expect('浏览器（带 Origin）的接管请求被拒绝', !isLocalTakeoverRequest({ 'x-sxpt-takeover': '1', origin: 'http://platform.local' }));
  expect('经代理转发的接管请求被拒绝', !isLocalTakeoverRequest({ 'x-sxpt-takeover': '1', 'x-forwarded-for': '10.0.0.1' }));
  expect('缺少接管头被拒绝', !isLocalTakeoverRequest({ host: '127.0.0.1:8845' }));
  expect('浏览器经代理发起接管得到 403', (await postTakeover(port, { 'x-sxpt-takeover': '1', 'X-Forwarded-For': '10.0.0.1' })) === 403);

  // ---------- 刷新页面后新窗口接管端口 ----------
  const panel = await connect(port);
  expect('接管前面板连在旧窗口', panel.ok && bridge.clientCount === 1);
  const panelClosed = new Promise((resolve) => panel.ws.on('close', resolve));
  const newer = new BridgeServer(fakeService(), () => {}, port, '9.9.10');
  expect('端口被占用时首次启动返回 false', (await newer.start()) === false);
  await panelClosed;
  expect('旧窗口让出端口并断开面板', bridge.isReleased && bridge.clientCount === 0);
  expect('新窗口接管端口', await until(() => newer.clientCount === 0 && newer['server']?.listening === true, 3000));
  const health2 = await getJson(port, '/health');
  expect('健康检查来自新窗口', health2.body?.version === '9.9.10', JSON.stringify(health2.body));
  await wait(400);
  expect('让出后的旧窗口不再抢回端口', bridge.isReleased && !bridge['server'] && !bridge['retry']);

  // 占用端口的不是 SXPT Agent：接管失败后按退避重试，不抛错
  const other = http.createServer((_req, res) => {
    res.statusCode = 404;
    res.end();
  });
  const otherPort = await freePort();
  await new Promise((r) => other.listen(otherPort, '127.0.0.1', r));
  const blocked = new BridgeServer(fakeService(), () => {}, otherPort, '9.9.9');
  expect('端口被其他程序占用时返回 false', (await blocked.start()) === false);
  await wait(300);
  expect('接管失败不会让出自己（继续重试）', !blocked.isReleased);
  blocked.dispose();
  other.close();
  newer.dispose();
  bridge.dispose();
}

function postTakeover(port, headers) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/takeover', method: 'POST', agent: false, headers }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', () => resolve(0));
    req.end();
  });
}

main()
  .catch((err) => {
    console.error(err);
    fail++;
  })
  .finally(() => {
    if (fail) {
      console.error(`check-bridge: ${fail} failed`);
      process.exit(1);
    }
    console.log('check-bridge: all passed');
    process.exit(0);
  });
