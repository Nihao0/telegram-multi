#!/usr/bin/env bun
/**
 * Telegram Multi-Thread Channel for Claude Code.
 * Connects to the proxy via WebSocket and delivers messages to Claude
 * via notifications/claude/channel (injected as user input).
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { readFileSync, statSync, realpathSync } from 'fs'
import { homedir } from 'os'
import { join, extname, sep } from 'path'

// ── Config ───────────────────────────────────────────────────────────────────

const STATE_DIR = join(homedir(), '.claude', 'channels', 'telegram-multi')
const ENV_FILE = join(STATE_DIR, '.env')

try {
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = line.match(/^(\w+)=(.*)$/)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2]
  }
} catch {}

const THREAD_ID = Number(process.env.TELEGRAM_THREAD_ID)
const PROXY_HOST = process.env.TELEGRAM_PROXY_HOST || '127.0.0.1'
const AUTH_TOKEN = process.env.TELEGRAM_AUTH_TOKEN || ''
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || ''
const PROXY_URL = `wss://${PROXY_HOST}/ipc`

if (!THREAD_ID) {
  process.stderr.write(
    'telegram-multi: TELEGRAM_THREAD_ID is required\n' +
    '  TELEGRAM_THREAD_ID=42 claude --dangerously-load-development-channels plugin:telegram-multi@<path>\n',
  )
  process.exit(1)
}

if (!AUTH_TOKEN) {
  process.stderr.write(
    `telegram-multi: TELEGRAM_AUTH_TOKEN is required\n  set in ${ENV_FILE} or via env\n`,
  )
  process.exit(1)
}

// ── State ────────────────────────────────────────────────────────────────────

let proxyWs: WebSocket | null = null
let connected = false
let chatId = CHAT_ID
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let heartbeatTimer: ReturnType<typeof setInterval> | null = null

const MAX_CHUNK = 4096
const MAX_FILE_BYTES = 50 * 1024 * 1024
const PHOTO_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp'])

// ── Security ─────────────────────────────────────────────────────────────────

function assertSendable(f: string): void {
  let real: string
  try { real = realpathSync(f) } catch { return }
  const stateReal = (() => { try { return realpathSync(STATE_DIR) } catch { return STATE_DIR } })()
  if (real.startsWith(stateReal + sep)) {
    throw new Error(`refusing to send channel state: ${f}`)
  }
}

// ── Text chunking ─────────────────────────────────────────────────────────────

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

// ── IPC ───────────────────────────────────────────────────────────────────────

function sendToProxy(msg: Record<string, unknown>): void {
  if (!proxyWs || !connected) {
    process.stderr.write('telegram-multi: not connected to proxy, dropping message\n')
    return
  }
  proxyWs.send(JSON.stringify(msg))
}

function connectToProxy(): void {
  if (proxyWs) {
    proxyWs.onopen = null
    proxyWs.onmessage = null
    proxyWs.onclose = null
    proxyWs.onerror = null
    proxyWs.close()
  }

  process.stderr.write(`telegram-multi: connecting to ${PROXY_URL}...\n`)

  const ws = new WebSocket(PROXY_URL)
  proxyWs = ws

  ws.onopen = () => {
    connected = true
    process.stderr.write(`telegram-multi: connected, registering thread=${THREAD_ID}\n`)
    sendToProxy({ type: 'register', thread_id: THREAD_ID, chat_id: chatId, auth_token: AUTH_TOKEN })

    if (heartbeatTimer) clearInterval(heartbeatTimer)
    heartbeatTimer = setInterval(() => {
      if (connected && ws.readyState === WebSocket.OPEN) {
        ws.send('{"type":"ping"}')
      }
    }, 30000)
  }

  ws.onmessage = event => {
    try { handleProxyMessage(JSON.parse(event.data as string)) } catch {}
  }

  ws.onclose = () => {
    connected = false
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null }
    process.stderr.write('telegram-multi: disconnected, reconnecting in 3s...\n')
    scheduleReconnect()
  }

  ws.onerror = () => {
    connected = false
    process.stderr.write('telegram-multi: connection error\n')
    scheduleReconnect()
  }
}

function scheduleReconnect(): void {
  if (reconnectTimer) return
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connectToProxy() }, 3000)
}

// ── Handle proxy messages ─────────────────────────────────────────────────────

function handleProxyMessage(msg: any): void {
  switch (msg.type) {
    case 'registered':
      chatId = msg.chat_id || chatId
      process.stderr.write(`telegram-multi: registered for thread=${msg.thread_id}\n`)
      break

    case 'incoming_message': {
      const m = msg.message
      if (m.thread_id !== THREAD_ID) return
      chatId = chatId || String(m.chat_id)

      const text = m.text || m.caption || ''

      // Build content for Claude's user turn
      const parts: string[] = []
      if (m.from?.first_name) parts.push(`[${m.from.first_name}${m.from.username ? ` @${m.from.username}` : ''}]`)
      if (text) parts.push(text)
      if (m.photo) parts.push(`[photo attached: ${m.photo.file_path || m.photo.file_id}]`)
      if (m.document) parts.push(`[document: ${m.document.file_name} → ${m.document.file_path || m.document.file_id}]`)
      if (m.voice?.transcription) parts.push(`[voice: ${m.voice.transcription}]`)

      const content = parts.join('\n')

      // Inject as user input to Claude via channel notification
      mcp.notification({
        method: 'notifications/claude/channel',
        params: {
          content,
          meta: {
            chat_id: String(m.chat_id),
            message_id: m.message_id,
            thread_id: m.thread_id,
            user: m.from?.first_name,
            user_id: m.from?.id,
            username: m.from?.username,
            ts: Date.now(),
            image_path: m.photo?.file_path,
            document_path: m.document?.file_path,
            voice_path: m.voice?.file_path,
          },
        },
      } as any).catch((err: any) => {
        process.stderr.write(`telegram-multi: notification error: ${err?.message}\n`)
      })
      break
    }
  }
}

// ── MCP Server ────────────────────────────────────────────────────────────────

const mcp = new Server(
  { name: 'telegram-multi', version: '1.0.0' },
  {
    capabilities: { tools: {} },
    instructions: [
      `You are an AI agent in Telegram forum topic (thread_id=${THREAD_ID}).`,
      'Messages arrive automatically — you do NOT need to poll for them.',
      'When you receive a message, respond by calling the reply tool.',
      'Use react to add emoji reactions, edit_message to update sent messages.',
      'The user communicates only through Telegram, not the terminal.',
    ].join('\n'),
  },
)

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'reply',
      description: 'Send a message to Telegram in the current forum topic.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          chat_id: { type: 'string' as const, description: 'Telegram chat ID (from incoming message meta)' },
          text: { type: 'string' as const, description: 'Message text (Markdown supported)' },
          reply_to: { type: 'number' as const, description: 'message_id to thread under (optional)' },
          files: {
            type: 'array' as const,
            items: { type: 'string' as const },
            description: 'Absolute file paths to attach (max 50MB each)',
          },
        },
        required: ['chat_id', 'text'],
      },
    },
    {
      name: 'react',
      description: 'Add an emoji reaction to a Telegram message.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          chat_id: { type: 'string' as const },
          message_id: { type: 'number' as const },
          emoji: { type: 'string' as const, description: 'e.g. 👍 ❤️ 🔥' },
        },
        required: ['chat_id', 'message_id', 'emoji'],
      },
    },
    {
      name: 'edit_message',
      description: 'Edit a message the bot previously sent.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          chat_id: { type: 'string' as const },
          message_id: { type: 'number' as const },
          text: { type: 'string' as const },
        },
        required: ['chat_id', 'message_id', 'text'],
      },
    },
  ],
}))

mcp.setRequestHandler(CallToolRequestSchema, async req => {
  const args = (req.params.arguments ?? {}) as Record<string, unknown>
  try {
    switch (req.params.name) {
      case 'reply': {
        const chat_id = args.chat_id as string
        const text = args.text as string
        const reply_to = args.reply_to != null ? Number(args.reply_to) : undefined
        const files = (args.files as string[] | undefined) ?? []

        for (const f of files) {
          assertSendable(f)
          if (statSync(f).size > MAX_FILE_BYTES)
            throw new Error(`file too large: ${f} (max 50MB)`)
        }

        for (const c of chunk(text, MAX_CHUNK)) {
          sendToProxy({ type: 'send_message', chat_id, thread_id: THREAD_ID, text: c, reply_to })
        }

        for (const f of files) {
          const isPhoto = PHOTO_EXTS.has(extname(f).toLowerCase())
          sendToProxy({
            type: isPhoto ? 'send_photo' : 'send_document',
            chat_id, thread_id: THREAD_ID, file_path: f, reply_to,
          })
        }

        return { content: [{ type: 'text', text: `sent (${chunk(text, MAX_CHUNK).length} chunk(s), ${files.length} file(s))` }] }
      }

      case 'react':
        sendToProxy({ type: 'react', chat_id: args.chat_id, message_id: Number(args.message_id), emoji: args.emoji })
        return { content: [{ type: 'text', text: 'reacted' }] }

      case 'edit_message':
        sendToProxy({ type: 'edit_message', chat_id: args.chat_id, message_id: Number(args.message_id), text: args.text })
        return { content: [{ type: 'text', text: 'edited' }] }

      default:
        return { content: [{ type: 'text', text: `unknown tool: ${req.params.name}` }], isError: true }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { content: [{ type: 'text', text: `${req.params.name} failed: ${msg}` }], isError: true }
  }
})

await mcp.connect(new StdioServerTransport())
connectToProxy()
