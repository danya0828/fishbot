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

const MEM_PATH = path.join(dir, 'memory.json');
let mem = { groups: {}, users: {} };
try { mem = JSON.parse(fs.readFileSync(MEM_PATH, 'utf8')); } catch { /* 首次运行 */ }
function saveMem() { try { fs.writeFileSync(MEM_PATH, JSON.stringify(mem, null, 2)); } catch (e) { console.log('记忆写入失败', e.message); } }

const history = new Map();
const counters = new Map();
const MAX_HISTORY = 12;
let selfId = String(cfg.selfId || '');
let ws;

function segsOf(msg) {
  // 兼容 array 与 CQ 码字符串两种上报格式
  if (Array.isArray(msg)) return msg;
  if (typeof msg === 'string') {
    const out = [];
    const re = /\[CQ:([a-z_]+)((?:,[^\]]*)?)\]/g;
    let last = 0, m;
    while ((m = re.exec(msg))) {
      if (m.index > last) out.push({ type: 'text', data: { text: msg.slice(last, m.index) } });
      const params = {};
      for (const kv of (m[2] || '').replace(/^,/, '').split(',')) {
        const [k, v] = kv.split('=');
        if (k) params[k] = decodeURIComponent(v ?? '');
      }
      out.push({ type: m[1], data: params });
      last = re.lastIndex;
    }
    if (last < msg.length) out.push({ type: 'text', data: { text: msg.slice(last) } });
    return out;
  }
  return [];
}

function textOnly(segs) {
  return segs.filter(s => s.type === 'text').map(s => s.data?.text ?? '').join('')
    .replace(/^\s*@\S+\s*/, '')
    .trim();
}

function mentioned(segs) {
  return segs.some(s => s.type === 'at' && String(s.data?.qq) === selfId);
}

let seq = 0;
function send(action, params) {
  if (ws?.readyState === 1) ws.send(JSON.stringify({ action, params, echo: String(++seq) }));
}

function memoryBlock(key) {
  const g = mem.groups[key];
  if (!g) return '';
  const lines = [];
  if (g.facts?.length) lines.push('记住的事：' + g.facts.slice(-8).join('；'));
  if (g.summary?.length) lines.push('之前聊过：' + g.summary.slice(-3).join(' / '));
  return lines.length ? '\n\n【本群记忆】\n' + lines.join('\n') : '';
}

async function summarize(key, msgs) {
  try {
    const text = msgs.map(m => m.content).join('\n').slice(-1800);
    const out = await ask([
      { role: 'system', content: '把下面这段群聊压成三句话以内的摘要，只写事实和关系变化，不要评论。' },
      { role: 'user', content: text },
    ]);
    if (!out) return;
    const g = mem.groups[key] ?? { summary: [], facts: [] };
    g.summary = [...(g.summary ?? []), out.replace(/\s*\n+\s*/g, ' ').slice(0, 120)].slice(-6);
    mem.groups[key] = g;
    saveMem();
  } catch (e) { console.log('摘要失败', e.message); }
}

async function ask(messages) {
  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({
      model: cfg.model, messages, temperature: 0.75, max_tokens: 120,
      stop: ['\n', '\n\n'],
    }),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  return (j.choices?.[0]?.message?.content ?? '').trim();
}

function sanitize(raw) {
  const lines = raw.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
  const bad = /^(hmm|ok\b|okay|no\b|fine|weird|too much|keep|final|reply|回复|answer|结论|草稿)[\s:：.。]/i;
  const isEnglish = /^[A-Za-z0-9 ,.'"!?\-:;()]+$/;
  const kept = [];
  for (const line of lines) {
    if (bad.test(line)) continue;
    if (isEnglish.test(line)) continue;
    if (kept.includes(line)) continue;
    kept.push(line);
  }
  const first = (kept[0] ?? lines[0] ?? '').replace(/\s+/g, ' ').trim();
  return first;
}

async function handleMessage(msg) {
  if (String(msg.user_id) === selfId) return;

  const isGroup = msg.message_type === 'group';
  const segs = segsOf(msg.message);
  const text = textOnly(segs);
  const at = mentioned(segs);
  const hitWord = cfg.wakeWords.some(w => text.includes(w));

  // 群白名单：配了就只在这些群活动
  if (isGroup && Array.isArray(cfg.allowedGroups) && cfg.allowedGroups.length > 0
      && !cfg.allowedGroups.includes(msg.group_id)) return;
  // 黑名单用户：这些人的消息永远不回
  if (Array.isArray(cfg.blockedUsers) && cfg.blockedUsers.includes(msg.user_id)) return;

  if (isGroup) {
    const chime = Math.random() < (cfg.chimeChance ?? 0);
    const mustReply = at || hitWord;
    const mode = cfg.replyToGroup ?? 'wake';
    if (mode === 'wake' && !mustReply && !chime) return;
    if (mode === 'all' && !mustReply && !chime) return; // all 也只是多给点插话机会，靠 chimeChance 控制
  } else if (!cfg.replyToPrivate) return;
  if (!text && !at) return;

  const key = isGroup ? `g${msg.group_id}` : `p${msg.user_id}`;
  const hist = history.get(key) ?? [];
  const nickname = msg.sender?.card || msg.sender?.nickname || String(msg.user_id);
  const content = text || '（@了你，没说话）';
  hist.push({ role: 'user', content: `${nickname}：${content}` });
  while (hist.length > MAX_HISTORY) hist.shift();

  let reply;
  try {
    reply = await ask([{ role: 'system', content: persona + memoryBlock(key) }, ...hist]);
  } catch (e) {
    console.log('模型调用失败', e.message);
    return;
  }
  if (!reply) return;

  hist.push({ role: 'assistant', content: reply });
  history.set(key, hist);

  const n = (counters.get(key) ?? 0) + 1;
  counters.set(key, n);
  if (n % 25 === 0) void summarize(key, hist.slice(-25));

  const flat = sanitize(reply);
  if (isGroup) {
    send('send_group_msg', { group_id: msg.group_id, message: [{ type: 'text', data: { text: flat } }] });
  } else {
    send('send_private_msg', { user_id: msg.user_id, message: [{ type: 'text', data: { text: flat } }] });
  }
  console.log(`→ ${key} ${flat}`);
}

function connect() {
  console.log('连接', cfg.ws);
  ws = new WebSocket(cfg.ws, cfg.token ? { headers: { Authorization: `Bearer ${cfg.token}` } } : undefined);

  ws.onopen = () => {
    console.log('已连上 OneBot');
    send('get_login_info', {});
  };
  ws.onclose = () => { console.log('断开，5 秒后重连'); setTimeout(connect, 5000); };
  ws.onerror = (e) => console.log('连接错误', e.message ?? '');
  ws.onmessage = (ev) => {
    let data;
    try { data = JSON.parse(ev.data); } catch { return; }

    // 拿自己的 QQ 号，@ 判定要用
    if (data.status === 'ok' && data.data?.user_id && !selfId) {
      selfId = String(data.data.user_id);
      console.log('我的 QQ 号:', selfId);
      return;
    }
    if (data.post_type === 'message') {
      handleMessage(data).catch(e => console.log('处理失败', e.message));
    }
  };
}

connect();
