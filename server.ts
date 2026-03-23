#!/usr/bin/env bun
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { readFileSync, statSync, realpathSync, appendFileSync, writeFileSync, mkdirSync } from 'fs'
import { homedir } from 'os'
import { join, extname, sep } from 'path'

// ── Config ────────────────────────────────────────────────────────────────────

const STATE_DIR = join(homedir(), '.claude', 'channels', 'telegram-multi')
try {
  for (const line of readFileSync(join(STATE_DIR, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^(\w+)=(.*)$/)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2]
  }
} catch {}

// TELEGRAM_THREAD_ID may come from env (direct) or from file (via agent.sh)
const THREAD_ID = Number(
  process.env.TELEGRAM_THREAD_ID ||
  (() => { try { return readFileSync(join(STATE_DIR, 'thread_id'), 'utf8').trim() } catch { return '0' } })()
) || 0
const PROXY_HOST = process.env.TELEGRAM_PROXY_HOST || ''
const AUTH_TOKEN = process.env.TELEGRAM_AUTH_TOKEN || ''
const PROXY_URL  = `wss://${PROXY_HOST}/ipc`

const MAX_CHUNK    = 4096
const MAX_FILE_MB  = 50 * 1024 * 1024
const PHOTO_EXTS   = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp'])

// ── Per-thread agent directory ────────────────────────────────────────────────

const AGENT_DIR = THREAD_ID
  ? join(homedir(), '.claude', 'agents', `thread_${THREAD_ID}`)
  : ''

if (AGENT_DIR) {
  try { mkdirSync(AGENT_DIR, { recursive: true }) } catch {}
}

// ── History ───────────────────────────────────────────────────────────────────

interface HistoryEntry {
  role: 'user' | 'assistant'
  text: string
  from?: string
  ts: number
}

function appendHistory(entry: HistoryEntry) {
  if (!AGENT_DIR) return
  try { appendFileSync(join(AGENT_DIR, 'history.jsonl'), JSON.stringify(entry) + '\n') } catch {}
}

// ── MCP Server ────────────────────────────────────────────────────────────────

const mcp = new Server(
  { name: 'telegram-multi', version: '1.0.0' },
  {
    capabilities: { tools: {} },
    instructions: THREAD_ID
      ? [
          `You are a Telegram agent for forum topic thread_id=${THREAD_ID}.`,
          '',
          'PRIMARY LOOP — run forever without stopping:',
          '  1. Call wait_for_message',
          '  2. If timeout:true → call wait_for_message again immediately',
          '  3. If message received → think, call reply(text="your response"), go to step 1',
          '',
          'MEMORY RULES:',
          '  - After learning something important about the user, their preferences or ongoing tasks →',
          '    call save_memory(content="...") with a concise Markdown summary.',
          '  - Memory persists across sessions and is shown to you at startup in CLAUDE.md.',
          '  - Update memory by calling save_memory again (it overwrites, so include all known facts).',
          '',
          'STRICT RULES:',
          '  - NEVER stop the loop. NEVER output text — only reply() reaches the user.',
          '  - Respond naturally in the language the user writes in.',
        ].join('\n')
      : 'Telegram agent (no thread configured)',
  },
)

// ── State ─────────────────────────────────────────────────────────────────────

let proxyWs: WebSocket | null = null
let connected = false
let chatId = ''
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let heartbeatTimer: ReturnType<typeof setInterval> | null = null

// Message queue for wait_for_message tool
const msgQueue: any[] = []
let msgResolver: ((m: any) => void) | null = null

