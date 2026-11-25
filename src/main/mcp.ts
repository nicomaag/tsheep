/**
 * The MCP server Claude sessions talk to.
 *
 * Plain MCP over Streamable HTTP, bound to 127.0.0.1 only, every request with
 * a bearer token compared in constant time, Host and Origin checked so a web
 * page in a browser cannot drive it.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import type { Actor, McpClient, McpStatus } from '@shared/types'
import { config } from './config'
import { bus } from './events'
import { lookupSession } from './registry'
import { registerTools } from './tools'

const MAX_BODY = 1_000_000

/**
 * How to work with tsheep, sent to every client when it connects, so the rules
 * need not be copied into each person's own instruction files.
 */
const INSTRUCTIONS = `tsheep keeps Teleport shells (tsh ssh) open on the person's machine and shows them every command you run. Use it for any shell command on a Teleport node; never run "tsh ssh" yourself, each call would cost the person an MFA tap.

Order of work:
1. identify once, with your Claude Code session id (and root_session_id if another session started you), so the person sees where commands come from.
2. list_installations. Certificate expired: call login, tell the person to approve the passkey prompt, then look at list_installations again. While it shows login_in_progress, wait. Do not start a second login, do not run tsh login yourself and do not open a session yet: two MFA prompts at once block each other.
3. list_sessions, and reuse an open shell to the same target. Otherwise open_session with a real purpose and tell the person an MFA prompt is coming. Use mode "approve" for anything that touches production state. Leave sessions open; other Claude sessions share them and the idle timeout closes them.
4. run, with a description that says plainly what the command does and why: it is the headline the person reads, and in approve mode what they decide on. If the answer is "denied", read the reason and do not retry the command unchanged.

Rules:
- Passwords, tokens and keys never go into a command. Write {{secret:NAME}}; tsheep asks the person for the value and removes it from the output.
- Anything longer than a few minutes runs with background: true and is followed with get_command; stop_command ends it. A running command holds its session.
- Files go through upload and download, not base64 through run.
- A missing variable such as KUBECONFIG is fixed once with set_node_settings, not exported in every command.
- When you test something, send only harmless, read-only commands.`

let http: Server | null = null
let port = 0
let lastError: string | null = null
const transports = new Map<string, StreamableHTTPServerTransport>()
const clients = new Map<string, McpClient>()

export function mcpStatus(): McpStatus {
  const p = port || config.settings().port
  return {
    running: http !== null,
    port: p,
    url: `http://127.0.0.1:${p}/mcp`,
    error: lastError,
    clients: [...clients.values()],
  }
}

/** Who is calling: the label shown, and the Claude session behind it when known. */
export function actorOf(sessionId: string | undefined): Actor {
  const c = sessionId ? clients.get(sessionId) : undefined
  if (!c) return { label: 'unknown client', claudeSessionId: null, repo: null, branch: null, ownLabel: null, ownSessionId: null }
  c.lastSeenAt = Date.now()
  return { label: c.label, claudeSessionId: c.claudeSessionId, repo: c.repo, branch: c.branch, ownLabel: c.ownLabel, ownSessionId: c.ownSessionId }
}

/**
 * A client saying which Claude session it is, and on whose behalf it works.
 *
 * The person wants the session they made themselves: its title, its id to
 * resume. A session Claude started (a side session, a sub-session) has a
 * generated name and an id nobody wants to resume, so when the client names a
 * root session, the root is what tsheep shows and the client's own session
 * only rides along for the tooltip and the logs. The registry, when
 * reachable, supplies the titles; a name the client gave fills the gap.
 */
export async function identifyClient(sessionId: string | undefined, claudeSessionId: string | null, rootSessionId: string | null, name: string | null): Promise<McpClient | null> {
  const c = sessionId ? clients.get(sessionId) : undefined
  if (!c) return null
  if (name) c.label = name
  const shown = rootSessionId ?? claudeSessionId
  if (shown) {
    c.claudeSessionId = shown
    c.resumeCommand = `claude -r ${shown}`
    const info = await lookupSession(shown)
    if (info) {
      if (info.displayName) c.label = info.displayName
      c.resumeCommand = info.resumeCommand
      c.claudeUrl = info.claudeUrl
      c.repo = info.repo
      c.branch = info.branch
    }
  }
  if (rootSessionId && claudeSessionId && claudeSessionId !== rootSessionId) {
    c.ownSessionId = claudeSessionId
    const own = await lookupSession(claudeSessionId)
    c.ownLabel = own?.displayName ?? name ?? `Claude ${claudeSessionId.slice(0, 8)}`
  } else {
    c.ownSessionId = null
    c.ownLabel = null
  }
  bus.publish({ type: 'mcp', status: mcpStatus() })
  return c
}

let clientCounter = 0

/** "Claude #4" for a claude-code client, "<name> #4" for anything else. */
function autoLabel(name: string): string {
  clientCounter += 1
  const base = /claude/i.test(name) ? 'Claude' : name.split(' ')[0] || 'Client'
  return `${base} #${clientCounter}`
}

export function connectCommand(): string {
  return `claude mcp add --transport http --scope user tsheep ${mcpStatus().url} --header "Authorization: Bearer ${config.token()}"`
}

