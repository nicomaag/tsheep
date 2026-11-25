/**
 * One live remote shell: `tsh ssh user@node /bin/sh -s` with commands fed on
 * stdin. Ported from tshkeep. One command at a time per shell, a random marker
 * finds the end of each command's output and carries its exit code.
 *
 * Output is streamed while a command runs, so the UI can show it live. A
 * running command can be stopped (or times out) without losing the shell: the
 * command runs in the background of the remote shell, and a small reader next
 * to it kills it when tsheep sends one line on stdin.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { DEFAULT_NODE_SHELL, ENV_KEY, type NodeShell } from '@shared/types'

export type ShellResult = {
  stdout: string
  stderr: string
  code: number | null
  /** Ran into its time limit. */
  timedOut: boolean
  /** Stopped by a person or a client before it finished. */
  stopped: boolean
}
export type Chunk = (stream: 'stdout' | 'stderr', text: string) => void

/** How long a stopped command gets to end before the whole shell is dropped. */
const STOP_GRACE_MS = 15_000

export class Shell {
  readonly marker = `TSHEEP_${randomBytes(12).toString('hex')}`
  private out = ''
  private err = ''
  /** Where the marker search resumes, so long output is not scanned again and again. */
  private outScan = 0
  private errScan = 0
  private child: ChildProcessWithoutNullStreams
  private queue: Promise<unknown> = Promise.resolve()
  private wake: (() => void) | null = null
  private onChunk: Chunk | null = null
  private stopRequest: (() => void) | null = null
  /**
   * What runs each command: "bash" when the node has it, else "sh". Every
   * command gets a child shell of its own, so a syntax error ends that one
   * command and not the session (and its MFA tap) with it.
   */
  interpreter: 'bash' | 'sh' = 'sh'
  /** The node has setsid, so a stop reaches everything the command started. */
  group = false
  /** Set after the connect probe; before that a timeout drops the shell. */
  ready = false
  /** Set once the child exits or cannot start. */
  dead = false
  why = ''
  onDeath: ((why: string) => void) | null = null

  constructor(bin: string, args: string[], env: NodeJS.ProcessEnv) {
    this.child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'], env, windowsHide: true })
    this.child.stdout.setEncoding('utf8').on('data', (d: string) => {
      this.out += d
      this.onChunk?.('stdout', d)
      this.wake?.()
    })
    this.child.stderr.setEncoding('utf8').on('data', (d: string) => {
      this.err += d
      this.onChunk?.('stderr', d)
      this.wake?.()
    })
    const die = (why: string) => {
      if (this.dead) return
      this.dead = true
      this.why = `${why}: ${this.err.trim().slice(-500)}`.replace(/:\s*$/, '')
      this.wake?.()
      this.onDeath?.(this.why)
    }
    this.child.on('error', (e) => die(`could not start ${bin} (${e.message})`))
    this.child.on('exit', (c) => die(`shell exited (code ${c})`))
  }

  /** Ends the shell. Whoever waits for a command in it gets `why` at once. */
  kill(why = 'the shell was closed'): void {
    this.dead = true
    if (!this.why) this.why = why
    try {
      this.child.kill()
    } catch {
      /* already gone */
    }
    this.wake?.()
  }

  /** What tsh wrote to stderr since the current command began (MFA prompts, errors). */
  get stderrSoFar(): string {
    return this.err
  }

  /** Stops the command that is running now. False when none is. */
  stop(): boolean {
    if (!this.stopRequest) return false
    this.stopRequest()
    return true
  }

  run(command: string, timeoutMs: number, onChunk?: Chunk, opts: NodeShell = DEFAULT_NODE_SHELL): Promise<ShellResult> {
    return this.enqueue(() => this.exec(wrap(command, this.interpreter, this.marker, opts, this.group), timeoutMs, onChunk ?? null, true))
  }

  /**
   * A script tsheep wrote itself, run by the remote shell directly instead of
   * a child shell: no argument size limit (file uploads). Cannot be stopped.
   */
  script(text: string, timeoutMs: number): Promise<ShellResult> {
    const m = this.marker
    return this.enqueue(() => this.exec(`${text}\nprintf '\\n%s %s\\n' '${m}' "$?"\nprintf '\\n%s\\n' '${m}' >&2\n`, timeoutMs, null, false))
  }

  private enqueue(task: () => Promise<ShellResult>): Promise<ShellResult> {
    const next = this.queue.then(task)
    this.queue = next.catch(() => undefined)
    return next
  }