function enqueue(m: any) {
  // Save to history
  const text = m.text || m.caption || ''
  const from = m.from?.first_name
    ? `${m.from.first_name}${m.from.username ? ` @${m.from.username}` : ''}`
    : 'User'
  appendHistory({ role: 'user', text: text || '(no text)', from, ts: Math.floor(Date.now() / 1000) })

  if (msgResolver) { msgResolver(m); msgResolver = null }
  else msgQueue.push(m)
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function assertSendable(f: string) {
  try {
    const real = realpathSync(f)
    const base = (() => { try { return realpathSync(STATE_DIR) } catch { return STATE_DIR } })()
    if (real.startsWith(base + sep)) throw new Error(`refusing state file: ${f}`)
  } catch (e: any) {
    if (e.message.startsWith('refusing')) throw e
  }
}

function chunk(text: string, limit: number): string[] {
  if (text.length <= limit) return [text]
  const out: string[] = []
  let rest = text
  while (rest.length > limit) {
    const nl = rest.lastIndexOf('\n', limit)
    const cut = nl > limit / 2 ? nl : limit
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  if (rest) out.push(rest)
  return out
}

function sendToProxy(msg: Record<string, unknown>) {
  if (!proxyWs || !connected) return
  try { proxyWs.send(JSON.stringify(msg)) } catch {}
}

// ── Proxy connection ──────────────────────────────────────────────────────────

function connect() {
  if (!PROXY_HOST || !AUTH_TOKEN || !THREAD_ID) return

  try {
    if (proxyWs) { proxyWs.onopen = proxyWs.onmessage = proxyWs.onclose = proxyWs.onerror = null; proxyWs.close() }
    const ws = new WebSocket(PROXY_URL)
    proxyWs = ws

    ws.onopen = () => {
      connected = true
      process.stderr.write(`telegram-multi: connected, registering thread=${THREAD_ID}\n`)
      ws.send(JSON.stringify({ type: 'register', thread_id: THREAD_ID, chat_id: chatId, auth_token: AUTH_TOKEN }))
      heartbeatTimer = setInterval(() => ws.readyState === 1 && ws.send('{"type":"ping"}'), 30000)
    }

    ws.onmessage = e => {
      try { onProxyMsg(JSON.parse(e.data as string)) } catch {}
    }

    ws.onclose = () => {
      connected = false
      if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null }
      process.stderr.write('telegram-multi: disconnected, reconnecting in 3s...\n')
      if (!reconnectTimer) reconnectTimer = setTimeout(() => { reconnectTimer = null; connect() }, 3000)
    }

    ws.onerror = () => { connected = false }
  } catch (e: any) {
    process.stderr.write(`telegram-multi: connect error: ${e.message}\n`)
    if (!reconnectTimer) reconnectTimer = setTimeout(() => { reconnectTimer = null; connect() }, 3000)
  }
}

// ── Handle proxy messages ─────────────────────────────────────────────────────

function onProxyMsg(msg: any) {
  if (msg.type === 'registered') {
    chatId = msg.chat_id || chatId
    process.stderr.write(`telegram-multi: registered for thread=${msg.thread_id}\n`)
    return
  }

  if (msg.type !== 'incoming_message') return
  const m = msg.message
  if (m.thread_id !== THREAD_ID) return
  if (m.chat_id) chatId = String(m.chat_id)

  const from = m.from?.first_name
    ? `${m.from.first_name}${m.from.username ? ` @${m.from.username}` : ''}`
    : 'User'

  process.stderr.write(`telegram-multi: message queued from ${from}\n`)
  enqueue(m)
}

// ── Tools ─────────────────────────────────────────────────────────────────────

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: THREAD_ID ? [
    {
      name: 'wait_for_message',
      description: 'Wait for next Telegram message (blocks up to 55s). Returns message object or {timeout:true}. Call in a loop forever.',
      inputSchema: { type: 'object' as const, properties: {} },
    },
    {
      name: 'reply',
      description: 'Send a message to the Telegram topic. MUST be called to respond — text output is not visible to user.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          text: { type: 'string', description: 'Message text' },
          chat_id: { type: 'string', description: 'Auto-detected if omitted' },
          reply_to: { type: 'number', description: 'message_id to reply to (optional)' },
          files: { type: 'array', items: { type: 'string' }, description: 'File paths to attach' },
        },
        required: ['text'],
      },
    },
    {
      name: 'save_memory',
      description: 'Persist important facts about the user, their preferences and ongoing tasks to memory. This memory is loaded at the start of every future session. Call this whenever you learn something worth remembering. Overwrites previous memory, so include ALL facts each time.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          content: { type: 'string', description: 'Full memory content in Markdown. Include all known user facts, preferences, ongoing tasks.' },
        },
        required: ['content'],
      },
    },
    {
      name: 'react',
      description: 'Add emoji reaction to a Telegram message.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          chat_id: { type: 'string' },
          message_id: { type: 'number' },
          emoji: { type: 'string', description: 'e.g. 👍 ❤️ 🔥' },
        },
        required: ['chat_id', 'message_id', 'emoji'],
      },
    },
    {
      name: 'edit_message',
      description: 'Edit a previously sent bot message.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          chat_id: { type: 'string' },
          message_id: { type: 'number' },
          text: { type: 'string' },
        },
        required: ['chat_id', 'message_id', 'text'],
      },
    },
  ] : [],
}))

