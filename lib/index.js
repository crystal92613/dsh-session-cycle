/**
 * dsh-session-cycle
 *
 * 上下文涨到阈值时：
 *   1. 给当前会话注入提示，让它写"交接备忘"，并用 <<<HANDOFF>>> 包着只回复正文
 *      （同时 memory_remember 进记忆库；不落本地交接文件）；
 *   2. 抓到回复后，新建会话接到同一工作区：
 *        - 旧会话改名：<原标题> <MM-DD>
 *        - 新会话改名：<原标题>（名字延续，列表里看着还是同一个人）
 *        - 旧会话归档到归档集，归档后仍可用 session_recall 读原文
 *   3. 按 session-cycle.json 的 bindings 清单，把指向旧会话的挂接改到新会话；
 *   4. 把交接注入新会话。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync, statSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { spawn } from 'node:child_process'
import { join, dirname, isAbsolute } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'

export const name = 'dsh-session-cycle'
export const inject = ['agents', 'tools']

const DEFAULTS = {
  enabled: true,
  workspace: 'E:\\dsh-workspace\\dsh-chat',
  peerKey: 'c2c:AA68B682F9838254790D271EE56FD083',
  contextWindow: 1048576,
  thresholdRatio: 0.6,
  cooldownMinutes: 30,
  provider: 'deepseek-account',
  model: 'deepseek-flash',
  pendingTimeoutMinutes: 15,
  archiveOld: true,
  /** 对所有会话生效（不只绑定会话）；默认只盯绑定会话。 */
  /** 点选要监控的会话 id；空 = 只看绑定会话。 */
  watchSessionIds: [],
  /** 只在会话空闲时触发，避免正在跑任务时被换页。 */
  onlyWhenIdle: true,
  /** 会话清理：时间与空间两条都满足才删；空间超了时间不到只提示。 */
  cleanup: {
    enabled: true,
    keepDays: 30,
    totalSizeMB: 2000,
    checkMinutes: 60,
    keepRecent: 3,
  },
  bindings: [
    'qqbot/force-session.json',
    'storages/heartbeat-random/config.json',
  ],
}

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const HANDOFF_OPEN = '<<<HANDOFF>>>'
const HANDOFF_CLOSE = '<<<END>>>'
const ROUTE_PREFIX = '/session-cycle'
const SESSION_ROOTS = ['sessions', 'archived-sessions']

/** 默认交接提示词（用户可整段改；插件只在末尾追加固定格式要求，不显示在设置页）。 */
const DEFAULT_HANDOFF_HEADER = '上下文快满了，帮我把这段时间整理成交接备忘。'
const HANDOFF_CORE = [
  '格式要求：',
  '1. 六格写（填不满就空着，别写小作文）：',
  '   ## 资产/能力（有什么 / 怎么用一句话 / 什么限制）',
  '   ## 关系状态',
  '   ## 最近发生（3~5 条，只写改变了什么）',
  '   ## 现在的偏好/雷区',
  '   ## 未完成（答应过的、说到一半的）',
  '   ## 上次说到哪（最后一句话在聊什么）',
  '2. 最后**只回复**交接正文，用 <<<HANDOFF>>> 和 <<<END>>> 包住，前后不要写别的。',
].join('\n')

/** 默认新会话注入提示词（支持 {handoff}）。 */
const DEFAULT_INJECT_PROMPT = [
  '【上一页的交接】下面是你上一个会话的交接备忘。你现在接着聊，不要复述这份交接，也不要提“交接/换会话”这些词。细节不够时可以用 session_recall 读旧会话原文：旧会话 id 是 {oldSessionId}，不传参默认读的也是它。',
  '',
  '{handoff}',
].join('\n')

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function userMessage(text) {
  return { id: randomUUID(), role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }
}

/** 会话元信息缓存：mtime+size 变了才重扫。 */
const sessionMetaCache = new Map()

/** 顺序解帧，遇到 session/title 或 message 就停；4MB 上限兜底。 */
function scanSessionMeta(home, sessionId) {
  const file = findSessionFile(home, sessionId)
  if (file === null) return { title: '', hasContent: false }
  let st
  try { st = statSync(file) } catch { return { title: '', hasContent: false } }
  const cached = sessionMetaCache.get(sessionId)
  if (cached !== undefined && cached.size === st.size && cached.mtime === st.mtimeMs) return cached.meta
  let title = ''
  let hasContent = false
  try {
    const raw = readFileSync(file)
    const offs = []
    let i = raw.indexOf(MAGIC, 0)
    while (i !== -1) { offs.push(i); i = raw.indexOf(MAGIC, i + 4) }
    for (let k = 0; k < offs.length; k += 1) {
      const end = k + 1 < offs.length ? offs[k + 1] : raw.length
      let text = ''
      try { text = zstdDecompressSync(raw.subarray(offs[k], end)).toString('utf8') } catch { continue }
      for (const line of text.split('\n')) {
        if (!line.startsWith('{')) continue
        if (!hasContent && line.includes('"user/message"')) hasContent = true
        if (line.includes('"session/title"')) {
          try {
            const e = JSON.parse(line)
            const t = e?.data?.title
            if (typeof t === 'string' && t.trim().length > 0) title = t.trim()
          } catch { /* ignore */ }
        }
      }
    }
  } catch { /* ignore */ }
  const meta = { title, hasContent }
  sessionMetaCache.set(sessionId, { size: st.size, mtime: st.mtimeMs, meta })
  return meta
}
/** 在 sessions / archived-sessions 下找会话文件。 */
function findSessionFile(home, sessionId) {
  for (const root of SESSION_ROOTS) {
    const base = join(home, root)
    if (!existsSync(base)) continue
    let workspaces = []
    try { workspaces = readdirSync(base) } catch { continue }
    for (const ws of workspaces) {
      for (const name of ['session.v4.jsonl.zstd', 'session.jsonl.zstd']) {
        const p = join(base, ws, sessionId, name)
        if (existsSync(p)) return p
      }
    }
  }
  return null
}

