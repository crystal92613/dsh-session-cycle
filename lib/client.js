// dsh-session-cycle — browser half: 设置 → 会话轮换 page.
window.__ModuleLoader__.load({
  id: 'dsh-session-cycle',
  factory: (require) => {
    'use strict'
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var React = require('react')
    var h = React.createElement
    var API = '/session-cycle'

    function getJson(path) {
      return fetch(API + path, { headers: { 'content-type': 'application/json' } }).then(function (r) { return r.json() })
    }
    function postJson(path, body) {
      return fetch(API + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }).then(function (r) { return r.json() })
    }

    var S = {
      root: { display: 'flex', flexDirection: 'column', gap: '14px', padding: '4px 2px 28px', fontSize: '13px', maxWidth: '760px' },
      title: { margin: 0, fontSize: '16px', fontWeight: 600 },
      subTitle: { margin: 0, fontSize: '14px', fontWeight: 600 },
      desc: { margin: 0, fontSize: '12px', lineHeight: 1.65, opacity: 0.72 },
      card: { border: '1px solid rgba(128,128,128,.28)', borderRadius: '12px', padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: '10px' },
      row: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
      label: { minWidth: '110px', fontSize: '13px', opacity: 0.8 },
      input: { flex: 1, minWidth: '160px', padding: '6px 8px', borderRadius: '6px', border: '1px solid rgba(128,128,128,.35)', background: 'transparent', color: 'inherit', font: 'inherit' },
      inputNum: { width: '96px', flex: 'none', padding: '6px 8px', borderRadius: '6px', border: '1px solid rgba(128,128,128,.35)', background: 'transparent', color: 'inherit', font: 'inherit' },
      tab: { padding: '5px 12px', borderRadius: '999px', border: '1px solid rgba(128,128,128,.35)', cursor: 'pointer', fontSize: '12px', background: 'transparent', color: 'inherit', maxWidth: '260px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      tabActive: { padding: '5px 12px', borderRadius: '999px', border: '1px solid currentColor', cursor: 'pointer', fontSize: '12px', fontWeight: 600, background: 'transparent', color: 'inherit', maxWidth: '260px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      select: { padding: '6px 8px', borderRadius: '6px', border: '1px solid rgba(128,128,128,.35)', background: 'var(--dsw-alias-bg-base, #fff)', color: 'var(--dsw-alias-label-primary, #111)', font: 'inherit' },
      area: { width: '100%', height: '76px', padding: '8px', borderRadius: '6px', border: '1px solid rgba(128,128,128,.35)', background: 'transparent', color: 'inherit', font: 'inherit', lineHeight: 1.55, resize: 'none', overflow: 'auto' },
      pre: { width: '100%', maxHeight: '150px', overflow: 'auto', padding: '8px', borderRadius: '6px', border: '1px dashed rgba(128,128,128,.35)', fontSize: '12px', lineHeight: 1.55, margin: 0, whiteSpace: 'pre-wrap', opacity: 0.72, fontFamily: 'ui-monospace, monospace' },
      btn: { padding: '7px 14px', borderRadius: '8px', border: '0.5px solid rgba(128,128,128,.4)', background: 'transparent', color: 'inherit', font: 'inherit', cursor: 'pointer' },
      ok: { color: '#2a9d5c', fontSize: '12px' },
      err: { color: '#d33', fontSize: '12px' },
      hint: { fontSize: '12px', lineHeight: 1.7, opacity: 0.66, margin: 0 },
      mono: { fontFamily: 'ui-monospace, monospace', fontSize: '12px' },
      divider: { height: '1px', background: 'rgba(128,128,128,.22)', margin: '4px 0' },
    }

    function Row(props) {
      return h('div', { style: S.row }, h('span', { style: S.label }, props.label), props.children)
    }

    function Page() {
      var [cfg, setCfg] = React.useState(null)
      var [ratio, setRatio] = React.useState('')
      var [keepDays, setKeepDays] = React.useState('')
      var [sizeMB, setSizeMB] = React.useState('')
      var [keepArchived, setKeepArchived] = React.useState('')
      var [bindings, setBindings] = React.useState([])
      var [header, setHeader] = React.useState('')
      var [onlyIdle, setOnlyIdle] = React.useState(true)
      var [msg, setMsg] = React.useState(null)
      var [saving, setSaving] = React.useState(false)
      var [picking, setPicking] = React.useState(false)
      var [watched, setWatched] = React.useState([])
      var [sessions, setSessions] = React.useState(null)

      function apply(value) {
        setCfg(value)
        setRatio(String(Math.round((value.thresholdRatio || 0) * 100)))
        setKeepDays(String(value.cleanup?.keepDays ?? 30))
        setSizeMB(String(value.cleanup?.totalSizeMB ?? 2000))
        setKeepArchived(String(value.cleanup?.keepRecent ?? 3))
        setBindings(Array.isArray(value.bindings) ? value.bindings.slice() : [])
        setHeader(value.handoffHeader || '')
        setOnlyIdle(value.onlyWhenIdle !== false)
        setWatched(Array.isArray(value.watchSessionIds) ? value.watchSessionIds.slice() : [])
      }

      function load() {
        getJson('/config').then(function (r) {
          if (r && r.ok) apply(r.value)
          else setMsg({ type: 'err', text: '读取配置失败' })
        }).catch(function (e) { setMsg({ type: 'err', text: String(e && e.message ? e.message : e) }) })
        loadSessions()
      }

      React.useEffect(function () { load() }, [])

      function save() {
        setSaving(true)
        setMsg(null)
        postJson('/config', {
          thresholdRatio: Number(ratio) / 100,
          cleanup: { keepDays: Number(keepDays), totalSizeMB: Number(sizeMB), keepRecent: Number(keepArchived) },
          bindings: bindings,
          handoffHeader: header,
          onlyWhenIdle: onlyIdle,
          watchSessionIds: watched,
        }).then(function (r) {
          if (r && r.ok) { apply(r.value); setMsg({ type: 'ok', text: '已保存' }) }
          else setMsg({ type: 'err', text: (r && r.error) || '保存失败' })
        }).catch(function (e) { setMsg({ type: 'err', text: String(e && e.message ? e.message : e) }) })
          .then(function () { setSaving(false) })
      }

      function loadSessions() {
        setSessions(null)
        getJson('/sessions').then(function (r) {
          setSessions(r && r.ok && Array.isArray(r.value) ? r.value : [])
        }).catch(function () { setSessions([]) })
      }

      function toggleSession(id) {
        setWatched(watched.indexOf(id) >= 0 ? watched.filter(function (x) { return x !== id }) : watched.concat([id]))
      }

      function addFiles() {
        setPicking(true)
        setMsg(null)
        postJson('/pick-file', {}).then(function (r) {
          if (r && r.ok && Array.isArray(r.value) && r.value.length > 0) {
            var next = bindings.slice()
            r.value.forEach(function (p) { if (next.indexOf(p) < 0) next.push(p) })
            setBindings(next)
            setMsg({ type: 'ok', text: '已加入 ' + r.value.length + ' 个文件，记得保存' })
          } else if (r && r.ok) {
            setMsg({ type: 'ok', text: '没有选择文件' })
          } else {
            setMsg({ type: 'err', text: (r && r.error) || '打开文件选择框失败' })
          }
        }).catch(function (e) { setMsg({ type: 'err', text: String(e && e.message ? e.message : e) }) })
          .then(function () { setPicking(false) })
      }

      function removeBinding(rel) {
        setBindings(bindings.filter(function (x) { return x !== rel }))
      }

      if (cfg === null) return h('div', { style: S.root }, h('p', { style: S.desc }, msg ? msg.text : '加载配置中…'))

      var thresholdK = null
      void thresholdK

      return h('div', { style: S.root },
        h('h2', { style: S.title }, '会话管理'),
        h('p', { style: S.desc }, '管理上下文压缩提醒与会话更换：到达阈值时先提醒整理，再写交接换新会话，并把清单里的会话 id 一起指过去。'),

        h('div', { style: S.card },
          h('h3', { style: S.subTitle }, '生效会话'),
          h(Row, { label: '监控范围' },
            h('button', { style: S.btn, onClick: loadSessions }, '刷新列表'),
            h('span', { style: S.hint }, watched.length === 0 ? '未选择 = 不生效（改完点保存）' : '已选 ' + watched.length + ' 个会话（改完点保存）')),
          h('div', { style: S.row },
            sessions === null
              ? h('span', { style: S.hint }, '会话列表加载中…')
              : sessions.length === 0
              ? h('span', { style: S.hint }, '没有未归档会话')
              : sessions.map(function (sess) {
                var on = watched.indexOf(sess.id) >= 0
                return h('button', {
                  key: sess.id,
                  style: on ? S.tabActive : S.tab,
                  title: sess.id,
                  onClick: function () { toggleSession(sess.id) },
                }, (sess.title || sess.id) + (on ? ' ✓' : ''))
              }))),

        h('div', { style: S.card },
          h('h3', { style: S.subTitle }, '会话更换'),
          h(Row, { label: '更换阈值 (%)' },
            h('input', { style: S.inputNum, type: 'number', min: 20, max: 95, value: ratio, onChange: function (e) { setRatio(e.target.value) } }),
            h('span', { style: S.hint }, '建议 30–60；达到该比例时触发轮换')),
          h(Row, { label: '空闲轮换' },
            h('select', { style: S.select, value: onlyIdle ? 'yes' : 'no', onChange: function (e) { setOnlyIdle(e.target.value === 'yes') } },
              h('option', { value: 'yes' }, '是（推荐）'),
              h('option', { value: 'no' }, '否'))),
          h('h3', { style: S.subTitle }, '交接提示词'),
          h('p', { style: S.hint }, '这段会发给会话，让它写交接；末尾的格式要求由插件自动追加，不用写。'),
          h('textarea', { style: S.area, value: header, onChange: function (e) { setHeader(e.target.value) } })),

        h('div', { style: S.card },
          h('h3', { style: S.subTitle }, '归档会话删除条件'),
          h('p', { style: S.hint }, '时间与空间两条都满足才会删除；只超空间、时间没到只提示不删。会话目录当前 ' + (cfg.state ? cfg.state.sessionsSizeMB : '?') + ' MB。'),
          h(Row, { label: '保留天数' }, h('input', { style: S.inputNum, type: 'number', min: 1, value: keepDays, onChange: function (e) { setKeepDays(e.target.value) } })),
          h(Row, { label: '空间上限 (MB)' }, h('input', { style: S.inputNum, type: 'number', min: 10, value: sizeMB, onChange: function (e) { setSizeMB(e.target.value) } })),
          h(Row, { label: '已归档会话保留数' }, h('input', { style: S.inputNum, type: 'number', min: 0, value: keepArchived, onChange: function (e) { setKeepArchived(e.target.value) } })),
          cfg.state && cfg.state.warn ? h('p', { style: S.err }, '⚠ ' + cfg.state.warn) : null),

        h('div', { style: S.card },
          h('div', { style: S.row },
            h('h3', { style: Object.assign({}, S.subTitle, { flex: 1, margin: 0 }) }, '配置文件（会话 id 挂接）'),
            h('button', { style: S.btn, onClick: addFiles, disabled: picking }, picking ? '等待选择…' : '＋ 新增文件')),
          h('p', { style: S.hint }, '换会话后，这些 JSON 里等于旧会话 id 的字符串会被替换成新会话 id；点「新增文件」会打开文件选择框。'),
          bindings.length === 0
            ? h('p', { style: S.hint }, '还没有配置文件。')
            : bindings.map(function (rel) {
              return h('div', { key: rel, style: S.row },
                h('span', { style: Object.assign({}, S.mono, { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }) }, rel),
                h('button', { style: S.btn, onClick: function () { removeBinding(rel) } }, '移除'))
            })),

        h('div', { style: S.row },
          h('button', { style: S.btn, onClick: save, disabled: saving }, saving ? '保存中…' : '保存'),
          h('button', { style: S.btn, onClick: load }, '重新读取'),
          msg ? h('span', { style: msg.type === 'ok' ? S.ok : S.err }, msg.text) : null)
      )
    }

    exports.inject = ['slots']
    exports.apply = function apply(ctx) {
      ctx.slots.inject('settings.section', function () {
        return ctx.slots.register({
          name: 'settings.section',
          id: 'session-cycle',
          order: 216,
          label: '会话管理',
        }, Page)
      })
    }

    return module.exports
  },
})