mcp.setRequestHandler(CallToolRequestSchema, async req => {
  const a = (req.params.arguments ?? {}) as Record<string, any>
  try {
    switch (req.params.name) {
      case 'wait_for_message': {
        if (msgQueue.length > 0) {
          const m = msgQueue.shift()
          return { content: [{ type: 'text', text: JSON.stringify(m) }] }
        }
        const m = await Promise.race([
          new Promise<any>(res => { msgResolver = res }),
          new Promise<null>(res => setTimeout(() => res(null), 55000)),
        ])
        if (!m) return { content: [{ type: 'text', text: JSON.stringify({ timeout: true }) }] }
        return { content: [{ type: 'text', text: JSON.stringify(m) }] }
      }

      case 'reply': {
        const cid = a.chat_id || chatId
        if (!cid) return { content: [{ type: 'text', text: 'error: chat_id unknown' }], isError: true }
        const files: string[] = a.files ?? []
        for (const f of files) {
          assertSendable(f)
          if (statSync(f).size > MAX_FILE_MB) throw new Error(`file too large: ${f}`)
        }
        const text = String(a.text)
        for (const c of chunk(text, MAX_CHUNK))
          sendToProxy({ type: 'send_message', chat_id: cid, thread_id: THREAD_ID, text: c, reply_to: a.reply_to })
        for (const f of files)
          sendToProxy({ type: PHOTO_EXTS.has(extname(f).toLowerCase()) ? 'send_photo' : 'send_document', chat_id: cid, thread_id: THREAD_ID, file_path: f })
        // Save assistant reply to history
        appendHistory({ role: 'assistant', text, ts: Math.floor(Date.now() / 1000) })
        return { content: [{ type: 'text', text: 'sent' }] }
      }

      case 'save_memory': {
        if (!AGENT_DIR) return { content: [{ type: 'text', text: 'error: no thread configured' }], isError: true }
        writeFileSync(join(AGENT_DIR, 'memory.md'), String(a.content || ''))
        process.stderr.write('telegram-multi: memory saved\n')
        return { content: [{ type: 'text', text: 'memory saved' }] }
      }

      case 'react':
        sendToProxy({ type: 'react', chat_id: a.chat_id, message_id: Number(a.message_id), emoji: a.emoji })
        return { content: [{ type: 'text', text: 'reacted' }] }

      case 'edit_message':
        sendToProxy({ type: 'edit_message', chat_id: a.chat_id, message_id: Number(a.message_id), text: a.text })
        return { content: [{ type: 'text', text: 'edited' }] }

      default:
        return { content: [{ type: 'text', text: `unknown tool: ${req.params.name}` }], isError: true }
    }
  } catch (e: any) {
    return { content: [{ type: 'text', text: `error: ${e.message}` }], isError: true }
  }
})

// ── Start ─────────────────────────────────────────────────────────────────────

await mcp.connect(new StdioServerTransport())
process.stderr.write(`telegram-multi: MCP ready, thread=${THREAD_ID || 'none'}, agent_dir=${AGENT_DIR || 'none'}\n`)
connect()