  private exec(text: string, timeoutMs: number, onChunk: Chunk | null, stoppable: boolean): Promise<ShellResult> {
    if (this.dead) return Promise.reject(new Error(this.why))
    this.out = ''
    this.err = ''
    this.outScan = 0
    this.errScan = 0
    const m = this.marker
    // Streamed chunks may contain the marker's tail; the UI gets the final cut
    // text with the "entry" event anyway, so a little noise at the end is fine.
    this.onChunk = onChunk
      ? (stream, t) => {
          if (!t.includes(m)) onChunk(stream, t)
        }
      : null
    this.child.stdin.write(text)
    return new Promise((resolve, reject) => {
      let timedOut = false
      let stopped = false
      const timers: NodeJS.Timeout[] = []
      const done = () => {
        timers.forEach(clearTimeout)
        this.wake = null
        this.onChunk = null
        this.stopRequest = null
      }
      const lose = () => {
        // The command did not end after the stop: its output boundary is lost,
        // so this shell is thrown away; the session can open a new one.
        done()
        this.kill()
        resolve({ stdout: cut(this.out, m, 0).text, stderr: cut(this.err, m, 0).text, code: null, timedOut, stopped })
      }
      let halting = false
      const halt = () => {
        if (halting) return
        halting = true
        if (!stoppable || !this.ready) return lose()
        // One line on stdin: the reader next to the command kills it. Sent a
        // few times, in case the remote shell had already buffered the first
        // one as input; a spare line is a no-op there (`:`).
        const line = `: ${m}_stop\n`
        for (const ms of [0, 4000, 8000]) timers.push(setTimeout(() => !this.dead && this.child.stdin.write(line), ms))
        timers.push(setTimeout(lose, STOP_GRACE_MS))
      }
      this.stopRequest = () => {
        if (!timedOut) stopped = true
        halt()
      }
      timers.push(
        setTimeout(() => {
          if (!stopped) timedOut = true
          halt()
        }, timeoutMs),
      )
      this.wake = () => {
        if (this.dead) {
          done()
          return reject(new Error(this.why))
        }
        const o = cut(this.out, m, this.outScan)
        const e = cut(this.err, m, this.errScan)
        this.outScan = Math.max(0, this.out.length - m.length - 32)
        this.errScan = Math.max(0, this.err.length - m.length - 32)
        if (!o.found || !e.found) return
        done()
        resolve({ stdout: o.text, stderr: e.text, code: o.code, timedOut, stopped })
      }
      this.wake()
    })
  }
}

/**
 * The text written to the long-lived remote shell for one command.
 *
 * The command goes, verbatim, into a quoted heredoc (no expansion by the outer
 * shell) and from there into `bash -c` / `sh -c`, started in the background
 * with stdin from /dev/null, so a command that reads stdin cannot eat the
 * following commands. With setsid it gets a process group of its own.
 *
 * Next to it a reader waits for one line on the shell's stdin (fd 9, a copy:
 * background jobs get /dev/null as stdin). When tsheep sends that line the
 * reader stops the command: TERM to its group, KILL five seconds later. When
 * the command ends by itself the reader is killed unread. Then the marker
 * lines carry the exit code and close the output.
 *
 * The node's settings add `-l` (login shell, reads the profile files) and
 * variables through `env`, each value single-quoted.
 */
export function wrap(command: string, interpreter: 'bash' | 'sh', m: string, opts: NodeShell = DEFAULT_NODE_SHELL, group = false): string {
  const delim = `${m}_CMD`
  const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
  const vars = Object.entries(opts.env).filter(([k]) => ENV_KEY.test(k))
  const prefix = vars.length ? `env ${vars.map(([k, v]) => quote(`${k}=${v}`)).join(' ')} ` : ''
  // The group as "-PID", without `--`: dash's kill builtin does not take `--`.
  const target = group ? '"-$__tsheep_pid"' : '"$__tsheep_pid"'
  // One `{ … }` block: the remote shell parses all of it before anything runs,
  // so the reader cannot take bytes of this very text off stdin.
  return [
    '{',
    `__tsheep_cmd=$(cat <<'${delim}'`,
    command,
    delim,
    ')',
    'exec 9<&0',
    `${group ? 'setsid ' : ''}${prefix}${interpreter}${opts.login ? ' -l' : ''} -c "$__tsheep_cmd" < /dev/null 9<&- &`,
    '__tsheep_pid=$!',
    `( read -r __tsheep_line <&9 && { kill -TERM ${target}; sleep 5; kill -KILL ${target}; } ) >/dev/null 2>&1 &`,
    '__tsheep_reader=$!',
    '{ wait "$__tsheep_pid"; } 2>/dev/null',
    '__tsheep_rc=$?',
    '{ kill "$__tsheep_reader"; wait "$__tsheep_reader"; } >/dev/null 2>&1',
    `printf '\\n%s %s\\n' '${m}' "$__tsheep_rc"`,
    `printf '\\n%s\\n' '${m}' >&2`,
    '}',
    '',
  ].join('\n')
}

function cut(buf: string, m: string, from: number): { found: boolean; text: string; code: number } {
  const i = buf.indexOf(m, from)
  if (i === -1) return { found: false, text: buf, code: 0 }
  const code = buf.slice(i + m.length).match(/^\s+(-?\d+)/)
  return { found: true, text: buf.slice(0, i).replace(/\n$/, ''), code: code ? Number(code[1]) : 0 }
}
