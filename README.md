# tsheep

tsheep keeps Teleport shells (`tsh ssh`) open and hands them to Claude Code sessions through a
built-in MCP server. One MFA tap per node, then any number of commands. Every command shows up
live in the app: what Claude said it does, the command verbatim, the output as it streams, the
exit code.

## Install

Windows: run `tsheep-<version>-win-x64.exe` (unsigned, so SmartScreen asks once; "More info" →
"Run anyway"). Installing over an existing version keeps your data, Start Menu entry and taskbar
pin. macOS: open the DMG and drag tsheep to Applications; it is unsigned, so the first start is
right-click → Open. Installers come from the GitHub release or from a build of your own:

```
pnpm install
pnpm package:win      # release/tsheep-<version>-win-x64.exe
pnpm package:mac      # release/tsheep-<version>-mac-<arch>.dmg (run on a Mac)
```

## Develop

```
pnpm install
pnpm build
pnpm start        # or: pnpm dev for hot reload
pnpm icons        # rebuilds resources/*.png|ico from resources/src
```

`scripts/mcp-call.mjs <tool>` calls one MCP tool the way a Claude session would, with the
arguments as JSON in `$env:MCP_ARGS`. Handy for testing without a Claude session.

On first start tsheep looks for tsh binaries (PATH, Teleport Connect, `~/Tools/teleport-*`) and
`~/.tsh*` profile folders and pairs them by version. Anything it misses can be added under
**Installations**, or by telling your Claude:

> Register my tsh at `C:\Users\me\Tools\teleport\tsh.exe` with TELEPORT_HOME `C:\Users\me\.tsh-staging` in tsheep.

## Connect Claude Code

**Connect Claude** in the sidebar shows the one command to run:

```
claude mcp add --transport http --scope user tsheep http://127.0.0.1:47830/mcp --header "Authorization: Bearer <token>"
```

The server binds to 127.0.0.1 only and needs the token on every request.

## What Claude can do

| Tool                    | Does                                                                 |
| ----------------------- | -------------------------------------------------------------------- |
| `identify`              | Claude passes its session id (and a name, and the root session id when another Claude session started it); tsheep shows the user-made session's title, `claude -r <id>` and repo next to its commands, via the optional local session registry |
| `list_installations`    | Which tsh exist here, logged in or not, which remote logins          |
| `register_installation` | Add a tsh binary (+ TELEPORT_HOME, proxy, MFA mode, auth connector)   |
| `login`                 | Start `tsh login` (passwordless by default, passkey prompt)          |
| `list_nodes`            | Nodes of one installation, from `tsh ls`                             |
| `list_sessions`         | Open shells with purpose, mode and who opened them                   |
| `open_session`          | Open a shell, or reuse the open one for that target                  |
| `run`                   | One command with a mandatory description; stdout, stderr, exit code. `background: true` returns an entry id at once |
| `get_command`           | Status and output tail of a command, optionally waiting for it to end |
| `stop_command`          | Stop a running or queued command; the shell stays open                |
| `upload` / `download`   | Copy a file (up to 100 MB) through the open shell, sha256-checked     |
| `get_node_settings`     | How commands start on a node: login shell, variables, mode rule      |
| `set_node_settings`     | Turn the login shell on or off, set or remove variables for a node   |
| `list_secrets`          | Names of remembered secrets, usable as `{{secret:NAME}}` without asking |
| `forget_secret`         | Drop a remembered secret; the next use asks again                    |
| `close_session`         | Close a shell                                                        |

## Per-installation login

Each installation has a **login via** setting: passkey (passwordless, default, no terminal),
password (`local` connector, tsheep opens a terminal window for it) or an SSO connector name.
The MFA mode for `tsh ssh` is set next to it; use `browser` when the Teleport passkey lives in a
password manager rather than the platform authenticator.

## Approve mode

Each session has a switch in its header: **Free** lets Claude run commands as it likes,
**Approve each** holds every command until you click *Run it* in tsheep. The window comes to the
front with the request, a notification is shown, and *Deny* can carry a reason that Claude gets
back. Nothing runs on a timeout, a closed window or a client that gives up.

Claude may ask for approve mode itself (`open_session` with `mode: "approve"`) but can never
loosen a session. Each node row under **Nodes** has a mode picker: *always approve* locks every
session on that node, *starts free* only sets the starting mode, *default* uses the setting.
Wildcard rules (`web-*`) live under Settings → Node rules; an exact node pick beats them.
Node names are resolved against `tsh ls` before rules apply, so an IP or FQDN of a locked node
is still locked.

## How commands start on a node

Every command runs in a fresh, non-interactive child shell (bash where the node has it), so no
profile file is read and `cd` or `export` do not carry over. Per node, under the cog on its row
in **Nodes** or through `set_node_settings`, you can turn on a **login shell** (reads
`/etc/profile`, `~/.profile`, `~/.bash_profile`, e.g. a `KUBECONFIG` exported there) and set
**variables** for every command. Both show as badges on each command and approval card.

A command runs in the background of the remote shell with a small reader next to it. **Stop**
on a running command (or `stop_command`, or its timeout) sends one line, and the reader ends
the command: TERM to its process group (with `setsid`, so children go too), KILL five seconds
later. The shell stays open. Only if the command still does not end is the shell dropped.

Long jobs (dumps, restores, rollouts) go with `background: true`, up to 24 hours; Claude
follows them with `get_command`. A running command holds its shell, the next ones queue behind
it, so parallel work takes a second session.

Above the timeline of each session you can type commands yourself. They run like Claude's,
with the node's settings, and need no approval, since you are the one who would approve them.

## History

**History** in the sidebar searches every kept day: text in description, command, output or
reason, node, who ran it, how it ended. The result exports as Markdown (to read or attach to a
ticket) or JSONL (to process).

## Rules for Claude

The MCP server sends its own instructions when a client connects (identify first, wait while a
login runs, reuse sessions, secrets as `{{secret:NAME}}`, background jobs, harmless tests). They
are `INSTRUCTIONS` in `src/main/mcp.ts`; nobody has to copy them into a CLAUDE.md. What is yours
alone (cluster names, which login to use) stays in your own instruction file.

## Output colours

In the window, the usual status words in a command's output are coloured: green for
`active (running)`, `Running`, `UP`; red for `failed`, `DOWN`, `ALERT`, `CrashLoopBackOff`; amber
for `WARNING`, `Pending`. A fixed list in `src/renderer/src/components/Colored.tsx`; Claude and the
history get the plain text.

## Diagnostic log

Off by default; **Settings → Diagnostic log** turns it on. tsheep then writes one text file per
day to `logs/` in its data folder (kept two weeks): each `tsh login` with what tsh answered, each
shell connecting, connected, failing or closing with tsh's stderr, and each MCP tool call with
who, target and duration. No command text and no output; those are in the history. Use it to find
out afterwards why a login or a shell hung.

## Secrets

Claude writes `{{secret:NAME}}` instead of a password or token. tsheep asks you for the value,
inserts it when the command runs and removes it from the output, so Claude only ever sees the
placeholder. Values can be kept for the current run or encrypted on this machine (Electron
`safeStorage`); the timeline can reveal them to you, and only to you.

## Status

Phases 1 to 3 are done: discovery, sessions, MCP, live timeline, light and dark theme, approve
mode, secrets, tray, history across restarts, installers for Windows and macOS. Since 0.3:
stop without losing the shell, background jobs, file transfer, History search and export,
your own commands from the app. Open: code signing, auto-update.

## License

MIT, see [LICENSE](LICENSE).
