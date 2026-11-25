// Cloud Notebook 官网的少量交互：语言切换、三个演示、GitHub 星标数和最新版本号。
(function () {
  var REPO = 'xingguiyu/cloud-notebook'
  var root = document.documentElement
  var store = {
    get: function (k) { try { return localStorage.getItem(k) } catch (e) { return null } },
    set: function (k, v) { try { localStorage.setItem(k, v) } catch (e) {} },
  }
  var zh = function () { return root.dataset.lang === 'zh' }
  var pick = function (en, cn) { return zh() ? cn : en }

  // ---- 语言 ----
  var langBtn = document.getElementById('lang')
  function setLang(l) {
    root.dataset.lang = l
    root.lang = l === 'zh' ? 'zh-CN' : 'en'
    if (langBtn) langBtn.textContent = l === 'zh' ? 'English' : '中文'
    renderAll()
  }
  if (langBtn) langBtn.onclick = function () { var l = zh() ? 'en' : 'zh'; store.set('lang', l); setLang(l) }

  // ---- 演示切换 ----
  var tabs = document.querySelectorAll('[data-tab]')
  tabs.forEach(function (tab) {
    tab.onclick = function () {
      tabs.forEach(function (x) { x.setAttribute('aria-selected', String(x === tab)) })
      document.querySelectorAll('[data-stage]').forEach(function (s) { s.hidden = s.dataset.stage !== tab.dataset.tab })
    }
  })

  // ---- 演示一：AI 保存文档，旧文档被标成「已被取代」 ----
  var term = document.getElementById('term')
  var doclist = document.getElementById('doclist')
  var runDocs = document.getElementById('runDocs')
  var saved = false
  function docs() {
    var rows = [
      { st: 'dra', label: pick('Draft', '草稿'), title: pick('Release plan', '上线计划'), note: pick('1 version', '1 个版本') },
      { st: saved ? '' : 'cur', label: saved ? pick('Superseded', '已被取代') : pick('Current', '当前有效'), title: pick('Payment design', '支付方案'), note: saved ? pick('by v2', '被 v2 取代') : pick('2 versions', '2 个版本'), old: saved },
      { st: '', label: pick('Archived', '已归档'), title: pick('Database migration notes', '数据库迁移记录'), note: '', old: true },
    ]
    if (saved) rows.unshift({ st: 'cur', label: pick('Current', '当前有效'), title: pick('Payment design v2', '支付方案 v2'), note: pick('just now', '刚刚'), fresh: true })
    return rows
  }
  function renderDocs() {
    if (!doclist) return
    doclist.textContent = ''
    docs().forEach(function (r) {
      var row = document.createElement('div')
      row.className = 'docrow' + (r.old ? ' old' : '') + (r.fresh ? ' fresh' : '')
      var st = document.createElement('span'); st.className = 'st ' + r.st; st.textContent = r.label
      var b = document.createElement('b'); b.textContent = r.title
      var s = document.createElement('small'); s.textContent = r.note
      row.append(st, b, s)
      doclist.append(row)
    })
    if (term) {
      term.textContent = ''
      var line = function (cls, text) { var x = document.createElement('span'); x.className = cls; x.textContent = text + '\n'; term.append(x) }
      if (!saved) line('d', pick('Ask the agent to save its new plan. Press the button.', '让 AI 把新方案存起来。点下面的按钮。'))
      else {
        line('p', pick('> Save this as the new payment design.', '> 把这个存成新的支付方案。'))
        line('', 'list_docs()')
        line('d', pick('  found "Payment design" (current)', '  找到「支付方案」（当前有效）'))
        line('', 'save_doc(title: "' + pick('Payment design v2', '支付方案 v2') + '",')
        line('', '         supersedes: ["' + pick('Payment design', '支付方案') + '"])')
        line('d', pick('  saved; the old one is now superseded', '  已保存；旧的那份已标为已被取代'))
      }
    }
    if (runDocs) runDocs.querySelectorAll('span').forEach(function (x, i) { x.textContent = saved ? [ 'Start over', '重新开始' ][i] : [ 'Save the new plan', '保存新方案' ][i] })
  }
  if (runDocs) runDocs.onclick = function () { saved = !saved; renderDocs() }

  // ---- 演示二：密钥复制成 .env ----
  var envOut = document.getElementById('envOut')
  var copied = false
  function renderEnv() {
    if (!envOut) return
    envOut.classList.toggle('empty', !copied)
    envOut.textContent = copied
      ? 'STRIPE_API_KEY=sk_live_••••4f2a\nANTHROPIC_API_KEY=sk-ant-••••9c1d\nANTHROPIC_BASE_URL=https://api.anthropic.com\nOPENAI_API_KEY=sk-proj-••••7b0e\nOPENAI_BASE_URL=https://api.openai.com/v1'
      : pick('Nothing copied yet.', '还没有复制。')
  }
  var runEnv = document.getElementById('runEnv')
  if (runEnv) runEnv.onclick = function () { copied = true; renderEnv() }

  // ---- 演示三：版本历史对比 ----
  var vers = document.getElementById('vers')
  var diff = document.getElementById('diff')
  var chosen = 0
  function history() {
    var now = pick(['# Release plan', '', '- Thursday: staged rollout', '- Friday: everyone', '- Rollback script tested'], ['# 上线计划', '', '- 周四：灰度发布', '- 周五：全量', '- 回滚脚本已验证'])
    return [
      { when: pick('Today 14:20', '今天 14:20'), size: '0.3 KB', text: pick(['# Release plan', '', '- Thursday: staged rollout', '- Friday: everyone'], ['# 上线计划', '', '- 周四：灰度发布', '- 周五：全量']) },
      { when: pick('Yesterday 18:05', '昨天 18:05'), size: '0.2 KB', text: pick(['# Release plan', '', '- Friday: staged rollout'], ['# 上线计划', '', '- 周五：灰度发布']) },
    ].map(function (v) { v.now = now; return v })
  }
  function renderHistory() {
    if (!vers || !diff) return
    var list = history()
    vers.textContent = ''
    list.forEach(function (v, i) {
      var b = document.createElement('button')
      b.type = 'button'
      b.setAttribute('aria-pressed', String(i === chosen))
      b.textContent = v.when
      var s = document.createElement('small'); s.textContent = v.size
      b.append(s)
      b.onclick = function () { chosen = i; renderHistory() }
      vers.append(b)
    })
    var v = list[chosen]
    diff.textContent = ''
    var add = function (cls, mark, text) { var x = document.createElement('span'); if (cls) x.className = cls; x.textContent = mark + ' ' + text + '\n'; diff.append(x) }
    v.text.forEach(function (l) { if (v.now.indexOf(l) < 0) add('del', '-', l) })
    v.now.forEach(function (l) { add(v.text.indexOf(l) < 0 ? 'add' : '', v.text.indexOf(l) < 0 ? '+' : ' ', l) })
  }

  function renderAll() { renderDocs(); renderEnv(); renderHistory() }
  setLang(store.get('lang') || (/^zh/i.test(navigator.language) ? 'zh' : 'en'))

  // ---- GitHub：星标数、最新版本和安装包的直接下载地址（取不到就保持默认链接） ----
  var api = 'https://api.github.com/repos/' + REPO
  fetch(api).then(function (r) { return r.ok ? r.json() : null }).then(function (d) {
    var el = document.getElementById('stars')
    if (el && d && typeof d.stargazers_count === 'number' && d.stargazers_count > 0) el.textContent = d.stargazers_count.toLocaleString()
  }).catch(function () {})
  fetch(api + '/releases/latest').then(function (r) { return r.ok ? r.json() : null }).then(function (rel) {
    if (!rel || !rel.tag_name) return
    var dmg = (rel.assets || []).filter(function (a) { return /\.dmg$/i.test(a.name) })[0]
    document.querySelectorAll('[data-download]').forEach(function (a) {
      if (dmg) a.href = dmg.browser_download_url
      var v = a.querySelector('.ver')
      if (v) v.textContent = rel.tag_name.replace(/^v/, '')
    })
  }).catch(function () {})
})()