/** sessions 目录总大小（MB）。 */
function sessionsSizeMB(home) {
  let total = 0
  const base = join(home, 'sessions')
  if (!existsSync(base)) return 0
  let workspaces = []
  try { workspaces = readdirSync(base) } catch { return 0 }
  for (const ws of workspaces) {
    let ids = []
    try { ids = readdirSync(join(base, ws)) } catch { continue }
    for (const id of ids) {
      for (const name of ['session.v4.jsonl.zstd', 'session.jsonl.zstd']) {
        const p = join(base, ws, id, name)
        try {
          const st = statSync(p)
          total += st.size
          break
        } catch { /* not this name */ }
      }
    }
  }
  return Math.round((total / (1024 * 1024)) * 10) / 10
}

/** 删除一个会话的目录，并从 workspace.json 的名单里摘掉。 */
function deleteSessionFiles(home, sessionId) {
  let removed = false
  for (const root of SESSION_ROOTS) {
    const base = join(home, root)
    if (!existsSync(base)) continue
    let workspaces = []
    try { workspaces = readdirSync(base) } catch { continue }
    for (const ws of workspaces) {
      const dir = join(base, ws, sessionId)
      if (!existsSync(dir)) continue
      try {
        rmSync(dir, { recursive: true, force: true })
        removed = true
      } catch { /* ignore */ }
    }
  }
  try {
    const file = join(home, 'storages', 'workspace.json')
    if (existsSync(file)) {
      const data = JSON.parse(readFileSync(file, 'utf8'))
      let changed = false
      for (const ws of Object.values(data?.tables?.workspaces ?? {})) {
        if (Array.isArray(ws.sessionIds) && ws.sessionIds.includes(sessionId)) {
          ws.sessionIds = ws.sessionIds.filter((x) => x !== sessionId)
          changed = true
        }
      }
      if (changed) writeJson(file, data)
    }
  } catch { /* ignore */ }
  try {
    const file = join(home, 'storages', 'archive.json')
    if (existsSync(file)) {
      const data = JSON.parse(readFileSync(file, 'utf8'))
      const list = Array.isArray(data?.archivedSessionIds) ? data.archivedSessionIds : Array.isArray(data) ? data : null
      if (list !== null && list.includes(sessionId)) {
        const next = list.filter((x) => x !== sessionId)
        writeJson(file, Array.isArray(data) ? next : { ...data, archivedSessionIds: next })
      }
    }
  } catch { /* ignore */ }
  return removed
}

function readSessionEvents(home, sessionId, limit) {
  const file = findSessionFile(home, sessionId)
  if (file === null) return []
  try {
    const raw = readFileSync(file)
    const offs = []
    let i = raw.indexOf(MAGIC, 0)
    while (i !== -1) { offs.push(i); i = raw.indexOf(MAGIC, i + 4) }
    void limit
    const events = []
    for (let k = 0; k < offs.length; k += 1) {
      const end = k + 1 < offs.length ? offs[k + 1] : raw.length
      let text
      try { text = zstdDecompressSync(raw.subarray(offs[k], end)).toString('utf8') } catch { continue }
      for (const line of text.split('\n')) {
        if (!line.startsWith('{')) continue
        try { events.push(JSON.parse(line)) } catch { /* skip */ }
      }
    }
    return events
  } catch {
    return []
  }
}

function readTitle(home, sessionId) {
  const events = readSessionEvents(home, sessionId)
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i]
    if (e?.type !== 'session/title') continue
    const title = e?.data?.title
    if (typeof title === 'string' && title.trim().length > 0) return title.trim()
  }
  return null
}

function readSessionHeader(home, sessionId) {
  const file = findSessionFile(home, sessionId)
  if (file === null) return null
  try {
    const raw = readFileSync(file)
    const i = raw.indexOf(MAGIC, 0)
    if (i === -1) return null
    const text = zstdDecompressSync(raw.subarray(i)).toString('utf8')
    for (const line of text.split('\n')) {
      if (!line.startsWith('{')) continue
      const e = JSON.parse(line)
      if (e?.type === 'session') return e
      if (e?.type !== undefined) break
    }
  } catch { /* ignore */ }
  return null
}

function readReasoningEffort(home, sessionId) {
  const events = readSessionEvents(home, sessionId)
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i]
    if (e?.type !== 'model/selection') continue
    const v = e?.data?.reasoningEffort
    if (typeof v === 'string' && v.length > 0) return v
  }
  return null
}

function messageText(e) {
  const content = e?.data?.message?.content ?? e?.data?.content ?? []
  if (!Array.isArray(content)) return ''
  return content
    .map((c) => (typeof c === 'string' ? c : c?.type === 'text' ? c.text ?? '' : ''))
    .join('')
    .trim()
}

function tailDialogue(home, sessionId, limit) {
  const events = readSessionEvents(home, sessionId)
  const out = []
  for (const e of events) {
    if (e.type !== 'assistant/message' && e.type !== 'user/message') continue
    const body = messageText(e)
    if (body === '') continue
    out.push((e.type === 'assistant/message' ? '我: ' : '对方: ') + body.slice(0, 1200))
  }
  return out.slice(-Math.max(1, Math.min(200, Number(limit) || 20)))
}