export async function startMcp(): Promise<McpStatus> {
  if (http) return mcpStatus()
  const wanted = config.settings().port
  lastError = null
  await new Promise<void>((resolve) => {
    const server = createServer((req, res) => void handle(req, res))
    server.on('error', (e: NodeJS.ErrnoException) => {
      lastError = e.code === 'EADDRINUSE' ? `Port ${wanted} is already in use.` : e.message
      http = null
      bus.publish({ type: 'mcp', status: mcpStatus() })
      resolve()
    })
    server.listen(wanted, '127.0.0.1', () => {
      http = server
      port = wanted
      bus.publish({ type: 'mcp', status: mcpStatus() })
      resolve()
    })
  })
  return mcpStatus()
}

export async function stopMcp(): Promise<void> {
  for (const t of transports.values()) await t.close().catch(() => undefined)
  transports.clear()
  clients.clear()
  await new Promise<void>((resolve) => (http ? http.close(() => resolve()) : resolve()))
  http = null
  bus.publish({ type: 'mcp', status: mcpStatus() })
}

export async function restartMcp(): Promise<McpStatus> {
  await stopMcp()
  return startMcp()
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
  if (url.pathname !== '/mcp') return reply(res, 404, { error: 'not found' })
  if (!hostOk(req)) return reply(res, 403, { error: 'forbidden host or origin' })
  if (!tokenOk(req)) return reply(res, 401, { error: 'bad token' })

  const sessionId = header(req, 'mcp-session-id')

  try {
    if (req.method === 'POST') {
      const body = await readBody(req)
      if (body === null) return reply(res, 413, { error: 'body too large' })
      const parsed = body ? JSON.parse(body) : undefined

      let transport = sessionId ? transports.get(sessionId) : undefined
      if (!transport) {
        if (sessionId || !isInitializeRequest(parsed)) {
          return reply(res, 400, { jsonrpc: '2.0', error: { code: -32000, message: 'No valid session. Initialize first.' }, id: null })
        }
        transport = await openSession(parsed)
      }
      await transport.handleRequest(req, res, parsed)
      return
    }
    if (req.method === 'GET' || req.method === 'DELETE') {
      const transport = sessionId ? transports.get(sessionId) : undefined
      if (!transport) return reply(res, 400, { error: 'unknown session' })
      await transport.handleRequest(req, res)
      return
    }
    reply(res, 405, { error: 'method not allowed' })
  } catch (e) {
    console.error('[mcp]', e)
    if (!res.headersSent) reply(res, 500, { error: (e as Error).message })
  }
}

async function openSession(initBody: unknown): Promise<StreamableHTTPServerTransport> {
  const name = clientNameFrom(initBody)
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (id) => {
      transports.set(id, transport)
      clients.set(id, { id, name, label: autoLabel(name), claudeSessionId: null, resumeCommand: null, claudeUrl: null, repo: null, branch: null, ownSessionId: null, ownLabel: null, connectedAt: Date.now(), lastSeenAt: Date.now() })
      bus.publish({ type: 'mcp', status: mcpStatus() })
    },
    onsessionclosed: (id) => {
      transports.delete(id)
      clients.delete(id)
      bus.publish({ type: 'mcp', status: mcpStatus() })
    },
  })
  transport.onclose = () => {
    const id = transport.sessionId
    if (id && transports.get(id) === transport) {
      transports.delete(id)
      clients.delete(id)
      bus.publish({ type: 'mcp', status: mcpStatus() })
    }
  }
  // logging: the run heartbeat falls back to log notifications when the client sent no progress token.
  const server = new McpServer({ name: 'tsheep', version: '0.3.5' }, { capabilities: { logging: {} }, instructions: INSTRUCTIONS })
  registerTools(server)
  await server.connect(transport)
  return transport
}

function clientNameFrom(body: unknown): string {
  const b = body as { params?: { clientInfo?: { name?: string; version?: string } } } | undefined
  const info = b?.params?.clientInfo
  return info?.name ? `${info.name}${info.version ? ` ${info.version}` : ''}` : 'MCP client'
}

function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name]
  return Array.isArray(v) ? v[0] : v
}

function tokenOk(req: IncomingMessage): boolean {
  const given = header(req, 'authorization') ?? ''
  const expected = `Bearer ${config.token()}`
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

function hostOk(req: IncomingMessage): boolean {
  const host = header(req, 'host')
  if (!host) return false
  const h = host.replace(/:\d+$/, '')
  if (h !== '127.0.0.1' && h !== 'localhost' && h !== '[::1]') return false
  const origin = header(req, 'origin')
  if (!origin) return true
  try {
    const o = new URL(origin).hostname
    return o === '127.0.0.1' || o === 'localhost' || o === '[::1]'
  } catch {
    return false
  }
}

function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve, reject) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (c: string) => {
      body += c
      if (body.length > MAX_BODY) {
        resolve(null)
        req.destroy()
      }
    })
    req.on('end', () => resolve(body))
    req.on('error', reject)
  })
}

function reply(res: ServerResponse, status: number, obj: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(obj))
}
