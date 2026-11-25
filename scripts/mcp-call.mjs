#!/usr/bin/env node
// Calls one tsheep MCP tool from the command line, the way a Claude session would.
//   node scripts/mcp-call.mjs list_installations
//   node scripts/mcp-call.mjs run '{"session_id":"…","command":"uptime","description":"Shows load"}'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

// Token and port from the app's config, or from TSHEEP_TOKEN / TSHEEP_PORT when
// this shell does not see the same AppData as the app (a sandboxed tool shell).
const appData = process.env.APPDATA || join(process.env.HOME, 'Library', 'Application Support')
let cfg = { token: process.env.TSHEEP_TOKEN, settings: { port: Number(process.env.TSHEEP_PORT || 47830) } }
if (!cfg.token) cfg = JSON.parse(readFileSync(join(appData, 'tsheep', 'config.json'), 'utf8'))
// Args as the second argument, or in MCP_ARGS (easier to quote from PowerShell).
const [tool, argsArg] = process.argv.slice(2)
const argsJson = argsArg ?? process.env.MCP_ARGS
if (!tool) {
  console.error('usage: node scripts/mcp-call.mjs <tool> [json-args]')
  process.exit(2)
}

const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${cfg.settings.port}/mcp`), {
  requestInit: { headers: { authorization: `Bearer ${cfg.token}` } },
})
const client = new Client({ name: 'mcp-call test', version: '0.1.0' })
await client.connect(transport)
if (tool === 'tools') {
  const { tools } = await client.listTools()
  console.log(tools.map((t) => `${t.name}: ${t.description.split('.')[0]}`).join('\n'))
} else if (tool === 'batch') {
  // Several calls over ONE connection, like a real Claude session:
  //   MCP_ARGS = [{"tool":"identify","args":{...}}, {"tool":"run","args":{...}}]
  // "$SESSION" in a string argument is replaced by the id of the last open_session answer.
  let sessionId = ''
  for (const step of JSON.parse(argsJson)) {
    const args = JSON.parse(JSON.stringify(step.args ?? {}).replaceAll('$SESSION', sessionId))
    const result = await client.callTool({ name: step.tool, arguments: args }, undefined, { timeout: 600_000 })
    const body = result.content.map((c) => (c.type === 'text' ? c.text : JSON.stringify(c))).join('\n')
    console.log(`=== ${step.tool} ===\n${body}`)
    if (step.tool === 'open_session' && !result.isError) sessionId = JSON.parse(body).session.id
  }
} else {
  const result = await client.callTool({ name: tool, arguments: argsJson ? JSON.parse(argsJson) : {} }, undefined, { timeout: 240_000 })
  for (const c of result.content) console.log(c.type === 'text' ? c.text : JSON.stringify(c))
  if (result.isError) process.exitCode = 1
}
await client.close()