async function attachToWorkspace(ctx, sessionId, cwd, log) {
  try {
    const reg = ctx.get?.('workspaceRegistry')
    if (reg !== undefined && typeof reg.resolveByPath === 'function') {
      const ws = await reg.resolveByPath(cwd)
      if (ws !== undefined && ws !== null && typeof ws.attachSession === 'function') {
        const ids = Array.isArray(ws.sessionIds) ? ws.sessionIds : []
        if (!ids.includes(sessionId)) await ws.attachSession(sessionId)
        log(`attached via registry: ${sessionId} -> ${String(ws.path ?? cwd)}`)
        return true
      }
    }
  } catch (error) {
    log(`attach registry failed: ${error?.message ?? error}`)
  }
  try {
    const file = join(dshHome(), 'storages', 'workspace.json')
    if (!existsSync(file)) return false
    const data = JSON.parse(readFileSync(file, 'utf8'))
    let changed = false
    for (const ws of Object.values(data?.tables?.workspaces ?? {})) {
      if (String(ws?.path ?? '').toLowerCase() !== String(cwd).toLowerCase()) continue
      ws.sessionIds = Array.isArray(ws.sessionIds) ? ws.sessionIds : []
      if (!ws.sessionIds.includes(sessionId)) { ws.sessionIds.push(sessionId); changed = true }
      break
    }
    if (!changed) return false
    writeJson(file, data)
    log(`attached via file: ${sessionId}`)
    return true
  } catch (error) {
    log(`attach file failed: ${error?.message ?? error}`)
    return false
  }
}

function replaceSessionId(node, oldId, newId) {
  let n = 0
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i += 1) {
      if (typeof node[i] === 'string' && node[i] === oldId) { node[i] = newId; n += 1 } else if (node[i] !== null && typeof node[i] === 'object') n += replaceSessionId(node[i], oldId, newId)
    }
    return n
  }
  for (const key of Object.keys(node ?? {})) {
    const v = node[key]
    if (typeof v === 'string' && v === oldId) { node[key] = newId; n += 1 } else if (v !== null && typeof v === 'object') n += replaceSessionId(v, oldId, newId)
  }
  return n
}

