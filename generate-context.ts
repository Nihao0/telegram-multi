#!/usr/bin/env bun
/**
 * Generates CLAUDE.md for a given thread agent directory.
 * Combines persistent memory.md + last N messages from history.jsonl.
 *
 * Usage: bun generate-context.ts <thread_id>
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

const threadId = process.argv[2]
if (!threadId || isNaN(Number(threadId))) {
  console.error('Usage: bun generate-context.ts <thread_id>')
  process.exit(1)
}

const HISTORY_LINES = 40  // last N messages to include in context
const agentDir = join(homedir(), '.claude', 'agents', `thread_${threadId}`)

mkdirSync(agentDir, { recursive: true })

const historyFile = join(agentDir, 'history.jsonl')
const memoryFile  = join(agentDir, 'memory.md')

const now = new Date().toISOString().slice(0, 16).replace('T', ' ')
let content = `# Telegram Agent — Thread ${threadId}\n\n`
content += `_Session started: ${now} UTC_\n\n`

// ── Memory ────────────────────────────────────────────────────────────────────

if (existsSync(memoryFile)) {
  const mem = readFileSync(memoryFile, 'utf8').trim()
  if (mem) {
    content += `## Memory\n\n${mem}\n\n`
  }
}

// ── Recent conversation ───────────────────────────────────────────────────────

if (existsSync(historyFile)) {
  const raw = readFileSync(historyFile, 'utf8').trim()
  if (raw) {
    const lines = raw.split('\n').filter(Boolean)
    const total = lines.length
    const recent = lines.slice(-HISTORY_LINES).map(l => {
      try { return JSON.parse(l) } catch { return null }
    }).filter(Boolean)

    if (recent.length > 0) {
      content += `## Recent Conversation`
      if (total > HISTORY_LINES) content += ` (last ${recent.length} of ${total} messages)`
      content += '\n\n'

      for (const m of recent) {
        const ts = new Date(m.ts * 1000).toISOString().slice(0, 16).replace('T', ' ')
        if (m.role === 'user') {
          content += `**${m.from || 'User'} [${ts}]:** ${m.text}\n\n`
        } else {
          content += `**Assistant [${ts}]:** ${m.text}\n\n`
        }
      }
    }
  }
}

// ── Write ─────────────────────────────────────────────────────────────────────

writeFileSync(join(agentDir, 'CLAUDE.md'), content)

const memExists  = existsSync(memoryFile)
const histExists = existsSync(historyFile)
const msgCount   = histExists
  ? readFileSync(historyFile, 'utf8').trim().split('\n').filter(Boolean).length
  : 0

console.log(
  `[context] thread=${threadId} | chars=${content.length} | messages=${msgCount} | memory=${memExists ? 'yes' : 'none'}`
)
