export const IPC = {
  SNAPSHOT: 'state:snapshot',
  EVENT: 'state:event',

  INSTALLATIONS_DISCOVER: 'installations:discover',
  INSTALLATIONS_ADD: 'installations:add',
  INSTALLATIONS_REMOVE: 'installations:remove',
  INSTALLATIONS_UPDATE: 'installations:update',
  INSTALLATIONS_REFRESH: 'installations:refresh',
  INSTALLATIONS_LOGIN: 'installations:login',

  NODES_LIST: 'nodes:list',
  NODES_SET_SHELL: 'nodes:setShell',

  SESSIONS_OPEN: 'sessions:open',
  SESSIONS_CLOSE: 'sessions:close',
  SESSIONS_SET_MODE: 'sessions:setMode',
  APPROVALS_ANSWER: 'approvals:answer',
  ENTRIES_REVEAL: 'entries:reveal',
  ENTRIES_STOP: 'entries:stop',
  SESSIONS_RUN: 'sessions:run',
  HISTORY_SEARCH: 'history:search',
  HISTORY_EXPORT: 'history:export',
  SECRETS_FORGET: 'secrets:forget',

  MCP_ROTATE_TOKEN: 'mcp:rotateToken',
  MCP_CONNECT_INFO: 'mcp:connectInfo',

  SETTINGS_SET: 'settings:set',

  WINDOW_PLATFORM: 'window:platform',
  WINDOW_CONTROL: 'window:control',
  APP_PATHS: 'app:paths',
  LOGS_OPEN: 'logs:open',
} as const