export function apply(ctx, config = {}) {
  const home = dshHome()
  const logFile = join(home, 'logs', 'session-cycle.log')
  const log = (message) => {
    try {
      mkdirSync(dirname(logFile), { recursive: true })
      writeFileSync(logFile, `[${new Date().toISOString()}] ${message}\n`, { encoding: 'utf8', flag: 'a' })
    } catch { /* ignore */ }
  }

  const cfgFile = join(home, 'session-cycle.json')
  const stateFile = join(home, 'session-cycle-state.json')

  const cfg = () => {
    const fileCfg = readJson(cfgFile, {})
    const merged = { ...DEFAULTS, ...(config ?? {}), ...fileCfg }
    if (!Array.isArray(merged.bindings) || merged.bindings.length === 0) merged.bindings = [...DEFAULTS.bindings]
    return merged
  }

  const state = readJson(stateFile, { currentSessionId: null, pendings: {}, lastTriggerBy: {}, history: [] })
  if (state.pendings === undefined) state.pendings = {}
  if (state.lastTriggerBy === undefined) state.lastTriggerBy = {}
  const saveState = () => {
    try { writeJson(stateFile, state) } catch (error) { log(`save state failed: ${error?.message ?? error}`) }
  }

  const threshold = () => Math.floor(cfg().contextWindow * cfg().thresholdRatio)

  function resolveCurrentId() {
    const c = cfg()
    if (typeof state.currentSessionId === 'string' && state.currentSessionId.length > 0) return state.currentSessionId
    const data = readJson(join(home, 'qqbot', 'force-session.json'), null)
    const mapped = data?.sessions?.[c.peerKey] ?? data?.[c.peerKey]
    if (typeof mapped === 'string' && mapped.length > 0) {
      state.currentSessionId = mapped
      saveState()
      return mapped
    }
    return null
  }

  function rebind(oldId, newId) {
    const notes = []
    for (const rel of cfg().bindings) {
      const file = isAbsolute(rel) ? rel : join(home, rel)
      if (!existsSync(file)) continue
      let data
      try { data = JSON.parse(readFileSync(file, 'utf8')) } catch (error) {
        log(`binding skip (bad json) ${rel}: ${error?.message ?? error}`)
        continue
      }
      const n = replaceSessionId(data, oldId, newId)
      if (n === 0) continue
      try {
        try { writeFileSync(`${file}.bak-cycle-${Date.now()}`, readFileSync(file)) } catch { /* ignore */ }
        writeJson(file, data)
        notes.push(`${rel}×${n}`)
      } catch (error) {
        log(`binding write failed ${rel}: ${error?.message ?? error}`)
      }
    }
    log(`rebind ${oldId} -> ${newId} (${notes.join(', ') || 'no binding matched'})`)
    return notes
  }

  function mountPreset() {
    try {
      const presets = ctx.get?.('agentPresets')
      if (presets === undefined || typeof presets.mount !== 'function') return async () => {}
      return async (agentCtx) => {
        try { await presets.mount(agentCtx, 'standard') } catch (error) { log(`preset mount failed: ${error?.message ?? error}`) }
      }
    } catch { return async () => {} }
  }

  function agentOf(sessionId) {
    try {
      const a = ctx.agents?.get?.(sessionId)
      if (a !== undefined && a !== null) return a
    } catch { /* ignore */ }
    return undefined
  }

  async function rename(sessionId, title) {
    const agent = agentOf(sessionId)
    try {
      const titles = ctx.get?.('sessionTitle')
      if (titles !== undefined && typeof titles.rename === 'function' && agent !== undefined) {
        await titles.rename(agent.session, title)
        log(`renamed ${sessionId} -> ${JSON.stringify(title)}`)
        return true
      }
    } catch (error) {
      log(`rename via sessionTitle failed: ${error?.message ?? error}`)
    }
    try {
      const sc = ctx.get?.('sessionController')
      if (sc !== undefined && typeof sc.rename === 'function') {
        await sc.rename({ sessionId, title })
        log(`renamed via sessionController ${sessionId} -> ${JSON.stringify(title)}`)
        return true
      }
    } catch (error) {
      log(`rename via sessionController failed: ${error?.message ?? error}`)
    }
    return false
  }

  async function archive(sessionId) {
    try {
      const reg = ctx.get?.('workspaceRegistry')
      if (reg === undefined || typeof reg.archiveSession !== 'function') { log('archive unavailable: no workspaceRegistry'); return false }
      await reg.archiveSession(sessionId, { stopActivity: false })
      log(`archived ${sessionId}`)
      return true
    } catch (error) {
      log(`archive failed ${sessionId}: ${error?.message ?? error}`)
      return false
    }
  }

  function makeTitle(handoff, fallbackBase) {
    const pick = (heading) => {
      const re = new RegExp(`##\\s*${heading}[^\\n]*\\n([\\s\\S]*?)(?=\\n##|$)`)
      const m = handoff.match(re)
      return m ? m[1] : ''
    }
    const candidates = [pick('上次说到哪'), pick('最近发生'), handoff]
    let text = ''
    for (const block of candidates) {
      const line = block
        .split('\n')
        .map((l) => l.replace(/^[\s\-*•\d.、]+/, '').trim())
        .find((l) => l.length > 0 && !l.startsWith('##'))
      if (line !== undefined) { text = line; break }
    }
    text = text.replace(/[`*_>#]/g, '').replace(/\s+/g, ' ').trim()
    if (text.length === 0) text = fallbackBase
    return text.slice(0, 28)
  }

  function idleOf(sessionId) {
    const agent = agentOf(sessionId)
    if (agent === undefined) return false
    const status = String(agent.status ?? '')
    return status === '' ? true : status === 'idle'
  }

  function beginHandoff(sessionId, usage) {
    const c = cfg()
    const id = String(sessionId)
    const agent = agentOf(id)
    if (agent === undefined) { log(`trigger skipped sid=${id}: agent missing`); return false }
    if (c.onlyWhenIdle !== false && !idleOf(id)) { log(`trigger skipped sid=${id}: busy`); return false }
    const header = typeof c.handoffHeader === 'string' && c.handoffHeader.trim().length > 0 ? c.handoffHeader.trim() : DEFAULT_HANDOFF_HEADER
    const prompt = `【该换页了：上下文已用 ${usage} token（阈值 ${threshold()}）】\n${header}\n\n${HANDOFF_CORE}`
    try {
      agent.followup(userMessage(prompt))
    } catch (error) {
      log(`followup failed sid=${id}: ${error?.message ?? error}`)
      return false
    }
    state.pendings = { ...(state.pendings ?? {}), [id]: { at: Date.now(), usage, title: readTitle(home, id) } }
    state.lastTriggerBy = { ...(state.lastTriggerBy ?? {}), [id]: Date.now() }
    saveState()
    log(`handoff requested sid=${id} usage=${usage} threshold=${threshold()} oldTitle=${JSON.stringify(state.pendings[id].title)}`)
    return true
  }

  function extractHandoff(text) {
    const open = text.indexOf(HANDOFF_OPEN)
    if (open === -1) return ''
    const close = text.indexOf(HANDOFF_CLOSE, open + HANDOFF_OPEN.length)
    const body = close === -1
      ? text.slice(open + HANDOFF_OPEN.length)
      : text.slice(open + HANDOFF_OPEN.length, close)
    return body.trim()
  }

  async function finishRotation(oldIdRaw, handoff) {
    const c = cfg()
    const oldId = String(oldIdRaw)
    const pendings = state.pendings ?? {}
    const pending = pendings[oldId]
    if (pending === undefined) return false
    const agentOld = agentOf(oldId)
    const cwd = String(agentOld?.session?.header?.cwd ?? agentOld?.session?.cwd ?? c.workspace ?? '')
    const newId = `session-cycle-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
    const oldTitle = typeof pending.title === 'string' && pending.title.length > 0
      ? pending.title
      : (readTitle(home, oldId) ?? '会话')
    const stamp = (() => {
      const d = new Date()
      return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    })()
    const inheritedEffort = readReasoningEffort(home, oldId)
    const agentOptions = { provider: c.provider, model: c.model }
    if (inheritedEffort !== null) agentOptions.reasoningEffort = inheritedEffort
    let created
    try {
      created = await ctx.agents.create({
        sessionId: newId,
        meta: cwd === '' ? {} : { cwd },
        agentOptions,
        setup: mountPreset(),
      })
    } catch (error) {
      log(`create failed sid=${oldId}: ${error?.message ?? error}`)
      return false
    }
    const agent = created?.agent ?? created
    if (agent === undefined) { log('create returned no agent'); return false }
    if (cwd !== '') await attachToWorkspace(ctx, newId, cwd, log)
    rebind(oldId, newId)
    if (oldId === resolveCurrentId()) state.currentSessionId = newId
    state.lastRotatedTo = { id: newId, cwd, at: Date.now() }
    await rename(oldId, `${oldTitle} ${stamp}`)
    await rename(newId, oldTitle)
    if (c.archiveOld) await archive(oldId)
    state.history = [...(state.history ?? []), oldId].slice(-100)
    const nextPendings = { ...(state.pendings ?? {}) }
    delete nextPendings[oldId]
    state.pendings = nextPendings
    saveState()
    const injectTemplate = typeof c.injectPrompt === 'string' && c.injectPrompt.trim().length > 0 ? c.injectPrompt : DEFAULT_INJECT_PROMPT
    let inject = injectTemplate.replace(/\{handoff\}/g, handoff.trim())
    if (inject.includes('{oldSessionId}')) {
      inject = inject.replace(/\{oldSessionId\}/g, oldId)
    } else {
      inject = `${inject}\n\n【上一页】旧会话 id：${oldId}（要读原文细节，用 session_recall 传这个 id；不传参默认也是它）`
    }
    try { agent.followup(userMessage(inject)) } catch (error) { log(`inject handoff failed: ${error?.message ?? error}`) }
    log(`rotated ${oldId} -> ${newId} title=${JSON.stringify(oldTitle)} handoff=${handoff.length} chars cwd=${cwd} effort=${inheritedEffort ?? 'default'}`)
    return true
  }

  function cleanupTick() {
    const c = cfg().cleanup ?? {}
    if (c.enabled === false) return
    const now = Date.now()
    const every = Number(c.checkMinutes ?? 60) * 60_000
    if (state.cleanup?.lastCheckAt !== undefined && now - state.cleanup.lastCheckAt < every) return
    const sizeMB = sessionsSizeMB(home)
    const limitMB = Number(c.totalSizeMB ?? 2000)
    const days = Number(c.keepDays ?? 30)
    const keepRecent = Number(c.keepRecent ?? 3)
    const history = Array.isArray(state.history) ? state.history : []
    const candidates = history.slice(0, Math.max(0, history.length - keepRecent))
    const rows = []
    for (const id of candidates) {
      const f = findSessionFile(home, id)
      if (f === null) continue
      try { rows.push({ id, ageDays: (now - statSync(f).mtimeMs) / 86_400_000, mb: statSync(f).size / 1_048_576 }) } catch { /* skip */ }
    }
    state.cleanup = { ...(state.cleanup ?? {}), lastCheckAt: now, sizeMB }
    if (sizeMB <= limitMB) {
      state.cleanup.warn = null
      saveState()
      return
    }
    const oldEnough = rows.filter((r) => r.ageDays >= days)
    if (oldEnough.length === 0) {
      const need = rows.length === 0
        ? '（还没有可清理的轮换会话）'
        : `（最早的一个才 ${Math.floor(Math.min(...rows.map((r) => r.ageDays)))} 天）`
      state.cleanup.warn = `会话目录 ${sizeMB}MB 已超 ${limitMB}MB，但时间未满 ${days} 天${need}，暂不删除`
      saveState()
      log(`cleanup warn: ${state.cleanup.warn}`)
      return
    }
    let current = sizeMB
    const deleted = []
    for (const r of oldEnough.sort((a, b) => b.ageDays - a.ageDays)) {
      if (current <= limitMB) break
      if (!deleteSessionFiles(home, r.id)) continue
      deleted.push(r.id)
      current = Math.round((current - r.mb) * 10) / 10
      state.history = (state.history ?? []).filter((x) => x !== r.id)
    }
    state.cleanup.warn = deleted.length === 0 ? (state.cleanup.warn ?? null) : null
    saveState()
    log(`cleanup: before=${sizeMB}MB after=${current}MB limit=${limitMB}MB deleted=${deleted.join(',') || 'none'}`)
  }

  function checkPending(sessionId, text) {
    const id = String(sessionId)
    const pending = (state.pendings ?? {})[id]
    if (pending === undefined) return
    const c = cfg()
    if (Date.now() - pending.at > c.pendingTimeoutMinutes * 60_000) {
      log(`pending timeout sid=${id}, dropped`)
      const next = { ...(state.pendings ?? {}) }
      delete next[id]
      state.pendings = next
      saveState()
      return
    }
    const body = extractHandoff(text)
    if (body.length < 20) return
    void finishRotation(id, body)
  }

  function listSessions() {
    const archived = new Set()
    try {
      const reg = ctx.get?.('workspaceRegistry')
      for (const id of reg?.archivedSessionIds ?? []) archived.add(String(id))
    } catch { /* ignore */ }
    const out = []
    const root = join(home, 'sessions')
    let wsDirs = []
    try { wsDirs = readdirSync(root) } catch { return out }
    const wsj = readJson(join(home, 'storages', 'workspace.json'), null)
    for (const ws of wsDirs) {
      const wsPath = join(root, ws)
      let ids = []
      try { if (!statSync(wsPath).isDirectory()) continue; ids = readdirSync(wsPath) } catch { continue }
      let cwd = ''
      for (const w of Object.values(wsj?.tables?.workspaces ?? {})) {
        if (Array.isArray(w.sessionIds) && w.sessionIds.includes(ids[0])) cwd = String(w.path ?? '')
      }
      for (const id of ids) {
        if (id.startsWith('.')) continue
        if (!/^session-|^heartbeat-/.test(id)) continue
        if (archived.has(id)) continue
        const meta = scanSessionMeta(home, id)
        if (meta.hasContent !== true) continue
        out.push({ id, title: meta.title, cwd })
      }
    }
    return out
  }
  async function ensureWorkspaces() {
    log('self-heal start')
    let reg
    try { reg = ctx.get?.('workspaceRegistry') } catch { return }
    if (reg === undefined || typeof reg.resolveByPath !== 'function') return
    const root = join(home, 'sessions')
    let dirs = []
    try { dirs = readdirSync(root) } catch { return }
    for (const wsDir of dirs) {
      let ids = []
      try { ids = readdirSync(join(root, wsDir)) } catch { continue }
      for (const id of ids) {
        if (!id.startsWith('session-cycle-')) continue
        const header = readSessionHeader(home, id)
        const cwd = String(header?.cwd ?? '')
        if (cwd === '') continue
        try {
          const ws = await reg.resolveByPath(cwd)
          if (ws === undefined || ws === null || typeof ws.attachSession !== 'function') continue
          if (Array.isArray(ws.sessionIds) && ws.sessionIds.includes(id)) continue
          await ws.attachSession(id)
          log(`self-heal attached: ${id} -> ${cwd}`)
        } catch (error) {
          log(`self-heal failed ${id}: ${error?.message ?? error}`)
        }
      }
    }
  }

  function watched(sessionId) {
    const c = cfg()
    const sid = String(sessionId)
    const picked = Array.isArray(c.watchSessionIds) ? c.watchSessionIds.map(String) : []
    return picked.includes(sid)
  }

  const lastUsage = new Map()
  const handoffDraft = new Map()

  ctx.on('session/event', (session, event) => {
    try {
      if (!cfg().enabled) return
      const type = event?.type
      if (type !== 'assistant/message' && type !== 'turn/end') return
      const sid = String(session?.id ?? '')
      if (sid === '') return
      if (!watched(sid)) return
      if (type === 'assistant/message') {
        const usage = Number(event?.data?.usage?.totalTokens ?? 0)
        if (Number.isFinite(usage) && usage > 0) lastUsage.set(sid, usage)
        if ((state.pendings ?? {})[sid] !== undefined) {
          const body = extractHandoff(messageText(event))
          if (body.length >= 20) handoffDraft.set(sid, body)
        }
        return
      }
      // turn/end：此时会话已空闲，再决定要不要触发 / 完成轮换
      if ((state.pendings ?? {})[sid] !== undefined) {
        const body = handoffDraft.get(sid)
        if (body !== undefined) {
          handoffDraft.delete(sid)
          void finishRotation(sid, body)
          return
        }
        checkPending(sid, '')
        return
      }
      const usage = Number(lastUsage.get(sid) ?? 0)
      if (!Number.isFinite(usage) || usage <= 0) return
      if (usage < threshold()) return
      const c = cfg()
      const last = Number((state.lastTriggerBy ?? {})[sid] ?? 0)
      if (Date.now() - last < c.cooldownMinutes * 60_000) return
      // turn/end 发出的瞬间 agent 可能还是 working，稍等再判一次
      setTimeout(() => { try { beginHandoff(sid, usage) } catch (error) { log(`delayed trigger failed: ${error?.message ?? error}`) } }, 2500)
    } catch (error) {
      log(`event failed: ${error?.message ?? error}`)
    }
  })
  ctx.on('agent/status', ({ agent, status }) => {
    try {
      if (String(status) !== 'idle') return
      const sid = String(agent?.session?.id ?? '')
      if (sid === '') return
      if (!watched(sid)) return
      if ((state.pendings ?? {})[sid] !== undefined) return
      const usage = Number(lastUsage.get(sid) ?? 0)
      if (!Number.isFinite(usage) || usage <= 0) return
      if (usage < threshold()) return
      const c = cfg()
      const last = Number((state.lastTriggerBy ?? {})[sid] ?? 0)
      if (Date.now() - last < c.cooldownMinutes * 60_000) return
      beginHandoff(sid, usage)
    } catch (error) {
      log(`agent/status failed: ${error?.message ?? error}`)
    }
  })

  ctx.effect(() => {
    const timer = setInterval(() => {
      try {
        if (!cfg().enabled) return
        for (const sid of Object.keys(state.pendings ?? {})) checkPending(sid, '')
        cleanupTick()
      } catch { /* ignore */ }
    }, 20_000)
    return () => clearInterval(timer)
  }, 'session-cycle: timer')

  ctx.tools.register({
    name: 'session_recall',
    description: '看旧会话的对话原文（换页后想看上一页聊过什么时用；归档的会话也能读）。不传 sessionId 就读最近一次轮换掉的会话。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        sessionId: { type: 'string', description: '会话 id；留空 = 最近一次换掉的旧会话。' },
        limit: { type: 'number', description: '读最近多少条，默认 20，最多 200。' },
      },
      required: [],
    },
    output: {
      schema: { type: 'string' },
      render: (_a, v) => [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v) }],
    },
    async execute(args) {
      const history = Array.isArray(state.history) ? state.history : []
      const sid = typeof args?.sessionId === 'string' && args.sessionId.length > 0
        ? args.sessionId
        : history[history.length - 1]
      if (typeof sid !== 'string' || sid.length === 0) return '还没有轮换记录，也没有指定 sessionId。'
      const lines = tailDialogue(home, sid, Number(args?.limit ?? 20))
      if (lines.length === 0) return `会话 ${sid} 里没读到对话（可能已被删除，或归档后路径变了）。`
      const title = readTitle(home, sid)
      return `会话 ${sid}${title === null ? '' : `（${title}）`} 最近 ${lines.length} 条：\n\n${lines.join('\n\n')}`
    },
  })

  ctx.tools.register({
    name: 'session_cycle',
    description: '查看/手动触发会话轮换。action=status 看阈值、当前会话、bindings、历史；action=rotate 立刻走一次"写交接并换会话"。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { action: { type: 'string', enum: ['status', 'rotate'] } },
      required: ['action'],
    },
    output: {
      schema: { type: 'string' },
      render: (_a, v) => [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v) }],
    },
    async execute(args) {
      const c = cfg()
      const action = String(args?.action ?? 'status')
      if (action === 'rotate') {
        const id0 = resolveCurrentId()
        const ok = id0 === null ? false : beginHandoff(id0, 0)
        return ok ? '已经让当前会话写交接；抓到带 <<<HANDOFF>>> 的回复后就会自动换会话。' : '没能触发（看 logs/session-cycle.log）。'
      }
      const id = resolveCurrentId()
      const lines = [
        `enabled: ${c.enabled}`,
        `阈值: ${threshold()} token（${c.contextWindow} × ${c.thresholdRatio}）`,
        `当前会话: ${id ?? '（未绑定）'}${id === null ? '' : `（标题：${readTitle(home, id) ?? '无'}）`}`,
        `待完成交接: ${(() => { const keys = Object.keys(state.pendings ?? {}); return keys.length === 0 ? '无' : keys.map((k) => k + '@' + new Date(state.pendings[k].at).toLocaleString('zh-CN')).join('；') })()}`,
        `归档旧会话: ${c.archiveOld ? '开' : '关'}`,
        `生效范围: ${(Array.isArray(c.watchSessionIds) && c.watchSessionIds.length > 0) ? c.watchSessionIds.length + ' 个会话' : '未选择（不生效）'}｜空闲轮换: ${c.onlyWhenIdle === false ? '否' : '是'}`,
        `会话清理: ${c.cleanup?.enabled === false ? '关' : `开｜满 ${c.cleanup?.keepDays ?? 30} 天 且 超过 ${c.cleanup?.totalSizeMB ?? 2000}MB 才删（现在 ${sessionsSizeMB(home)}MB）`}`,
        ...(state.cleanup?.warn ? [`  ⚠ ${state.cleanup.warn}`] : []),
        `bindings: ${c.bindings.join(' | ')}`,
        `历史轮换: ${(state.history ?? []).length} 次`,
        ...(state.history ?? []).slice(-5).map((h) => `  - ${h}`),
      ]
      return lines.join('\n')
    },
  })

  function listJsonFiles(query) {
    const out = []
    const skipDirs = new Set(['node_modules', 'sessions', 'attachments', 'see-now', 'cache', 'whale-audio', 'whale-bubble-imgs', 'whale-roles', 'llm-deepseek', '_backups', 'skills', 'dsh-runtimes', 'watch', 'dsh-channels', 'dsh-bridge', 'channel-qq', 'handoff-archive'])
    const walk = (dir, rel, depth) => {
      if (depth > 3 || out.length >= 400) return
      let items = []
      try { items = readdirSync(dir) } catch { return }
      for (const name of items) {
        if (out.length >= 400) return
        const full = join(dir, name)
        const relPath = rel === '' ? name : `${rel}/${name}`
        let st
        try { st = statSync(full) } catch { continue }
        if (st.isDirectory()) {
          if (depth === 0 && skipDirs.has(name)) continue
          walk(full, relPath, depth + 1)
          continue
        }
        if (!name.endsWith('.json')) continue
        if (st.size > 2 * 1024 * 1024) continue
        out.push(relPath)
      }
    }
    walk(home, '', 0)
    const q = String(query ?? '').trim().toLowerCase()
    return out.filter((p) => q === '' || p.toLowerCase().includes(q)).sort()
  }

  function sendJson(res, code, payload) {
    const body = JSON.stringify(payload)
    res.writeHead(code, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(body),
    })
    res.end(body)
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let raw = ''
      req.on('data', (chunk) => {
        raw += chunk
        if (raw.length > 1_000_000) { reject(new Error('body too large')); req.destroy() }
      })
      req.on('end', () => {
        if (raw.trim() === '') { resolve({}); return }
        try { resolve(JSON.parse(raw)) } catch (error) { reject(error) }
      })
      req.on('error', reject)
    })
  }

  function publicConfig() {
    const c = cfg()
    return {
      thresholdRatio: c.thresholdRatio,
      contextWindow: c.contextWindow,
      cleanup: { ...DEFAULTS.cleanup, ...(c.cleanup ?? {}) },
      bindings: c.bindings,
      handoffHeader: typeof c.handoffHeader === 'string' && c.handoffHeader.length > 0 ? c.handoffHeader : DEFAULT_HANDOFF_HEADER,
      defaultHandoffHeader: DEFAULT_HANDOFF_HEADER,
      archiveOld: c.archiveOld,
      watchSessionIds: Array.isArray(c.watchSessionIds) ? c.watchSessionIds : [],
      onlyWhenIdle: c.onlyWhenIdle !== false,
      state: {
        currentSessionId: resolveCurrentId(),
        pendings: Object.keys(state.pendings ?? {}),
        sessionsSizeMB: sessionsSizeMB(home),
        warn: state.cleanup?.warn ?? null,
        history: (state.history ?? []).slice(-10),
      },
    }
  }

  function saveConfig(patch) {
    const fileCfg = readJson(cfgFile, {})
    const next = { ...fileCfg }
    if (patch.thresholdRatio !== undefined) {
      const v = Number(patch.thresholdRatio)
      if (!Number.isFinite(v) || v < 0.2 || v > 0.95) return { ok: false, error: '阈值必须在 0.2–0.95 之间' }
      next.thresholdRatio = Math.round(v * 100) / 100
    }
    if (patch.cleanup !== undefined && typeof patch.cleanup === 'object') {
      const cur = { ...DEFAULTS.cleanup, ...(fileCfg.cleanup ?? {}) }
      const clean = { ...cur }
      if (patch.cleanup.keepDays !== undefined) {
        const v = Number(patch.cleanup.keepDays)
        if (!Number.isFinite(v) || v < 1) return { ok: false, error: '保留天数必须 ≥ 1' }
        clean.keepDays = Math.floor(v)
      }
      if (patch.cleanup.totalSizeMB !== undefined) {
        const v = Number(patch.cleanup.totalSizeMB)
        if (!Number.isFinite(v) || v < 10) return { ok: false, error: '空间阈值必须 ≥ 10MB' }
        clean.totalSizeMB = Math.floor(v)
      }
      if (patch.cleanup.keepRecent !== undefined) {
        const v = Number(patch.cleanup.keepRecent)
        if (!Number.isFinite(v) || v < 0) return { ok: false, error: '保留最近会话数必须 ≥ 0' }
        clean.keepRecent = Math.floor(v)
      }
      if (patch.cleanup.enabled !== undefined) clean.enabled = patch.cleanup.enabled === true
      next.cleanup = clean
    }
    if (patch.bindings !== undefined) {
      if (!Array.isArray(patch.bindings)) return { ok: false, error: 'bindings 必须是数组' }
      const list = patch.bindings
        .map((x) => String(x ?? '').trim().replace(/\\/g, '/'))
        .filter((x) => x.length > 0)
      for (const rel of list) {
        const p = isAbsolute(rel) ? rel : join(home, rel)
        if (!existsSync(p)) return { ok: false, error: `文件不存在：${rel}` }
      }
      next.bindings = [...new Set(list)]
    }
    if (patch.handoffHeader !== undefined) next.handoffHeader = String(patch.handoffHeader ?? '')
    if (patch.archiveOld !== undefined) next.archiveOld = patch.archiveOld === true
    if (patch.onlyWhenIdle !== undefined) next.onlyWhenIdle = patch.onlyWhenIdle === true
    if (patch.watchSessionIds !== undefined) {
      if (!Array.isArray(patch.watchSessionIds)) return { ok: false, error: 'watchSessionIds 必须是数组' }
      next.watchSessionIds = [...new Set(patch.watchSessionIds.map((x) => String(x)).filter((x) => x.length > 0))]
    }
    writeJson(cfgFile, next)
    log(`config saved: ${JSON.stringify({ ratio: next.thresholdRatio, cleanup: next.cleanup, bindings: next.bindings?.length })}`)
    return { ok: true }
  }

  function pickFiles() {
    return new Promise((resolve) => {
      const initial = home.replace(/'/g, "''")
      const script = [
        'Add-Type -AssemblyName System.Windows.Forms;',
        '$d = New-Object System.Windows.Forms.OpenFileDialog;',
        `$d.InitialDirectory = '${initial}';`,
        "$d.Filter = 'JSON (*.json)|*.json|所有文件 (*.*)|*.*';",
        '$d.Multiselect = $true;',
        '$d.Title = \'选择要跟随会话轮换的配置文件\';',
        'if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $d.FileNames | ForEach-Object { Write-Output $_ } }',
      ].join(' ')
      let child
      try {
        child = spawn('powershell.exe', ['-NoProfile', '-STA', '-Command', script], { windowsHide: true })
      } catch {
        resolve([])
        return
      }
      let out = ''
      child.stdout.on('data', (chunk) => { out += chunk.toString('utf8') })
      child.on('error', () => resolve([]))
      child.on('close', () => {
        const picked = out.split(/\r?\n/).map((s) => s.trim()).filter((s) => s.length > 0)
        resolve(picked.map((p) => {
          const norm = p.replace(/\\/g, '/')
          const homeNorm = home.replace(/\\/g, '/')
          if (norm.toLowerCase().startsWith(`${homeNorm.toLowerCase()}/`)) return norm.slice(homeNorm.length + 1)
          return norm
        }))
      })
    })
  }

  async function handleRoute(req, res) {
    try {
      const url = new URL(req.url ?? '/', 'http://x')
      const path = url.pathname.replace(ROUTE_PREFIX, '') || '/'
      if (req.method === 'GET' && path === '/config') {
        sendJson(res, 200, { ok: true, value: publicConfig() })
        return
      }
      if (req.method === 'POST' && path === '/pick-file') {
        const picked = await pickFiles()
        sendJson(res, 200, { ok: true, value: picked })
        return
      }
      if (req.method === 'GET' && path === '/sessions') {
        sendJson(res, 200, { ok: true, value: listSessions() })
        return
      }
      if (req.method === 'GET' && path === '/files') {
        sendJson(res, 200, { ok: true, value: listJsonFiles(url.searchParams.get('q') ?? '') })
        return
      }
      if (req.method === 'POST' && path === '/config') {
        const body = await readBody(req)
        const result = saveConfig(body ?? {})
        if (!result.ok) { sendJson(res, 400, result); return }
        sendJson(res, 200, { ok: true, value: publicConfig() })
        return
      }
      sendJson(res, 404, { ok: false, error: `unknown route ${path}` })
    } catch (error) {
      log(`route error: ${error?.message ?? error}`)
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
    }
  }

  try {
    ctx.inject?.(['webServer'], (scoped) => {
      scoped.effect(
        () => scoped.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler: (req, res) => void handleRoute(req, res) }),
        'session-cycle: settings routes',
      )
    })
  } catch (error) {
    log(`settings route mount failed: ${error?.message ?? error}`)
  }

  try {
    void ensureWorkspaces().catch((error) => log(`self-heal error: ${error?.message ?? error}`))
  } catch (error) {
    log(`self-heal run failed: ${error?.message ?? error}`)
  }

  try {
    const id = resolveCurrentId()
    log(`mounted; current=${id ?? 'unbound'} threshold=${threshold()} bindings=${cfg().bindings.length} archive=${cfg().archiveOld}`)
  } catch (error) {
    log(`mount failed: ${error?.message ?? error}`)
  }
}
