import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
const persona = fs.readFileSync(path.join(dir, 'persona.md'), 'utf8');

if (!cfg.apiKey || cfg.apiKey.startsWith('在这里')) {
  console.error('config.json 里还没填 apiKey');
  process.exit(1);
}

const history = new Map(); // key -> [{role, content}]
const MAX_HISTORY = 12;

function textOf(segments) {
  if (typeof segments === 'string') return segments;
  return segments.filter(s => s.type === 'text').map(s => s.data.text).join('');
}

function atMe(segments, selfId) {
  if (!Array.isArray(segments)) return false;
  return segments.some(s => s.type === 'at' && String(s.data.qq) === String(selfId));
}

function stripAt(segments) {
  if (typeof segments === 'string') return segments.trim();
  return segments.map(s => s.type === 'text' ? s.data.text : '').join('').trim();
}

let ws;
let seq = 0;

function connect() {
  console.log('连接', cfg.ws);
  ws = new WebSocket(cfg.ws, cfg.token ? { headers: { Authorization: `Bearer ${cfg.token}` } } : undefined);

  ws.onopen = () => console.log('已连上 OneBot');
  ws.onclose = () => { console.log('断开，5 秒后重连'); setTimeout(connect, 5000); };
  ws.onerror = (e) => console.log('连接错误', e.message ?? '');
  ws.onmessage = (ev) => {
    let data;
    try { data = JSON.parse(ev.data); } catch { return; }
    if (data.post_type === 'message') handleMessage(data).catch(e => console.log('处理失败', e.message));
  };
}

function send(action, params) {
  if (!ws || ws.readyState !== 1) return;
  ws.send(JSON.stringify({ action, params, echo: String(++seq) }));
}

async function ask(messages) {
  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({ model: cfg.model, messages, temperature: 1.1, max_tokens: 200 }),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  return (j.choices?.[0]?.message?.content ?? '').trim();
}

async function handleMessage(msg) {
  const selfId = msg.self_id;
  if (String(msg.user_id) === String(selfId)) return;

  const isGroup = msg.message_type === 'group';
  const text = stripAt(msg.message);
  if (!text) return;

  const mentioned = atMe(msg.message, selfId);
  const hitWord = cfg.wakeWords.some(w => text.includes(w));

  if (isGroup && cfg.replyToGroup === 'wake' && !mentioned && !hitWord) return;
  if (!isGroup && !cfg.replyToPrivate) return;

  const key = isGroup ? `g${msg.group_id}` : `p${msg.user_id}`;
  const hist = history.get(key) ?? [];
  const nickname = msg.sender?.card || msg.sender?.nickname || String(msg.user_id);
  hist.push({ role: 'user', content: `${nickname}：${text}` });
  while (hist.length > MAX_HISTORY) hist.shift();

  let reply;
  try {
    reply = await ask([{ role: 'system', content: persona }, ...hist]);
  } catch (e) {
    console.log('模型调用失败', e.message);
    return;
  }
  if (!reply) return;

  hist.push({ role: 'assistant', content: reply });
  history.set(key, hist);

  // 只发一行：换行压成空格
  const flat = reply.replace(/\s*\n+\s*/g, ' ').trim();

  if (isGroup) {
    send('send_group_msg', { group_id: msg.group_id, message: [{ type: 'text', data: { text: flat } }] });
  } else {
    send('send_private_msg', { user_id: msg.user_id, message: [{ type: 'text', data: { text: flat } }] });
  }
  console.log(`→ ${key} ${flat}`);
}

connect();
