(() => {
  'use strict';

  // i18n helpers (js/i18n.js is loaded before this file).
  const t = (key, params) => I18n.t(key, params);

  // ---------------- API helper ----------------
  async function api(path, opts = {}) {
    const res = await fetch(path, {
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      ...opts,
    });
    if (res.status === 401) {
      showLogin();
      throw new Error('unauthorized');
    }
    if (!res.ok) {
      let msg = res.statusText;
      try { msg = (await res.json()).error || msg; } catch (_) {}
      throw new Error(I18n.err(msg)); // backend errors are English; translate known ones
    }
    if (res.status === 204) return null;
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  // ---------------- build version marker ----------------
  // Shown on the login screen and in the sidebar footer, and logged to the
  // console, so you can tell at a glance whether the page you're looking
  // at (and the server behind it) is actually the build you just deployed
  // — handy when a fix "isn't showing up" and you're not sure if it's a
  // stale browser cache, a stale deploy, or a real bug.
  let buildVersion = 'unknown';
  function renderBuildVersion() {
    const text = t('build.version', { version: buildVersion });
    const loginTag = document.getElementById('buildVersionTag');
    const appTag = document.getElementById('buildVersionTagApp');
    if (loginTag) loginTag.textContent = text;
    if (appTag) appTag.textContent = text;
  }
  (async function showBuildVersion() {
    let version = 'unknown';
    try {
      const r = await fetch('/api/version', { credentials: 'include' });
      if (r.ok) version = (await r.json()).version || 'unknown';
    } catch (_) { /* offline / server not reachable yet — leave as unknown */ }
    console.log('[webssh] build version:', version);
    buildVersion = version;
    renderBuildVersion();
  })();

  // ---------------- state ----------------
  const state = {
    groups: [],
    sessions: [],
    tunnels: [],
    openTabs: [],   // { id, sessionId, name, term, fitAddon, ws }
    activeTab: null,
    layout: 'single', // 'single' | 'horizontal' | 'vertical' | 'grid'
    paneTabs: [null], // tab ids assigned to each pane (length depends on layout)
    sidebarCollapsed: false,
    searchQuery: '',
  };

  function naturalSort(a, b) {
    return String(a).localeCompare(String(b), undefined, { sensitivity: 'base', numeric: true });
  }

  // ---------------- workspace persistence (localStorage) ----------------
  // The WebSocket itself can't survive a page reload, but the backend now
  // keeps the actual remote shell running in the background (see
  // termmgr.go) keyed by termId. So as long as we remember each tab's
  // termId here and reconnect with the same one, the new WebSocket just
  // reattaches to the still-running shell — same cwd, same scrollback,
  // same in-flight command — instead of starting a brand new login.
  const WORKSPACE_KEY = 'webssh-workspace';

  function genTermId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return `term-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }

  function saveWorkspace() {
    try {
      const tabs = state.openTabs.map((t) => ({ sessionId: t.sessionId, kind: t.kind, termId: t.termId || null, customName: t.customName || null }));
      const activeTabObj = state.openTabs.find((t) => t.id === state.activeTab);
      localStorage.setItem(WORKSPACE_KEY, JSON.stringify({
        layout: state.layout,
        tabs,
        activeSessionId: activeTabObj ? activeTabObj.sessionId : null,
        activeKind: activeTabObj ? activeTabObj.kind : null,
      }));
    } catch (_) { /* localStorage unavailable/full — persistence is best-effort */ }
  }

  function clearWorkspace() {
    try { localStorage.removeItem(WORKSPACE_KEY); } catch (_) {}
  }

  // Recreate previously-open tabs (each reconnects for real) and restore
  // the layout + active tab. Sessions that were since deleted are skipped.
  function restoreWorkspace() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(WORKSPACE_KEY) || 'null'); } catch (_) {}
    if (!saved || !Array.isArray(saved.tabs) || saved.tabs.length === 0) return;

    let activeId = null;
    for (const t of saved.tabs) {
      const sess = state.sessions.find((s) => s.id === t.sessionId);
      if (!sess) continue;
      if (t.kind === 'sftp') openSftpTab(sess);
      else openTerminalTab(sess, t.termId || undefined);
      const created = state.openTabs[state.openTabs.length - 1];
      if (created && typeof t.customName === 'string' && t.customName) created.customName = t.customName.slice(0, 60);
      if (created && t.sessionId === saved.activeSessionId && t.kind === saved.activeKind) {
        activeId = created.id;
      }
    }

    if (saved.layout && saved.layout !== 'single') {
      setLayout(saved.layout);
    } else if (activeId) {
      showTab(activeId);
    }
    renderTabBar();
    saveWorkspace();
  }

  function matchesQuery(haystackParts, query) {
    if (!query) return true;
    const q = query.toLowerCase();
    return haystackParts.some((p) => String(p || '').toLowerCase().includes(q));
  }

  // ---------------- auth ----------------
  const loginScreen = document.getElementById('loginScreen');
  const appEl = document.getElementById('app');

  function showLogin() {
    loginScreen.classList.remove('hidden');
    appEl.classList.add('hidden');
  }
  function showApp() {
    loginScreen.classList.add('hidden');
    appEl.classList.remove('hidden');
  }

  document.getElementById('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('loginUser').value;
    const password = document.getElementById('loginPass').value;
    const errEl = document.getElementById('loginError');
    errEl.textContent = '';
    try {
      await api('/api/login', { method: 'POST', body: JSON.stringify({ username, password }) });
      showApp();
      await refreshAll();
      restoreWorkspace();
    } catch (err) {
      errEl.textContent = t('login.error');
    }
  });

  // ---------------- sidebar collapse ----------------
  const sidebarEl = document.querySelector('.sidebar');
  const sidebarToggleBtn = document.getElementById('sidebarToggle');
  const SIDEBAR_COLLAPSED_KEY = 'webssh-sidebar-collapsed';

  function applySidebarCollapsed(collapsed) {
    state.sidebarCollapsed = collapsed;
    appEl.classList.toggle('sidebar-collapsed', collapsed);
    sidebarEl.classList.toggle('collapsed', collapsed);
    sidebarToggleBtn.textContent = collapsed ? '›' : '‹';
    sidebarToggleBtn.title = t(collapsed ? 'sidebar.expand' : 'sidebar.collapse');
  }

  (function initSidebarCollapsed() {
    let saved = null;
    try { saved = localStorage.getItem(SIDEBAR_COLLAPSED_KEY); } catch (_) {}
    if (saved === '1') applySidebarCollapsed(true);
  })();

  sidebarToggleBtn.addEventListener('click', () => {
    applySidebarCollapsed(!state.sidebarCollapsed);
    try { localStorage.setItem(SIDEBAR_COLLAPSED_KEY, state.sidebarCollapsed ? '1' : '0'); } catch (_) {}
  });

  document.getElementById('btnLogout').addEventListener('click', async () => {
    await api('/api/logout', { method: 'POST' });
    location.reload();
  });

  // ---------------- change admin password ----------------
  const passwordDialog = document.getElementById('passwordDialog');
  const pwForm = document.getElementById('passwordForm');
  const pwError = document.getElementById('pwError');

  document.getElementById('btnChangePassword').addEventListener('click', () => {
    pwForm.reset();
    pwError.textContent = '';
    passwordDialog.showModal();
  });
  document.getElementById('pwCancel').addEventListener('click', () => passwordDialog.close());

  pwForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    pwError.textContent = '';
    const currentPassword = document.getElementById('pwCurrent').value;
    const newUsername = document.getElementById('pwNewUsername').value.trim();
    const newPassword = document.getElementById('pwNewPassword').value;
    const confirmPassword = document.getElementById('pwConfirmPassword').value;

    if (newPassword.length < 6) {
      pwError.textContent = t('pw.tooShort');
      return;
    }
    if (newPassword !== confirmPassword) {
      pwError.textContent = t('pw.mismatch');
      return;
    }

    try {
      await api('/api/admin/password', {
        method: 'POST',
        body: JSON.stringify({ currentPassword, newUsername, newPassword }),
      });
    } catch (err) {
      pwError.textContent = err.message || t('pw.failed');
      return;
    }

    // The server invalidated every session (including this one) so the
    // new credentials take effect immediately. Send everyone back to the
    // login screen.
    passwordDialog.close();
    alert(t('pw.changed'));
    location.reload();
  });

  // ---------------- sidebar resize ----------------
  const sidebarResizer = document.getElementById('sidebarResizer');
  const MIN_SIDEBAR_WIDTH = 180;
  const MAX_SIDEBAR_WIDTH = 560;

  function setSidebarWidth(px) {
    const clamped = Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, px));
    document.documentElement.style.setProperty('--sidebar-width', `${clamped}px`);
    try { localStorage.setItem('webssh-sidebar-width', String(clamped)); } catch (_) {}
    return clamped;
  }

  (function initSidebarWidth() {
    let saved = null;
    try { saved = parseInt(localStorage.getItem('webssh-sidebar-width'), 10); } catch (_) {}
    if (saved) setSidebarWidth(saved);
  })();

  sidebarResizer.addEventListener('mousedown', (e) => {
    if (state.sidebarCollapsed) return;
    e.preventDefault();
    sidebarEl.classList.add('resizing');
    sidebarResizer.classList.add('dragging');
    const onMove = (ev) => {
      const rect = sidebarEl.getBoundingClientRect();
      setSidebarWidth(ev.clientX - rect.left);
    };
    const onUp = () => {
      sidebarEl.classList.remove('resizing');
      sidebarResizer.classList.remove('dragging');
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      refitVisibleTabs();
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  });

  // ---------------- theme ----------------
  const btnThemeToggle = document.getElementById('btnThemeToggle');

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    btnThemeToggle.textContent = theme === 'light' ? '☀' : '🌙';
    btnThemeToggle.title = t(theme === 'light' ? 'theme.toDark' : 'theme.toLight');
    try { localStorage.setItem('webssh-theme', theme); } catch (_) {}
  }

  (function initTheme() {
    let saved = null;
    try { saved = localStorage.getItem('webssh-theme'); } catch (_) {}
    applyTheme(saved === 'light' ? 'light' : 'dark');
  })();

  btnThemeToggle.addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
    applyTheme(current === 'light' ? 'dark' : 'light');
  });

  // ---------------- search ----------------
  const sidebarSearchInput = document.getElementById('sidebarSearch');
  const sidebarSearchWrap = document.getElementById('sidebarSearchWrap');
  const btnSearchClear = document.getElementById('btnSearchClear');

  sidebarSearchInput.addEventListener('input', () => {
    state.searchQuery = sidebarSearchInput.value.trim();
    sidebarSearchWrap.parentElement.classList.toggle('has-query', !!state.searchQuery);
    renderTree();
    renderTunnels();
  });
  btnSearchClear.addEventListener('click', () => {
    sidebarSearchInput.value = '';
    state.searchQuery = '';
    sidebarSearchWrap.parentElement.classList.remove('has-query');
    renderTree();
    renderTunnels();
    sidebarSearchInput.focus();
  });

  async function checkAuth() {
    try {
      const r = await api('/api/me');
      if (r.authenticated) { showApp(); await refreshAll(); restoreWorkspace(); }
      else showLogin();
    } catch (_) { showLogin(); }
  }

  // ---------------- data refresh ----------------
  async function refreshAll() {
    [state.groups, state.sessions, state.tunnels] = await Promise.all([
      api('/api/groups'), api('/api/sessions'), api('/api/tunnels'),
    ]);
    renderTree();
    renderTunnels();
    populateGroupSelect();
    populateTunnelSessionSelect();
  }

  // ---------------- session tree ----------------
  const treeEl = document.getElementById('sessionTree');

  // Remember which groups the user has manually expanded, so re-renders
  // (triggered by almost any action) and page reloads don't collapse
  // everything back down. Groups default to collapsed, matching prior
  // behavior, unless their id is present in this persisted set.
  const GROUP_EXPANDED_KEY = 'webssh-expanded-groups';
  function loadExpandedGroups() {
    try {
      const raw = JSON.parse(localStorage.getItem(GROUP_EXPANDED_KEY) || '[]');
      if (Array.isArray(raw)) return new Set(raw);
    } catch (_) {}
    return new Set();
  }
  function saveExpandedGroups(set) {
    try { localStorage.setItem(GROUP_EXPANDED_KEY, JSON.stringify(Array.from(set))); } catch (_) {}
  }
  const expandedGroups = loadExpandedGroups();

  function renderTree() {
    treeEl.innerHTML = '';
    const query = state.searchQuery;
    const filteredSessions = state.sessions.filter((s) =>
      matchesQuery([s.name, s.host, s.username], query)
    );

    const byGroup = {};
    for (const s of filteredSessions) {
      const key = s.groupId || '';
      (byGroup[key] = byGroup[key] || []).push(s);
    }
    for (const key of Object.keys(byGroup)) byGroup[key].sort((a, b) => naturalSort(a.name, b.name));

    const sortedGroups = state.groups.slice().sort((a, b) => naturalSort(a.name, b.name));

    // ungrouped sessions first, in stable alphabetical order
    for (const s of (byGroup[''] || [])) treeEl.appendChild(sessionRow(s));

    let anyGroupVisible = false;
    for (const g of sortedGroups) {
      const groupSessions = byGroup[g.id] || [];
      const groupMatchesOwnName = matchesQuery([g.name], query);
      // hide empty groups only while actively searching and the group name itself doesn't match
      if (query && groupSessions.length === 0 && !groupMatchesOwnName) continue;
      anyGroupVisible = true;

      const wrap = document.createElement('div');
      wrap.className = 'group-node';

      const title = document.createElement('div');
      title.className = 'group-title';
      title.innerHTML = `<span class="group-name" title="${escapeHtml(g.name)}">📁 ${escapeHtml(g.name)}</span>`;
      const actions = document.createElement('span');
      actions.className = 'group-actions';
      actions.innerHTML = `<button data-act="rename" title="${escapeHtml(t('common.rename'))}">✎</button><button data-act="del" title="${escapeHtml(t('common.delete'))}">🗑</button>`;
      title.appendChild(actions);
      wrap.appendChild(title);

      actions.querySelector('[data-act="rename"]').onclick = (e) => { e.stopPropagation(); openGroupDialog(g); };
      actions.querySelector('[data-act="del"]').onclick = async (e) => {
        e.stopPropagation();
        if (confirm(t('group.confirmDelete', { name: g.name }))) {
          await api(`/api/groups/${g.id}`, { method: 'DELETE' });
          expandedGroups.delete(g.id);
          saveExpandedGroups(expandedGroups);
          await refreshAll();
        }
      };

      const body = document.createElement('div');
      const isExpanded = !!state.searchQuery || expandedGroups.has(g.id);
      body.classList.toggle('hidden', !isExpanded);
      for (const s of groupSessions) body.appendChild(sessionRow(s));
      wrap.appendChild(body);

      title.onclick = () => {
        const nowExpanded = body.classList.toggle('hidden') === false;
        if (nowExpanded) expandedGroups.add(g.id); else expandedGroups.delete(g.id);
        saveExpandedGroups(expandedGroups);
      };

      treeEl.appendChild(wrap);
    }

    if (query && filteredSessions.length === 0 && !anyGroupVisible) {
      const empty = document.createElement('div');
      empty.className = 'search-empty';
      empty.textContent = t('search.noSessions');
      treeEl.appendChild(empty);
    }
  }

  function sessionRow(s) {
    const row = document.createElement('div');
    row.className = 'session-item';
    row.dataset.id = s.id;
    const subText = `${s.username}@${s.host}`;
    row.innerHTML = `<span class="item-main">
      <span class="item-title" title="${escapeHtml(s.name)}">🖥 ${escapeHtml(s.name)}</span>
      <span class="session-sub" title="${escapeHtml(subText)}">${escapeHtml(subText)}</span>
    </span>`;
    const actions = document.createElement('span');
    actions.className = 'item-actions';
    actions.innerHTML = `<button data-act="edit" title="${escapeHtml(t('common.edit'))}">✎</button><button data-act="files" title="${escapeHtml(t('item.files'))}">📁</button><button data-act="copy" title="${escapeHtml(t('session.copy'))}">⧉</button><button data-act="del" title="${escapeHtml(t('common.delete'))}">🗑</button>`;
    row.appendChild(actions);

    row.addEventListener('click', (e) => {
      if (e.target.closest('.item-actions')) return;
      openTerminalTab(s);
    });
    actions.querySelector('[data-act="edit"]').onclick = async (e) => {
      e.stopPropagation();
      const full = await api(`/api/sessions/${s.id}`);
      openSessionDialog(full);
    };
    actions.querySelector('[data-act="files"]').onclick = (e) => {
      e.stopPropagation();
      openSftpTab(s);
    };
    actions.querySelector('[data-act="del"]').onclick = async (e) => {
      e.stopPropagation();
      if (confirm(t('session.confirmDelete', { name: s.name }))) {
        await api(`/api/sessions/${s.id}`, { method: 'DELETE' });
        closeTabForSession(s.id);
        await refreshAll();
      }
    };
    actions.querySelector('[data-act="copy"]').onclick = (e) => {
      e.stopPropagation();
      openSessionDialog(s, { copy: true });
    };
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const act = (name) => () => actions.querySelector(`[data-act="${name}"]`).click();
      showContextMenu(e.clientX, e.clientY, [
        { label: t('ctx.openTerminal'), action: () => openTerminalTab(s) },
        { label: t('item.files'), action: act('files') },
        { separator: true },
        { label: t('common.edit'), action: act('edit') },
        { label: t('session.copy'), action: act('copy') },
        { separator: true },
        { label: t('common.delete'), danger: true, action: act('del') },
      ]);
    });
    return row;
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ---------------- session dialog ----------------
  const sessionDialog = document.getElementById('sessionDialog');
  document.getElementById('btnNewSession').onclick = () => openSessionDialog(null);
  document.getElementById('sessCancel').onclick = () => sessionDialog.close();
  document.getElementById('sessAuthType').addEventListener('change', updateAuthRows);

  function updateAuthRows() {
    const t = document.getElementById('sessAuthType').value;
    document.getElementById('sessPasswordRow').classList.toggle('hidden', t !== 'password');
    document.getElementById('sessKeyRow').classList.toggle('hidden', t !== 'privateKey');
    document.getElementById('sessPassphraseRow').classList.toggle('hidden', t !== 'privateKey');
  }

  function populateGroupSelect() {
    const sel = document.getElementById('sessGroup');
    const prev = sel.value;
    sel.innerHTML = '';
    const none = document.createElement('option');
    none.value = ''; none.textContent = t('common.none');
    sel.appendChild(none);
    for (const g of state.groups) {
      const o = document.createElement('option'); o.value = g.id; o.textContent = g.name; sel.appendChild(o);
    }
    sel.value = prev;
  }

  // Empty/invalid -> default 30s; 0 (or negative) -> keepalive off.
  function parseKeepAlive(raw) {
    const n = parseInt(raw, 10);
    if (Number.isNaN(n)) return 30;
    return Math.min(Math.max(n, 0), 3600);
  }

  function openSessionDialog(sess, opts) {
    const copy = !!(sess && opts && opts.copy);
    document.getElementById('sessionDialogTitle').textContent = t(copy ? 'session.dialog.copy' : (sess ? 'session.dialog.edit' : 'session.dialog.new'));
    document.getElementById('sessId').value = sess && !copy ? sess.id : '';
    document.getElementById('sessCopyFrom').value = copy ? sess.id : '';
    document.getElementById('sessName').value = sess ? (copy ? t('session.copyName', { name: sess.name }) : sess.name) : '';
    document.getElementById('sessGroup').value = sess ? (sess.groupId || '') : '';
    document.getElementById('sessHost').value = sess ? sess.host : '';
    document.getElementById('sessPort').value = sess ? sess.port : 22;
    document.getElementById('sessUser').value = sess ? sess.username : '';
    document.getElementById('sessAuthType').value = sess ? sess.authType : 'password';
    document.getElementById('sessPassword').value = '';
    document.getElementById('sessPrivateKey').value = '';
    document.getElementById('sessPassphrase').value = '';
    document.getElementById('sessKeepAlive').value = sess && Number.isFinite(sess.keepAliveInterval) ? sess.keepAliveInterval : 30;
    updateAuthRows();
    sessionDialog.showModal();
  }

  document.getElementById('sessionForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = document.getElementById('sessId').value;
    const payload = {
      name: document.getElementById('sessName').value,
      groupId: document.getElementById('sessGroup').value,
      host: document.getElementById('sessHost').value,
      port: parseInt(document.getElementById('sessPort').value, 10),
      username: document.getElementById('sessUser').value,
      authType: document.getElementById('sessAuthType').value,
      password: document.getElementById('sessPassword').value,
      privateKey: document.getElementById('sessPrivateKey').value,
      passphrase: document.getElementById('sessPassphrase').value,
      keepAliveInterval: parseKeepAlive(document.getElementById('sessKeepAlive').value),
    };
    if (id) await api(`/api/sessions/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
    else {
      const copyFrom = document.getElementById('sessCopyFrom').value;
      const url = '/api/sessions' + (copyFrom ? `?copyFrom=${encodeURIComponent(copyFrom)}` : '');
      await api(url, { method: 'POST', body: JSON.stringify(payload) });
    }
    sessionDialog.close();
    await refreshAll();
  });

  // ---------------- group dialog ----------------
  const groupDialog = document.getElementById('groupDialog');
  document.getElementById('btnNewGroup').onclick = () => openGroupDialog(null);
  document.getElementById('groupCancel').onclick = () => groupDialog.close();

  function openGroupDialog(g) {
    document.getElementById('groupDialogTitle').textContent = t(g ? 'group.dialog.rename' : 'group.dialog.new');
    document.getElementById('groupId').value = g ? g.id : '';
    document.getElementById('groupName').value = g ? g.name : '';
    groupDialog.showModal();
  }

  document.getElementById('groupForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = document.getElementById('groupId').value;
    const name = document.getElementById('groupName').value;
    if (id) await api(`/api/groups/${id}`, { method: 'PUT', body: JSON.stringify({ name }) });
    else await api('/api/groups', { method: 'POST', body: JSON.stringify({ name }) });
    groupDialog.close();
    await refreshAll();
  });

  // ---------------- tunnels ----------------
  const tunnelListEl = document.getElementById('tunnelList');
  const tunnelDialog = document.getElementById('tunnelDialog');
  document.getElementById('btnNewTunnel').onclick = () => openTunnelDialog(null);
  document.getElementById('tunnelCancel').onclick = () => tunnelDialog.close();
  document.getElementById('tunnelType').addEventListener('change', updateTunnelRows);

  function updateTunnelRows() {
    const dynamic = document.getElementById('tunnelType').value === 'dynamic';
    document.getElementById('tunnelTargetHostRow').classList.toggle('hidden', dynamic);
    document.getElementById('tunnelTargetPortRow').classList.toggle('hidden', dynamic);
  }

  function populateTunnelSessionSelect() {
    const sel = document.getElementById('tunnelSession');
    sel.innerHTML = '';
    for (const s of state.sessions) {
      const o = document.createElement('option'); o.value = s.id; o.textContent = s.name; sel.appendChild(o);
    }
  }

  function openTunnelDialog(tun) {
    document.getElementById('tunnelDialogTitle').textContent = t(tun ? 'tunnel.dialog.edit' : 'tunnel.dialog.new');
    document.getElementById('tunnelId').value = tun ? tun.id : '';
    document.getElementById('tunnelName').value = tun ? tun.name : '';
    document.getElementById('tunnelSession').value = tun ? tun.sessionId : (state.sessions[0] && state.sessions[0].id) || '';
    document.getElementById('tunnelType').value = tun ? tun.type : 'local';
    document.getElementById('tunnelListenHost').value = tun ? tun.listenHost : '127.0.0.1';
    document.getElementById('tunnelListenPort').value = tun ? tun.listenPort : '';
    document.getElementById('tunnelTargetHost').value = tun ? tun.targetHost : '';
    document.getElementById('tunnelTargetPort').value = tun ? tun.targetPort : '';
    updateTunnelRows();
    tunnelDialog.showModal();
  }

  document.getElementById('tunnelForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = document.getElementById('tunnelId').value;
    const payload = {
      name: document.getElementById('tunnelName').value,
      sessionId: document.getElementById('tunnelSession').value,
      type: document.getElementById('tunnelType').value,
      listenHost: document.getElementById('tunnelListenHost').value,
      listenPort: parseInt(document.getElementById('tunnelListenPort').value, 10),
      targetHost: document.getElementById('tunnelTargetHost').value,
      targetPort: parseInt(document.getElementById('tunnelTargetPort').value, 10) || 0,
    };
    if (id) await api(`/api/tunnels/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
    else await api('/api/tunnels', { method: 'POST', body: JSON.stringify(payload) });
    tunnelDialog.close();
    await refreshAll();
  });

  function renderTunnels() {
    tunnelListEl.innerHTML = '';
    const query = state.searchQuery;
    const filtered = state.tunnels
      .filter((tn) => matchesQuery([tn.name, tn.listenHost, tn.targetHost], query))
      .slice()
      .sort((a, b) => naturalSort(a.name, b.name));

    if (query && filtered.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'search-empty';
      empty.textContent = t('search.noTunnels');
      tunnelListEl.appendChild(empty);
      return;
    }

    for (const tn of filtered) {
      const row = document.createElement('div');
      row.className = 'tunnel-item';
      const badge = tn.running
        ? `<span class="badge running">${escapeHtml(t('tunnel.running'))}</span>`
        : `<span class="badge">${escapeHtml(t('tunnel.stopped'))}</span>`;
      const detail = tn.type === 'dynamic'
        ? `SOCKS5 ${tn.listenHost}:${tn.listenPort}`
        : `${tn.listenHost}:${tn.listenPort} → ${tn.targetHost}:${tn.targetPort}`;
      row.innerHTML = `${badge}<span class="name item-main">
        <span class="item-title" title="${escapeHtml(tn.name)}">${escapeHtml(tn.name)}</span>
        <span class="session-sub" title="${escapeHtml(detail)}">${escapeHtml(detail)}</span>
      </span>`;
      const actions = document.createElement('span');
      actions.className = 'item-actions';
      const bStop = `<button data-act="stop" title="${escapeHtml(t('common.stop'))}">⏹</button>`;
      const bStart = `<button data-act="start" title="${escapeHtml(t('common.start'))}">▶</button>`;
      const bEdit = `<button data-act="edit" title="${escapeHtml(t('common.edit'))}">✎</button>`;
      const bDel = `<button data-act="del" title="${escapeHtml(t('common.delete'))}">🗑</button>`;
      actions.innerHTML = tn.running ? bStop + bDel : bStart + bEdit + bDel;
      row.appendChild(actions);

      const startBtn = actions.querySelector('[data-act="start"]');
      if (startBtn) startBtn.onclick = async () => { await api(`/api/tunnels/${tn.id}/start`, { method: 'POST' }); await refreshAll(); };
      const stopBtn = actions.querySelector('[data-act="stop"]');
      if (stopBtn) stopBtn.onclick = async () => { await api(`/api/tunnels/${tn.id}/stop`, { method: 'POST' }); await refreshAll(); };
      const editBtn = actions.querySelector('[data-act="edit"]');
      if (editBtn) editBtn.onclick = () => openTunnelDialog(tn);
      const delBtn = actions.querySelector('[data-act="del"]');
      if (delBtn) delBtn.onclick = async () => {
        if (confirm(t('tunnel.confirmDelete', { name: tn.name }))) { await api(`/api/tunnels/${tn.id}`, { method: 'DELETE' }); await refreshAll(); }
      };

      tunnelListEl.appendChild(row);
    }
  }


  // ---------------- terminal settings ----------------
  const TERM_SETTINGS_KEY = 'webssh-term-settings';
  const FONT_PRESETS = [
    { id: 'default', label: 'Default (monospace)', stack: 'Menlo, Consolas, "DejaVu Sans Mono", "Courier New", monospace' },
    { id: 'consolas', label: 'Consolas', stack: 'Consolas, "Courier New", monospace' },
    { id: 'menlo', label: 'Menlo / Monaco', stack: 'Menlo, Monaco, "Courier New", monospace' },
    { id: 'firacode', label: 'Fira Code', stack: '"Fira Code", "Cascadia Code", Menlo, Consolas, monospace' },
    { id: 'jetbrains', label: 'JetBrains Mono', stack: '"JetBrains Mono", Menlo, Consolas, monospace' },
    { id: 'courier', label: 'Courier New', stack: '"Courier New", Courier, monospace' },
    { id: 'custom', label: 'Custom…', stack: '' },
  ];
  const TERM_DEFAULTS = {
    fontSize: 14, fontPreset: 'default', fontCustom: '',
    background: '#1e1e1e', foreground: '#ffffff',
    cursorStyle: 'block', cursorBlink: true, scrollback: 5000,
  };

  function loadTermSettings() {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(TERM_SETTINGS_KEY) || '{}') || {}; } catch (_) {}
    return Object.assign({}, TERM_DEFAULTS, saved);
  }
  let termSettings = loadTermSettings();

  function clampInt(v, min, max, fallback) {
    const n = parseInt(v, 10);
    if (isNaN(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  }

  function termFontStack(s) {
    if (s.fontPreset === 'custom') return s.fontCustom.trim() || FONT_PRESETS[0].stack;
    const f = FONT_PRESETS.find((x) => x.id === s.fontPreset) || FONT_PRESETS[0];
    return f.stack;
  }

  function termOptions() {
    const s = termSettings;
    return {
      cursorBlink: !!s.cursorBlink,
      cursorStyle: ['block', 'bar', 'underline'].includes(s.cursorStyle) ? s.cursorStyle : 'block',
      fontSize: clampInt(s.fontSize, 8, 32, 14),
      fontFamily: termFontStack(s),
      scrollback: clampInt(s.scrollback, 500, 100000, 5000),
      theme: { background: s.background, foreground: s.foreground },
    };
  }

  function applyTermSettings() {
    const opts = termOptions();
    document.documentElement.style.setProperty('--term-bg', opts.theme.background);
    for (const tab of state.openTabs) {
      if (!tab.term) continue;
      try {
        for (const k of Object.keys(opts)) tab.term.options[k] = opts[k];
      } catch (_) {}
    }
    // Font changes alter the cell size, so re-fit and tell the server the new size.
    requestAnimationFrame(() => {
      for (const tab of state.openTabs) {
        if (!tab.term || !tab.fitAddon || !tab.pane || !tab.pane.classList.contains('active')) continue;
        try { tab.fitAddon.fit(); } catch (_) {}
        if (tab.ws && tab.ws.readyState === WebSocket.OPEN) {
          tab.ws.send(JSON.stringify({ type: 'resize', cols: tab.term.cols, rows: tab.term.rows }));
        }
      }
    });
  }

  function saveTermSettings() {
    try { localStorage.setItem(TERM_SETTINGS_KEY, JSON.stringify(termSettings)); } catch (_) {}
  }

  const settingsDialog = document.getElementById('settingsDialog');
  const setFontSize = document.getElementById('setFontSize');
  const setFontFamily = document.getElementById('setFontFamily');
  const setFontCustom = document.getElementById('setFontCustom');
  const setFontCustomRow = document.getElementById('setFontCustomRow');
  const setBg = document.getElementById('setBg');
  const setFg = document.getElementById('setFg');
  const setCursorStyle = document.getElementById('setCursorStyle');
  const setCursorBlink = document.getElementById('setCursorBlink');
  const setScrollback = document.getElementById('setScrollback');

  for (const f of FONT_PRESETS) {
    const o = document.createElement('option');
    o.value = f.id;
    o.textContent = f.label;
    setFontFamily.appendChild(o);
  }

  function fillSettingsForm() {
    const s = termSettings;
    setFontSize.value = s.fontSize;
    setFontFamily.value = s.fontPreset;
    setFontCustom.value = s.fontCustom;
    setFontCustomRow.classList.toggle('hidden', s.fontPreset !== 'custom');
    setBg.value = s.background;
    setFg.value = s.foreground;
    setCursorStyle.value = s.cursorStyle;
    setCursorBlink.checked = !!s.cursorBlink;
    setScrollback.value = s.scrollback;
  }

  function readSettingsForm() {
    termSettings = {
      fontSize: clampInt(setFontSize.value, 8, 32, TERM_DEFAULTS.fontSize),
      fontPreset: setFontFamily.value,
      fontCustom: setFontCustom.value,
      background: setBg.value,
      foreground: setFg.value,
      cursorStyle: setCursorStyle.value,
      cursorBlink: setCursorBlink.checked,
      scrollback: clampInt(setScrollback.value, 500, 100000, TERM_DEFAULTS.scrollback),
    };
    setFontCustomRow.classList.toggle('hidden', termSettings.fontPreset !== 'custom');
    saveTermSettings();
    applyTermSettings();
  }

  document.getElementById('btnSettings').addEventListener('click', () => {
    fillSettingsForm();
    settingsDialog.showModal();
  });
  settingsDialog.addEventListener('input', readSettingsForm);
  settingsDialog.addEventListener('change', readSettingsForm);
  document.getElementById('setReset').addEventListener('click', () => {
    termSettings = Object.assign({}, TERM_DEFAULTS);
    saveTermSettings();
    fillSettingsForm();
    applyTermSettings();
  });
  applyTermSettings();

  // ---------------- about ----------------
  // Fill in the project links here. Empty entries are hidden in the dialog.
  const ABOUT_LINKS = {
    github: 'https://github.com/casualty-01/web_ssh',
    website: 'https://www.114237041.xyz',
    dockerhub: 'https://hub.docker.com/r/casualty01/web_ssh',
  };
  const aboutDialog = document.getElementById('aboutDialog');
  document.getElementById('btnAbout').addEventListener('click', () => {
    for (const key of Object.keys(ABOUT_LINKS)) {
      const a = document.getElementById('about' + key.charAt(0).toUpperCase() + key.slice(1));
      if (!a) continue;
      const url = ABOUT_LINKS[key];
      if (url) { a.href = url; a.textContent = url; }
      a.parentElement.classList.toggle('hidden', !url);
    }
    document.getElementById('aboutVersion').textContent = t('build.version', { version: buildVersion });
    aboutDialog.showModal();
  });


  // ---------------- context menu ----------------
  let ctxMenuEl = null;

  function hideContextMenu() {
    if (ctxMenuEl) { ctxMenuEl.remove(); ctxMenuEl = null; }
  }

  function showContextMenu(x, y, items) {
    hideContextMenu();
    const menu = document.createElement('div');
    menu.className = 'ctx-menu';
    for (const it of items) {
      if (it.separator) {
        const sep = document.createElement('div');
        sep.className = 'ctx-sep';
        menu.appendChild(sep);
        continue;
      }
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ctx-item' + (it.danger ? ' danger' : '');
      b.textContent = it.label;
      b.disabled = !!it.disabled;
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        hideContextMenu();
        it.action();
      });
      menu.appendChild(b);
    }
    document.body.appendChild(menu);
    const r = menu.getBoundingClientRect();
    menu.style.left = Math.max(4, Math.min(x, window.innerWidth - r.width - 4)) + 'px';
    menu.style.top = Math.max(4, Math.min(y, window.innerHeight - r.height - 4)) + 'px';
    ctxMenuEl = menu;
  }

  document.addEventListener('click', hideContextMenu);
  document.addEventListener('contextmenu', (e) => {
    if (ctxMenuEl && !e.target.closest('.ctx-menu')) hideContextMenu();
  }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideContextMenu(); });
  window.addEventListener('blur', hideContextMenu);
  window.addEventListener('resize', hideContextMenu);

  // ---------------- tab status / reconnect / duplicate / bulk close ----------------
  // status: 'connecting' | 'connected' | 'disconnected' | 'error'
  function setTabStatus(tab, status) {
    tab.status = status;
    const dot = tabBar.querySelector(`.tab[data-tab-id="${tab.id}"] .tab-status`);
    if (dot) {
      dot.className = 'tab-status ' + status;
      dot.title = t('tab.status.' + status);
    }
    if (tab.overlay) {
      const bad = status === 'disconnected' || status === 'error';
      tab.overlay.classList.toggle('hidden', !bad);
      tab.overlay.querySelector('.term-overlay-msg').textContent =
        t(status === 'error' ? 'term.overlay.failed' : 'term.overlay.disconnected');
      tab.overlay.querySelector('button').textContent = t('term.reconnect');
    }
  }

  function refreshTabStatusTexts() {
    for (const tb of state.openTabs) setTabStatus(tb, tb.status || 'connected');
  }

  // Detach the current socket (the server keeps the shell for its idle grace
  // period) and connect again. If the shell itself has ended, start a new one.
  function reconnectTab(tab) {
    if (!tab || tab.kind !== 'terminal') return;
    const old = tab.ws;
    tab.ws = null;
    if (old) {
      old.onopen = old.onmessage = old.onclose = old.onerror = null;
      try { old.close(); } catch (_) {}
    }
    if (tab.shellClosed) {
      tab.termId = genTermId();
      tab.shellClosed = false;
      tab.term.write(`\r\n\x1b[90m${t('term.reconnecting')}\x1b[0m\r\n`);
      saveWorkspace();
    } else {
      // Reattaching replays the shell's scrollback, so clear the screen first
      // to avoid showing the same output twice.
      tab.term.reset();
    }
    try { tab.fitAddon.fit(); } catch (_) {}
    connectWS(tab);
  }

  // Tabs can be renamed locally (browser only, saved with the workspace);
  // the saved session name on the server is never touched.
  function tabLabel(tb) {
    return tb.customName || tb.name;
  }

  function applyTabName(tb, input) {
    const name = String(input || '').trim().slice(0, 60);
    tb.customName = name && name !== tb.name ? name : null;
    renderTabBar();
    if (state.layout !== 'single') renderSplitSelects();
    saveWorkspace();
  }

  // Rename in place: the tab label turns into a text box. Enter / blur
  // saves, Esc cancels. Empty text restores the session name.
  function renameTab(tb) {
    const el = tabBar.querySelector(`.tab[data-tab-id="${tb.id}"]`);
    const label = el && el.querySelector('.tab-label');
    if (!label) {
      const input = prompt(t('tab.renamePrompt'), tabLabel(tb));
      if (input !== null) applyTabName(tb, input);
      return;
    }
    if (el.querySelector('.tab-rename')) return;
    const box = document.createElement('input');
    box.type = 'text';
    box.className = 'tab-rename';
    box.maxLength = 60;
    box.value = tabLabel(tb);
    box.title = t('tab.renamePrompt');
    label.style.display = 'none';
    label.after(box);
    el.draggable = false; // otherwise text selection inside the input starts a tab drag

    let done = false;
    const finish = (save) => {
      if (done) return;
      done = true;
      if (save) applyTabName(tb, box.value);
      else renderTabBar();
    };
    for (const ev of ['click', 'dblclick', 'mousedown', 'contextmenu', 'auxclick']) {
      box.addEventListener(ev, (e) => e.stopPropagation());
    }
    box.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
    box.addEventListener('blur', () => finish(true));
    // Wait a tick so the context menu's own click handling doesn't steal focus.
    setTimeout(() => { box.focus(); box.select(); }, 0);
  }

  // Disconnect only the backend shell; the tab and its terminal window stay
  // (scrollback remains readable) and can be reconnected later, which starts
  // a fresh shell.
  function canDisconnectTab(tb) {
    return tb.kind === 'terminal' && !!tb.ws && tb.ws.readyState === WebSocket.OPEN;
  }

  function disconnectTab(tb) {
    if (!canDisconnectTab(tb)) return;
    tb.userDisconnect = true;
    try { tb.ws.send(JSON.stringify({ type: 'close' })); } catch (_) {}
    // The server answers with a "closed" message and drops the socket; that
    // handler (see connectWS) marks the tab disconnected.
  }

  function duplicateTab(tb) {
    const sess = state.sessions.find((s) => s.id === tb.sessionId);
    if (!sess) return;
    const idx = state.openTabs.indexOf(tb);
    if (tb.kind === 'sftp') openSftpTab(sess);
    else openTerminalTab(sess);
    // Place the copy right next to the original instead of at the far end.
    const last = state.openTabs.length - 1;
    if (idx >= 0 && idx + 1 < last) {
      const [created] = state.openTabs.splice(last, 1);
      state.openTabs.splice(idx + 1, 0, created);
      renderTabBar();
      if (state.layout !== 'single') renderSplitSelects();
      saveWorkspace();
    }
  }

  function closeTabs(list) {
    if (list.length > 1 && !confirm(t('tab.confirmCloseMany', { count: list.length }))) return;
    for (const tb of list) closeTab(tb.id);
  }

  function moveTab(srcId, targetId, after) {
    const from = state.openTabs.findIndex((x) => x.id === srcId);
    if (from === -1) return;
    const [moved] = state.openTabs.splice(from, 1);
    let to = state.openTabs.findIndex((x) => x.id === targetId);
    if (to === -1) to = state.openTabs.length;
    else if (after) to += 1;
    state.openTabs.splice(to, 0, moved);
    renderTabBar();
    if (state.layout !== 'single') renderSplitSelects();
    saveWorkspace();
  }

  function showTabMenu(x, y, tb) {
    const idx = state.openTabs.indexOf(tb);
    const hasSession = state.sessions.some((s) => s.id === tb.sessionId);
    const othersCount = state.openTabs.length - 1;
    const rightCount = state.openTabs.length - idx - 1;
    showContextMenu(x, y, [
      { label: t('tab.menu.reconnect'), action: () => (tb.kind === 'terminal' ? reconnectTab(tb) : (tb.reload && tb.reload())) },
      { label: t('tab.menu.disconnect'), disabled: !canDisconnectTab(tb), action: () => disconnectTab(tb) },
      { label: t('tab.menu.rename'), action: () => renameTab(tb) },
      { label: t('tab.menu.duplicate'), disabled: !hasSession, action: () => duplicateTab(tb) },
      { separator: true },
      { label: t('tab.menu.close'), action: () => closeTab(tb.id) },
      { label: t('tab.menu.closeOthers'), disabled: othersCount === 0, action: () => closeTabs(state.openTabs.filter((x) => x !== tb)) },
      { label: t('tab.menu.closeRight'), disabled: rightCount === 0, action: () => closeTabs(state.openTabs.slice(idx + 1)) },
      { label: t('tab.menu.closeAll'), danger: true, action: () => closeTabs(state.openTabs.slice()) },
    ]);
  }

  let draggingTabId = null;
  function clearTabDropMarks() {
    tabBar.querySelectorAll('.drop-before, .drop-after').forEach((el) => el.classList.remove('drop-before', 'drop-after'));
  }

  // ---------------- terminal tabs ----------------
  const tabBar = document.getElementById('tabBar');
  const terminalsEl = document.getElementById('terminals');
  const emptyState = document.getElementById('emptyState');

  function wsURL(sessionId, termId, cols, rows) {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    return `${proto}://${location.host}/ws/ssh?id=${encodeURIComponent(sessionId)}&term=${encodeURIComponent(termId)}&cols=${cols}&rows=${rows}`;
  }

  // termId identifies the *live shell*, not just the tab: pass one in when
  // recreating a tab that already had a shell running (a refresh) so the
  // new WebSocket reattaches to it; omit it to start a genuinely new shell.
  function openTerminalTab(sess, termId) {
    const tabId = `tab-${sess.id}-${Date.now()}`;
    termId = termId || genTermId();
    const term = new Terminal(termOptions());
    const fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);

    const pane = document.createElement('div');
    pane.className = 'term-pane';
    pane.id = tabId;
    terminalsEl.appendChild(pane);

    const tab = { id: tabId, sessionId: sess.id, termId, name: sess.name, kind: 'terminal', term, fitAddon, ws: null, pane, status: 'connecting', shellClosed: false, overlay: null };
    const overlay = document.createElement('div');
    overlay.className = 'term-overlay hidden';
    overlay.innerHTML = '<span class="term-overlay-msg"></span><button type="button"></button>';
    overlay.querySelector('button').addEventListener('click', () => reconnectTab(tab));
    pane.appendChild(overlay);
    tab.overlay = overlay;
    state.openTabs.push(tab);
    renderTabBar();
    showTab(tabId);
    saveWorkspace();

    // term.open() must run AFTER the pane gets its "active" class from
    // showTab() above. .term-pane is `display: none` until then, and
    // xterm.js measures its character-cell size against the container at
    // open() time — measuring a hidden (0×0) container gives it a bogus
    // cell size that later fit() calls keep computing from, which is why
    // a freshly-opened tab renders at a fraction of its real size until
    // something (e.g. switching tabs) forces a fresh measurement.
    term.open(pane);

    requestAnimationFrame(() => {
      fitAddon.fit();
      connectWS(tab);
    });

    term.onData((data) => {
      // Dead connection: Enter reconnects, everything else is ignored
      // (don't type into a shell that no longer exists).
      if (tab.status === 'disconnected' || tab.status === 'error') {
        if (data === '\r') reconnectTab(tab);
        return;
      }
      if (tab.ws && tab.ws.readyState === WebSocket.OPEN) {
        tab.ws.send(JSON.stringify({ type: 'data', data }));
      }
    });

    const resizeObserver = new ResizeObserver(() => {
      if (tab.pane.classList.contains('active')) {
        try { fitAddon.fit(); } catch (_) {}
        if (tab.ws && tab.ws.readyState === WebSocket.OPEN) {
          tab.ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
        }
      }
    });
    resizeObserver.observe(terminalsEl);
    tab.resizeObserver = resizeObserver;
  }

  function connectWS(tab) {
    const { cols, rows } = tab.term;
    const ws = new WebSocket(wsURL(tab.sessionId, tab.termId, cols, rows));
    tab.ws = ws;
    setTabStatus(tab, 'connecting');
    // The socket opens before the SSH dial finishes, so "connected" really
    // means the first output arrived. A quiet reattached shell may send none,
    // hence the fallback timer.
    ws.onopen = () => {
      setTimeout(() => {
        if (tab.ws === ws && ws.readyState === WebSocket.OPEN && tab.status === 'connecting') setTabStatus(tab, 'connected');
      }, 3000);
    };
    ws.onmessage = (evt) => {
      if (tab.ws !== ws) return;
      try {
        const msg = JSON.parse(evt.data);
        if (msg.type === 'data') {
          if (tab.status !== 'connected') setTabStatus(tab, 'connected');
          tab.term.write(msg.data);
        } else if (msg.type === 'error') {
          tab.term.write(`\r\n\x1b[31m${t('term.error', { message: msg.message })}\x1b[0m\r\n`);
          setTabStatus(tab, 'error');
        } else if (msg.type === 'closed') {
          tab.shellClosed = true;
          tab.term.write(`\r\n\x1b[33m${t(tab.userDisconnect ? 'term.disconnectedByUser' : 'term.closed')}\x1b[0m\r\n`);
          tab.userDisconnect = false;
          setTabStatus(tab, 'disconnected');
        }
      } catch (_) {}
    };
    ws.onclose = () => {
      if (tab.ws !== ws) return;
      if (!tab.shellClosed) tab.term.write(`\r\n\x1b[33m${t('term.disconnected')}\x1b[0m\r\n`);
      if (tab.status !== 'error') setTabStatus(tab, 'disconnected');
      // A closed/failed socket can mean the network hiccuped, or it can mean
      // the auth cookie expired (the ws upgrade is behind the same auth
      // middleware as the REST API, so an expired session gets the upgrade
      // rejected with 401 and just looks like a normal close here). Check
      // which one it was and bounce to the login screen if we're logged out.
      checkSessionAlive();
    };
    ws.onerror = () => {};
  }

  // Used to detect an expired login session after a WebSocket
  // connection fails/closes, since that path doesn't go through the
  // api() helper's automatic 401 -> showLogin() handling.
  async function checkSessionAlive() {
    try {
      const r = await api('/api/me');
      if (!r || !r.authenticated) showLogin();
    } catch (_) {
      // api() already calls showLogin() itself on a 401 here.
    }
  }

  const PANE_BADGES = ['①', '②', '③', '④'];

  function renderTabBar() {
    tabBar.innerHTML = '';
    const isSplit = state.layout !== 'single';
    emptyState.classList.toggle('hidden', state.openTabs.length > 0 || isSplit);
    for (const tb of state.openTabs) {
      const el = document.createElement('div');
      const paneIdx = state.paneTabs.indexOf(tb.id);
      const isActive = isSplit ? paneIdx !== -1 : tb.id === state.activeTab;
      el.className = 'tab' + (isActive ? ' active' : '');
      el.dataset.tabId = tb.id;
      el.draggable = true;
      const icon = tb.kind === 'sftp' ? '📁' : '🖥';
      const status = tb.status || 'connected';
      const badge = isSplit && paneIdx !== -1
        ? `<span class="split-badge">${PANE_BADGES[paneIdx] || paneIdx}</span>`
        : '';
      el.title = tabLabel(tb);
      el.innerHTML = `<span class="tab-status ${status}" title="${escapeHtml(t('tab.status.' + status))}"></span><span class="tab-label">${icon} ${escapeHtml(tabLabel(tb))}</span>${badge}<span class="close">✕</span>`;
      el.onclick = () => showTab(tb.id);
      el.querySelector('.close').onclick = (e) => { e.stopPropagation(); closeTab(tb.id); };
      el.addEventListener('dblclick', (e) => {
        if (e.target.closest('.close')) return;
        renameTab(tb);
      });
      el.addEventListener('auxclick', (e) => { if (e.button === 1) { e.preventDefault(); closeTab(tb.id); } });
      el.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showTabMenu(e.clientX, e.clientY, tb);
      });

      // drag to reorder
      el.addEventListener('dragstart', (e) => {
        draggingTabId = tb.id;
        e.dataTransfer.effectAllowed = 'move';
        try { e.dataTransfer.setData('text/plain', tb.id); } catch (_) {}
        el.classList.add('dragging');
      });
      el.addEventListener('dragend', () => {
        draggingTabId = null;
        el.classList.remove('dragging');
        clearTabDropMarks();
      });
      el.addEventListener('dragover', (e) => {
        if (!draggingTabId || draggingTabId === tb.id) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        const r = el.getBoundingClientRect();
        const after = e.clientX > r.left + r.width / 2;
        clearTabDropMarks();
        el.classList.add(after ? 'drop-after' : 'drop-before');
      });
      el.addEventListener('dragleave', () => el.classList.remove('drop-before', 'drop-after'));
      el.addEventListener('drop', (e) => {
        e.preventDefault();
        if (!draggingTabId || draggingTabId === tb.id) return;
        const r = el.getBoundingClientRect();
        moveTab(draggingTabId, tb.id, e.clientX > r.left + r.width / 2);
        draggingTabId = null;
      });
      tabBar.appendChild(el);
    }
  }

  // Show a tab, respecting whether split view is currently on.
  function showTab(tabId) {
    if (state.layout !== 'single') {
      const emptySlot = state.paneTabs.indexOf(null);
      assignPane(emptySlot !== -1 ? emptySlot : 0, tabId);
    } else {
      activateTab(tabId);
    }
  }

  function activateTab(tabId) {
    state.activeTab = tabId;
    for (const t of state.openTabs) {
      const isActive = t.id === tabId;
      t.pane.classList.toggle('active', isActive);
    }
    renderTabBar();
    // Fit AND push the new size to the backend PTY — a local-only fit()
    // leaves xterm looking right while htop/nano (which read the real PTY
    // size) stay stuck at whatever size was last sent over the socket.
    refitVisibleTabs();
    saveWorkspace();
  }

  function closeTab(tabId) {
    const idx = state.openTabs.findIndex((t) => t.id === tabId);
    if (idx === -1) return;
    const [tab] = state.openTabs.splice(idx, 1);
    if (tab.kind === 'terminal') {
      if (tab.ws) {
        // Closing the tab on purpose (not just navigating away/refreshing)
        // means the user is done with this shell — tell the backend to
        // kill it now instead of leaving it running for the idle grace
        // period with nobody ever coming back to it.
        if (tab.ws.readyState === WebSocket.OPEN) {
          try { tab.ws.send(JSON.stringify({ type: 'close' })); } catch (_) {}
        }
        tab.ws.close();
      }
      if (tab.resizeObserver) tab.resizeObserver.disconnect();
      tab.term.dispose();
    }
    tab.pane.remove();
    if (state.layout !== 'single') {
      state.paneTabs = state.paneTabs.map((id) => (id === tabId ? null : id));
      applyPaneAssignments();
    }
    if (state.activeTab === tabId) {
      const next = state.openTabs[state.openTabs.length - 1];
      state.activeTab = next ? next.id : null;
      if (next && state.layout === 'single') activateTab(next.id);
    }
    renderTabBar();
    saveWorkspace();
  }

  function closeTabForSession(sessionId) {
    for (const t of state.openTabs.filter((t) => t.sessionId === sessionId)) closeTab(t.id);
  }

  // ---------------- full screen ----------------
  // Independent of the split-layout toolbar: works with a single open
  // session just as well as with any split layout.
  const btnFullscreen = document.getElementById('btnFullscreen');

  async function toggleFullscreen() {
    try {
      if (!document.fullscreenElement) {
        await appEl.requestFullscreen();
      } else {
        await document.exitFullscreen();
      }
    } catch (_) {
      // Fullscreen API unavailable/blocked (e.g. iframe without allow="fullscreen") —
      // fall back to the chrome-hiding CSS mode only.
      appEl.classList.toggle('fullscreen-mode');
      syncFullscreenButton();
      refitVisibleTabs();
      setTimeout(refitVisibleTabs, 60);
      setTimeout(refitVisibleTabs, 250);
    }
  }

  function syncFullscreenButton() {
    const active = appEl.classList.contains('fullscreen-mode');
    btnFullscreen.classList.toggle('active', active);
    btnFullscreen.title = t(active ? 'fullscreen.exit' : 'fullscreen.enter');
  }

  btnFullscreen.addEventListener('click', toggleFullscreen);

  document.addEventListener('fullscreenchange', () => {
    appEl.classList.toggle('fullscreen-mode', !!document.fullscreenElement);
    syncFullscreenButton();
    // The fullscreen transition can take a moment to actually resize the
    // viewport, so a single requestAnimationFrame refit can fire too early
    // and leave xterm sized for the old (small) window. Refit repeatedly
    // for a bit to make sure we catch the final size.
    refitVisibleTabs();
    setTimeout(refitVisibleTabs, 60);
    setTimeout(refitVisibleTabs, 250);
  });

  // Some browsers/OSes resize the fullscreen viewport asynchronously
  // (e.g. after an animation), separate from the fullscreenchange event.
  window.addEventListener('resize', refitVisibleTabs);

  // ---------------- layout / split-screen view ----------------
  const LAYOUT_PANE_COUNT = { single: 1, horizontal: 2, vertical: 2, grid: 4 };
  let splitPanesEls = []; // [{ root, select, body }, ...]

  document.getElementById('layoutToolbar').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-layout]');
    if (!btn) return;
    setLayout(btn.dataset.layout);
  });

  function setLayout(layout) {
    if (state.layout === layout) return;
    const prev = state.layout;
    state.layout = layout;

    // update toolbar active state
    document.querySelectorAll('#layoutToolbar .layout-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset.layout === layout);
    });

    if (layout === 'single') {
      exitSplitMode();
    } else {
      enterSplitMode(layout, prev);
    }
    saveWorkspace();
  }

  function enterSplitMode(layout, prevLayout) {
    // preserve currently assigned tabs where possible
    const prevAssigned = state.paneTabs.filter(Boolean);
    const count = LAYOUT_PANE_COUNT[layout];

    // tear down previous split structure if any
    if (prevLayout !== 'single') {
      terminalsEl.querySelectorAll('.split-pane, .split-divider').forEach((el) => el.remove());
    } else {
      // move panes out of the way before clearing
      for (const t of state.openTabs) {
        if (t.pane.parentNode === terminalsEl) t.pane.remove();
      }
    }

    terminalsEl.className = `terminals split layout-${layout}`;
    terminalsEl.style.gridTemplateColumns = '';
    terminalsEl.style.gridTemplateRows = '';
    terminalsEl.innerHTML = '';
    splitPanesEls = [];

    for (let i = 0; i < count; i++) {
      const root = document.createElement('div');
      root.className = 'split-pane';
      root.dataset.pane = String(i);
      root.innerHTML = `
        <div class="split-pane-header"><select class="split-pane-select"></select></div>
        <div class="split-pane-body"></div>`;
      const select = root.querySelector('.split-pane-select');
      select.addEventListener('change', () => assignPane(i, select.value || null));
      splitPanesEls.push({ root, select, body: root.querySelector('.split-pane-body') });
      terminalsEl.appendChild(root);
    }

    // add dividers depending on layout
    if (layout === 'horizontal') {
      const div = document.createElement('div');
      div.className = 'split-divider horizontal';
      terminalsEl.insertBefore(div, splitPanesEls[1].root);
      setupDividerDrag(div, 'horizontal');
    } else if (layout === 'vertical') {
      const div = document.createElement('div');
      div.className = 'split-divider vertical';
      terminalsEl.insertBefore(div, splitPanesEls[1].root);
      setupDividerDrag(div, 'vertical');
    } else if (layout === 'grid') {
      const dh = document.createElement('div');
      dh.className = 'split-divider horizontal';
      dh.dataset.div = 'h';
      const dh2 = document.createElement('div');
      dh2.className = 'split-divider horizontal';
      dh2.dataset.div = 'h2';
      const dv = document.createElement('div');
      dv.className = 'split-divider vertical';
      dv.dataset.div = 'v';
      terminalsEl.appendChild(dh);
      terminalsEl.appendChild(dh2);
      terminalsEl.appendChild(dv);
      setupGridDrag(dh, dh2, dv);
    }

    // assign tabs: reuse previous assignments, then fill remaining from open tabs
    const used = new Set();
    state.paneTabs = Array(count).fill(null);
    for (let i = 0; i < count && i < prevAssigned.length; i++) {
      state.paneTabs[i] = prevAssigned[i];
      used.add(prevAssigned[i]);
    }
    for (let i = 0; i < count; i++) {
      if (state.paneTabs[i]) continue;
      const candidate = state.openTabs.find((t) => !used.has(t.id));
      if (candidate) {
        state.paneTabs[i] = candidate.id;
        used.add(candidate.id);
      }
    }
    if (!state.paneTabs.includes(state.activeTab)) {
      state.activeTab = state.paneTabs.find(Boolean) || state.activeTab;
    }

    renderSplitSelects();
    applyPaneAssignments();
    renderTabBar();
  }

  function exitSplitMode() {
    for (const t of state.openTabs) terminalsEl.appendChild(t.pane);
    terminalsEl.className = 'terminals';
    terminalsEl.style.gridTemplateColumns = '';
    terminalsEl.style.gridTemplateRows = '';
    terminalsEl.querySelectorAll('.split-pane, .split-divider').forEach((el) => el.remove());
    splitPanesEls = [];
    state.paneTabs = [state.activeTab];
    for (const t of state.openTabs) t.pane.classList.toggle('active', t.id === state.activeTab);
    renderTabBar();
    refitVisibleTabs();
  }

  function renderSplitSelects() {
    splitPanesEls.forEach((slot, i) => {
      const assignedElsewhere = new Set(state.paneTabs.filter((id, idx) => id && idx !== i));
      const options = [`<option value="">${escapeHtml(t('common.empty'))}</option>`].concat(
        state.openTabs
          .filter((t) => !assignedElsewhere.has(t.id))
          .map((t) => {
            const icon = t.kind === 'sftp' ? '📁' : '🖥';
            const sel = t.id === state.paneTabs[i] ? ' selected' : '';
            return `<option value="${t.id}"${sel}>${icon} ${escapeHtml(tabLabel(t))}</option>`;
          })
      );
      slot.select.innerHTML = options.join('');
    });
  }

  function assignPane(i, tabId) {
    if (tabId) {
      const other = state.paneTabs.indexOf(tabId);
      if (other !== -1 && other !== i) state.paneTabs[other] = null;
    }
    state.paneTabs[i] = tabId || null;
    if (tabId) state.activeTab = tabId;
    renderSplitSelects();
    applyPaneAssignments();
    renderTabBar();
    saveWorkspace();
  }

  function applyPaneAssignments() {
    for (const t of state.openTabs) t.pane.classList.remove('active');
    splitPanesEls.forEach((slot, i) => {
      slot.body.innerHTML = '';
      const tab = state.openTabs.find((t) => t.id === state.paneTabs[i]);
      if (tab) {
        slot.body.appendChild(tab.pane);
        tab.pane.classList.add('active');
      } else {
        const empty = document.createElement('div');
        empty.className = 'split-empty';
        empty.textContent = t('split.choose');
        slot.body.appendChild(empty);
      }
    });
    refitVisibleTabs();
  }

  function refitVisibleTabs() {
    requestAnimationFrame(() => {
      for (const t of state.openTabs) {
        if (t.kind === 'terminal' && t.pane.classList.contains('active') && t.pane.isConnected) {
          try { t.fitAddon.fit(); } catch (_) {}
          if (t.ws && t.ws.readyState === WebSocket.OPEN) {
            t.ws.send(JSON.stringify({ type: 'resize', cols: t.term.cols, rows: t.term.rows }));
          }
        }
      }
    });
  }

  function setupDividerDrag(divider, orientation) {
    let dragging = false;
    divider.addEventListener('mousedown', (e) => {
      dragging = true;
      divider.classList.add('dragging');
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const rect = terminalsEl.getBoundingClientRect();
      if (orientation === 'horizontal') {
        let pct = ((e.clientX - rect.left) / rect.width) * 100;
        pct = Math.min(80, Math.max(20, pct));
        splitPanesEls[0].root.style.flex = `0 0 ${pct}%`;
        splitPanesEls[1].root.style.flex = '1 1 auto';
      } else {
        let pct = ((e.clientY - rect.top) / rect.height) * 100;
        pct = Math.min(80, Math.max(20, pct));
        splitPanesEls[0].root.style.flex = `0 0 ${pct}%`;
        splitPanesEls[1].root.style.flex = '1 1 auto';
      }
    });
    window.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      divider.classList.remove('dragging');
      refitVisibleTabs();
    });
  }

  function setupGridDrag(dh, dh2, dv) {
    let dragV = false;
    let dragH = false;
    let rowPct = 50;
    let colPct = 50;

    dv.addEventListener('mousedown', (e) => {
      dragV = true; dv.classList.add('dragging'); e.preventDefault();
    });
    const onHDown = (e) => {
      dragH = true;
      dh.classList.add('dragging');
      dh2.classList.add('dragging');
      e.preventDefault();
    };
    dh.addEventListener('mousedown', onHDown);
    dh2.addEventListener('mousedown', onHDown);

    window.addEventListener('mousemove', (e) => {
      if (!dragV && !dragH) return;
      const rect = terminalsEl.getBoundingClientRect();
      if (dragV) {
        rowPct = Math.min(80, Math.max(20, ((e.clientY - rect.top) / rect.height) * 100));
      }
      if (dragH) {
        colPct = Math.min(80, Math.max(20, ((e.clientX - rect.left) / rect.width) * 100));
      }
      terminalsEl.style.gridTemplateColumns = `${colPct}% 5px ${100 - colPct}%`;
      terminalsEl.style.gridTemplateRows = `${rowPct}% 5px ${100 - rowPct}%`;
    });
    window.addEventListener('mouseup', () => {
      if (!dragV && !dragH) return;
      dragV = false; dragH = false;
      dh.classList.remove('dragging');
      dh2.classList.remove('dragging');
      dv.classList.remove('dragging');
      refitVisibleTabs();
    });
  }

  // ---------------- SFTP browser tab ----------------
  const SFTP_SORT_KEY = 'webssh-sftp-sort';
  const SFTP_CONC_KEY = 'webssh-sftp-concurrency';
  const SFTP_DEFAULT_CONCURRENCY = 5;
  const SFTP_MAX_CONCURRENCY = 16;
  // Files at/over SOLO bytes get an upload request of their own; smaller
  // ones are packed into shared requests so a folder of thousands of tiny
  // files doesn't pay one SSH handshake per file.
  const UPLOAD_SOLO_BYTES = 4 * 1024 * 1024;
  const UPLOAD_BATCH_BYTES = 8 * 1024 * 1024;
  const UPLOAD_BATCH_FILES = 100;
  const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|ico|svg)$/i;
  // Copy/Cut clipboard for the SFTP browser, keyed by session id so two tabs
  // of the same server share it: { op: 'copy'|'move', paths: [...] }.
  const sftpClipboard = {};

  function loadSftpSort() {
    try {
      const s = JSON.parse(localStorage.getItem(SFTP_SORT_KEY) || 'null');
      if (s && ['name', 'mtime', 'mode', 'size'].includes(s.key)) return { key: s.key, dir: s.dir === 'desc' ? 'desc' : 'asc' };
    } catch (_) {}
    return { key: 'name', dir: 'asc' };
  }

  function clampConcurrency(n) {
    n = parseInt(n, 10);
    if (!Number.isFinite(n)) return SFTP_DEFAULT_CONCURRENCY;
    return Math.max(1, Math.min(SFTP_MAX_CONCURRENCY, n));
  }

  function loadConcurrency() {
    try { return clampConcurrency(localStorage.getItem(SFTP_CONC_KEY) || SFTP_DEFAULT_CONCURRENCY); } catch (_) {}
    return SFTP_DEFAULT_CONCURRENCY;
  }

  function fmtDateTime(v) {
    const d = new Date(v);
    if (isNaN(d.getTime())) return '';
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  // Full-screen image viewer. `images` are SFTP entries; ←/→ switch between
  // them, Esc closes, clicking the picture toggles fit / actual size.
  function openImagePreview(sessId, images, startIndex) {
    if (!images.length) return;
    let idx = Math.max(0, Math.min(startIndex, images.length - 1));
    const overlay = document.createElement('div');
    overlay.className = 'img-preview';
    overlay.innerHTML = `
      <div class="img-preview-bar">
        <span class="img-preview-title"></span>
        <span class="img-preview-count"></span>
        <button type="button" class="img-preview-dl"></button>
        <button type="button" class="img-preview-close">✕</button>
      </div>
      <button type="button" class="img-preview-nav prev">‹</button>
      <div class="img-preview-stage"><img alt=""><div class="img-preview-msg"></div></div>
      <button type="button" class="img-preview-nav next">›</button>`;
    const titleEl = overlay.querySelector('.img-preview-title');
    const countEl = overlay.querySelector('.img-preview-count');
    const dlBtn = overlay.querySelector('.img-preview-dl');
    const closeBtn = overlay.querySelector('.img-preview-close');
    const stage = overlay.querySelector('.img-preview-stage');
    const img = overlay.querySelector('img');
    const msg = overlay.querySelector('.img-preview-msg');
    const prevBtn = overlay.querySelector('.img-preview-nav.prev');
    const nextBtn = overlay.querySelector('.img-preview-nav.next');
    dlBtn.textContent = t('sftp.download');
    closeBtn.title = t('common.close');
    const fileURL = (p, inline) => `/api/sftp/${sessId}/download?path=${encodeURIComponent(p)}${inline ? '&inline=1' : ''}`;

    function show(i) {
      idx = (i + images.length) % images.length;
      const e = images[idx];
      titleEl.textContent = e.name;
      countEl.textContent = `${idx + 1} / ${images.length}`;
      stage.classList.remove('zoom');
      msg.textContent = t('sftp.loading');
      msg.classList.remove('hidden');
      img.classList.add('hidden');
      img.onload = () => { msg.classList.add('hidden'); img.classList.remove('hidden'); };
      img.onerror = () => { msg.textContent = t('sftp.previewFailed'); };
      img.src = fileURL(e.path, true);
      prevBtn.classList.toggle('hidden', images.length < 2);
      nextBtn.classList.toggle('hidden', images.length < 2);
    }

    function close() {
      document.removeEventListener('keydown', onKey, true);
      img.onload = img.onerror = null;
      img.removeAttribute('src');
      overlay.remove();
    }
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); show(idx - 1); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); show(idx + 1); }
    }

    closeBtn.onclick = close;
    dlBtn.onclick = () => { window.location.href = fileURL(images[idx].path, false); };
    prevBtn.onclick = (e) => { e.stopPropagation(); show(idx - 1); };
    nextBtn.onclick = (e) => { e.stopPropagation(); show(idx + 1); };
    img.onclick = (e) => { e.stopPropagation(); stage.classList.toggle('zoom'); };
    stage.onclick = (e) => { if (e.target === stage) close(); };
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(overlay);
    show(idx);
  }

  function openSftpTab(sess) {
    const tabId = `sftp-${sess.id}-${Date.now()}`;
    const pane = document.createElement('div');
    pane.className = 'term-pane sftp-pane';
    pane.id = tabId;
    pane.innerHTML = `
      <div class="sftp-toolbar">
        <button class="sftp-up" data-i18n-title="sftp.up">⬆</button>
        <div class="sftp-path" data-i18n-title="sftp.pathHint">
          <span class="sftp-crumbs"></span>
          <input type="text" class="sftp-path-input hidden" spellcheck="false" autocomplete="off" data-i18n-placeholder="sftp.pathPlaceholder" />
        </div>
        <button class="sftp-edit-path" data-i18n-title="sftp.editPath">✎</button>
        <button class="sftp-refresh" data-i18n-title="sftp.refresh">⟳</button>
        <button class="sftp-mkdir" data-i18n-title="sftp.newFolder" data-i18n="sftp.newFolderBtn">＋Folder</button>
        <button class="sftp-paste hidden" type="button"></button>
        <label class="sftp-conc" data-i18n-title="sftp.concurrencyTitle"><span data-i18n="sftp.concurrency">Parallel</span><input type="number" class="sftp-conc-input" min="1" max="${SFTP_MAX_CONCURRENCY}" step="1" /></label>
        <label class="sftp-upload-btn sftp-upload-files-btn"><span data-i18n="sftp.upload">⬆ Upload</span><input type="file" class="sftp-upload-input" multiple hidden /></label>
        <label class="sftp-upload-btn sftp-upload-folder-btn" data-i18n-title="sftp.uploadFolderTitle"><span data-i18n="sftp.uploadFolder">⬆ Folder</span><input type="file" class="sftp-upload-folder-input" webkitdirectory multiple hidden /></label>
      </div>
      <div class="sftp-batch hidden">
        <span class="sftp-batch-count"></span>
        <button type="button" data-batch="copy" data-i18n="sftp.batchCopy">Copy</button>
        <button type="button" data-batch="move" data-i18n="sftp.batchCut">Cut</button>
        <button type="button" data-batch="download" data-i18n="sftp.batchDownload">Download</button>
        <button type="button" data-batch="remove" class="danger" data-i18n="sftp.batchDelete">Delete</button>
        <button type="button" data-batch="clear" data-i18n="sftp.batchClear">Clear</button>
      </div>
      <div class="sftp-status"></div>
      <div class="sftp-transfer hidden">
        <div class="xfer-head">
          <span class="xfer-title"></span>
          <button type="button" class="xfer-cancel" data-i18n-title="sftp.cancelUploadTitle" data-i18n="sftp.cancelUploadBtn">✕ Cancel</button>
        </div>
        <div class="xfer-bar"><div class="xfer-bar-fill"></div></div>
        <div class="xfer-detail"></div>
      </div>
      <div class="sftp-list"></div>
    `;
    I18n.apply(pane);
    terminalsEl.appendChild(pane);

    const tab = { id: tabId, sessionId: sess.id, name: sess.name, kind: 'sftp', pane, cwd: '.', status: 'connected', entries: [], sort: loadSftpSort(), selected: new Set() };
    state.openTabs.push(tab);
    renderTabBar();
    showTab(tabId);
    saveWorkspace();

    const pathBox = pane.querySelector('.sftp-path');
    const crumbsEl = pane.querySelector('.sftp-crumbs');
    const pathInput = pane.querySelector('.sftp-path-input');
    const listEl = pane.querySelector('.sftp-list');
    const statusEl = pane.querySelector('.sftp-status');
    const uploadInput = pane.querySelector('.sftp-upload-input');
    const folderInput = pane.querySelector('.sftp-upload-folder-input');
    const uploadLabels = pane.querySelectorAll('.sftp-upload-btn');
    const concInput = pane.querySelector('.sftp-conc-input');
    const xferEl = pane.querySelector('.sftp-transfer');
    const xferTitle = pane.querySelector('.xfer-title');
    const xferFill = pane.querySelector('.xfer-bar-fill');
    const xferDetail = pane.querySelector('.xfer-detail');
    const xferCancel = pane.querySelector('.xfer-cancel');
    const batchBar = pane.querySelector('.sftp-batch');
    const batchCount = pane.querySelector('.sftp-batch-count');
    const pasteBtn = pane.querySelector('.sftp-paste');

    function setStatus(msg, isError) {
      statusEl.textContent = msg || '';
      statusEl.classList.toggle('error', !!isError);
    }

    // ---- path bar: clickable segments + type-a-path mode ----
    function renderCrumbs(p) {
      crumbsEl.innerHTML = '';
      const abs = p.startsWith('/');
      const segs = p.split('/').filter(Boolean);
      const mk = (label, target) => {
        const b = document.createElement('span');
        b.className = 'crumb';
        b.textContent = label;
        b.title = target;
        b.onclick = (e) => { e.stopPropagation(); load(target); };
        return b;
      };
      if (abs) crumbsEl.appendChild(mk('/', '/'));
      segs.forEach((seg, i) => {
        if (i > 0) {
          const sep = document.createElement('span');
          sep.className = 'crumb-sep';
          sep.textContent = '/';
          crumbsEl.appendChild(sep);
        }
        const target = (abs ? '/' : '') + segs.slice(0, i + 1).join('/');
        crumbsEl.appendChild(mk(seg, target));
      });
      if (!abs && segs.length === 0) crumbsEl.appendChild(mk(p || '.', p || '.'));
    }

    function startPathEdit() {
      if (!pathInput.classList.contains('hidden')) return;
      pathInput.value = tab.cwd;
      crumbsEl.classList.add('hidden');
      pathInput.classList.remove('hidden');
      pathInput.focus();
      pathInput.select();
    }
    function endPathEdit() {
      pathInput.classList.add('hidden');
      crumbsEl.classList.remove('hidden');
    }
    function resolveTypedPath(v) {
      v = v.trim();
      if (!v) return null;
      if (v === '~') return '.';
      if (v.startsWith('~/')) return './' + v.slice(2);
      if (v.startsWith('/')) return v;
      return tab.cwd.replace(/\/+$/, '') + '/' + v; // relative to the folder being viewed
    }
    pathBox.addEventListener('click', (e) => {
      if (e.target === pathBox || e.target === crumbsEl) startPathEdit();
    });
    pane.querySelector('.sftp-edit-path').onclick = startPathEdit;
    pathInput.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        const target = resolveTypedPath(pathInput.value);
        endPathEdit();
        if (target) load(target);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        endPathEdit();
      }
    });
    pathInput.addEventListener('blur', endPathEdit);

    async function load(dir) {
      setStatus(t('sftp.loading'));
      try {
        const res = await api(`/api/sftp/${sess.id}/list?path=${encodeURIComponent(dir)}`);
        tab.cwd = res.path || dir;
        renderCrumbs(tab.cwd);
        tab.entries = res.entries || [];
        // Keep only selections that still exist (reload after an operation),
        // and drop them all when we moved to another folder.
        const here = new Set(tab.entries.map((e) => e.path));
        for (const p of Array.from(tab.selected)) if (!here.has(p)) tab.selected.delete(p);
        tab.lastClicked = undefined;
        renderEntries();
        setStatus('');
        setTabStatus(tab, 'connected');
      } catch (err) {
        setStatus(err.message, true);
        setTabStatus(tab, 'error');
      }
    }
    tab.reload = () => load(tab.cwd);
    tab.refreshLang = () => renderEntries();

    // ---- listing with sortable columns ----
    function sortedEntries() {
      const { key, dir } = tab.sort;
      const m = dir === 'desc' ? -1 : 1;
      return tab.entries.slice().sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1; // folders always stay on top
        let c = 0;
        if (key === 'size') c = (a.isDir ? 0 : a.size) - (b.isDir ? 0 : b.size);
        else if (key === 'mtime') c = new Date(a.modTime) - new Date(b.modTime);
        else if (key === 'mode') c = String(a.mode).localeCompare(String(b.mode));
        else c = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
        if (c !== 0) return c * m;
        return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
      });
    }

    function setSort(key) {
      if (tab.sort.key === key) tab.sort.dir = tab.sort.dir === 'asc' ? 'desc' : 'asc';
      else tab.sort = { key, dir: key === 'mtime' ? 'desc' : 'asc' }; // newest first is the useful default for dates
      try { localStorage.setItem(SFTP_SORT_KEY, JSON.stringify(tab.sort)); } catch (_) {}
      renderEntries();
    }

    function buildHead() {
      const head = document.createElement('div');
      head.className = 'sftp-head';
      const all = document.createElement('input');
      all.type = 'checkbox';
      all.className = 'sftp-check';
      all.title = t('sftp.selectAll');
      const total = tab.entries.length;
      all.checked = total > 0 && tab.selected.size === total;
      all.indeterminate = tab.selected.size > 0 && tab.selected.size < total;
      all.disabled = total === 0;
      all.onchange = () => {
        tab.selected.clear();
        if (all.checked) tab.entries.forEach((e) => tab.selected.add(e.path));
        renderEntries();
      };
      head.appendChild(all);
      const cols = [['name', 'sftp-name', 'sftp.col.name'], ['mtime', 'sftp-mtime', 'sftp.col.mtime'], ['mode', 'sftp-mode', 'sftp.col.mode'], ['size', 'sftp-size', 'sftp.col.size']];
      for (const [key, cls, i18nKey] of cols) {
        const c = document.createElement('span');
        c.className = `sftp-col ${cls}` + (tab.sort.key === key ? ' sorted' : '');
        const arrow = tab.sort.key === key ? (tab.sort.dir === 'asc' ? ' ▲' : ' ▼') : '';
        c.textContent = t(i18nKey) + arrow;
        c.onclick = () => setSort(key);
        head.appendChild(c);
      }
      const sp = document.createElement('span');
      sp.className = 'sftp-actions-spacer';
      head.appendChild(sp);
      return head;
    }

    function renderEntries() {
      const scrollTop = listEl.scrollTop;
      listEl.innerHTML = '';
      listEl.appendChild(buildHead());
      const sorted = sortedEntries();
      const images = sorted.filter((e) => !e.isDir && IMAGE_EXT.test(e.name));
      sorted.forEach((entry, idx) => {
        const row = document.createElement('div');
        row.className = 'sftp-row' + (tab.selected.has(entry.path) ? ' selected' : '');
        const isImage = !entry.isDir && IMAGE_EXT.test(entry.name);
        const icon = entry.isDir ? '📁' : isImage ? '🖼' : '📄';
        const sizeStr = entry.isDir ? '' : formatBytes(entry.size);
        const linkMark = entry.isLink ? ' <span class="sftp-link">↪</span>' : '';
        row.innerHTML = `
          <input type="checkbox" class="sftp-check" ${tab.selected.has(entry.path) ? 'checked' : ''} />
          <span class="sftp-name" title="${escapeHtml(entry.name)}">${icon} ${escapeHtml(entry.name)}${linkMark}</span>
          <span class="sftp-mtime">${escapeHtml(fmtDateTime(entry.modTime))}</span>
          <span class="sftp-mode">${escapeHtml(entry.mode || '')}</span>
          <span class="sftp-size">${sizeStr}</span>
          <span class="sftp-actions">
            ${isImage ? `<button data-act="pv" title="${escapeHtml(t('sftp.preview'))}">👁</button>` : ''}
            ${entry.isDir ? '' : `<button data-act="dl" title="${escapeHtml(t('sftp.download'))}">⬇</button>`}
            <button data-act="rn" title="${escapeHtml(t('common.rename'))}">✎</button>
            <button data-act="rm" title="${escapeHtml(t('common.delete'))}">🗑</button>
          </span>`;
        // Checkbox: click toggles; shift-click selects the range back to the
        // last clicked row (in the currently sorted order).
        const chk = row.querySelector('.sftp-check');
        chk.onclick = (e) => {
          e.stopPropagation();
          if (e.shiftKey && tab.lastClicked !== undefined && sorted[tab.lastClicked]) {
            const [a, b] = [Math.min(tab.lastClicked, idx), Math.max(tab.lastClicked, idx)];
            for (let i = a; i <= b; i++) {
              if (chk.checked) tab.selected.add(sorted[i].path); else tab.selected.delete(sorted[i].path);
            }
          } else if (chk.checked) tab.selected.add(entry.path);
          else tab.selected.delete(entry.path);
          tab.lastClicked = idx;
          renderEntries();
        };
        const preview = () => openImagePreview(sess.id, images, images.indexOf(entry));
        row.querySelector('.sftp-name').onclick = () => {
          if (entry.isDir) load(entry.path);
          else if (isImage) preview();
        };
        const pvBtn = row.querySelector('[data-act="pv"]');
        if (pvBtn) pvBtn.onclick = (e) => { e.stopPropagation(); preview(); };
        const dlBtn = row.querySelector('[data-act="dl"]');
        if (dlBtn) dlBtn.onclick = (e) => {
          e.stopPropagation();
          window.location.href = `/api/sftp/${sess.id}/download?path=${encodeURIComponent(entry.path)}`;
        };
        row.querySelector('[data-act="rn"]').onclick = async (e) => {
          e.stopPropagation();
          const name = prompt(t('sftp.newName'), entry.name);
          if (!name || name === entry.name) return;
          const newPath = tab.cwd.replace(/\/$/, '') + '/' + name;
          try {
            await api(`/api/sftp/${sess.id}/rename`, { method: 'POST', body: JSON.stringify({ oldPath: entry.path, newPath }) });
            load(tab.cwd);
          } catch (err) { setStatus(err.message, true); }
        };
        row.querySelector('[data-act="rm"]').onclick = async (e) => {
          e.stopPropagation();
          if (!confirm(t(entry.isDir ? 'sftp.confirmDeleteDir' : 'sftp.confirmDelete', { name: entry.name }))) return;
          try {
            await api(`/api/sftp/${sess.id}/remove?path=${encodeURIComponent(entry.path)}`, { method: 'DELETE' });
            load(tab.cwd);
          } catch (err) { setStatus(err.message, true); }
        };
        listEl.appendChild(row);
      });
      listEl.scrollTop = scrollTop;
      renderBatchBar();
    }

    // ---- batch operations: copy / cut + paste, delete, download ----
    function selectedEntries() {
      return tab.entries.filter((e) => tab.selected.has(e.path));
    }

    function renderBatchBar() {
      const n = tab.selected.size;
      batchBar.classList.toggle('hidden', n === 0);
      batchCount.textContent = t('sftp.selectedN', { count: n });
      const clip = sftpClipboard[sess.id];
      pasteBtn.classList.toggle('hidden', !clip);
      if (clip) {
        pasteBtn.textContent = t(clip.op === 'move' ? 'sftp.pasteMove' : 'sftp.pasteCopy', { count: clip.paths.length });
        pasteBtn.title = t('sftp.pasteHint');
      }
    }

    // Shows the outcome of a batch call: a one-line summary plus up to 8
    // failed paths with the reason, same shape as the upload report.
    function reportBatch(res, doneKey) {
      const failures = res.failures || [];
      if (!failures.length) { setStatus(t(doneKey, { count: res.done })); return; }
      const MAX_LISTED = 8;
      const lines = [t('sftp.batchPartial', { done: res.done, total: res.total, failed: failures.length })];
      failures.slice(0, MAX_LISTED).forEach((f) => lines.push(`${f.path} — ${I18n.err(f.error)}`));
      if (failures.length > MAX_LISTED) lines.push(t('sftp.uploadMoreFailed', { count: failures.length - MAX_LISTED }));
      setStatus(lines.join('\n'), true);
    }

    async function runBatch(op, paths, dest) {
      return api(`/api/sftp/${sess.id}/batch`, { method: 'POST', body: JSON.stringify({ op, paths, dest }) });
    }

    // Streams a zip of the selection to disk. A hidden form POST (into a
    // hidden iframe, so an error page can't replace the app) avoids holding
    // the archive in browser memory and avoids URL length limits.
    function downloadZip(paths, zipName) {
      let frame = document.getElementById('sftp-dl-frame');
      if (!frame) {
        frame = document.createElement('iframe');
        frame.id = 'sftp-dl-frame';
        frame.name = 'sftp-dl-frame';
        frame.style.display = 'none';
        document.body.appendChild(frame);
      }
      const form = document.createElement('form');
      form.method = 'POST';
      form.action = `/api/sftp/${sess.id}/archive`;
      form.target = 'sftp-dl-frame';
      form.style.display = 'none';
      for (const [k, v] of [['paths', JSON.stringify(paths)], ['name', zipName]]) {
        const inp = document.createElement('input');
        inp.type = 'hidden';
        inp.name = k;
        inp.value = v;
        form.appendChild(inp);
      }
      document.body.appendChild(form);
      form.submit();
      form.remove();
    }

    batchBar.addEventListener('click', async (e) => {
      const btn = e.target.closest('button[data-batch]');
      if (!btn) return;
      const act = btn.dataset.batch;
      const items = selectedEntries();
      if (act === 'clear') { tab.selected.clear(); renderEntries(); return; }
      if (!items.length) return;
      const paths = items.map((x) => x.path);

      if (act === 'copy' || act === 'move') {
        sftpClipboard[sess.id] = { op: act, paths };
        setStatus(t(act === 'move' ? 'sftp.clipMove' : 'sftp.clipCopy', { count: paths.length }));
        tab.selected.clear();
        // other SFTP tabs of this session need to show the paste button too
        state.openTabs.forEach((x) => { if (x.kind === 'sftp' && x.sessionId === sess.id && x.refreshLang) x.refreshLang(); });
        return;
      }

      if (act === 'download') {
        if (items.length === 1 && !items[0].isDir) {
          window.location.href = `/api/sftp/${sess.id}/download?path=${encodeURIComponent(items[0].path)}`;
          return;
        }
        const base = items.length === 1 ? items[0].name : (tab.cwd.replace(/\/+$/, '').split('/').pop() || 'download');
        downloadZip(paths, base + '.zip');
        setStatus(t('sftp.zipStarted', { count: paths.length }));
        return;
      }

      if (act === 'remove') {
        const msg = items.length === 1
          ? t(items[0].isDir ? 'sftp.confirmDeleteDir' : 'sftp.confirmDelete', { name: items[0].name })
          : t('sftp.confirmDeleteN', { count: items.length, dirs: items.filter((x) => x.isDir).length });
        if (!confirm(msg)) return;
        setStatus(t('sftp.working'));
        try {
          const res = await runBatch('remove', paths);
          tab.selected.clear();
          await load(tab.cwd);
          reportBatch(res, 'sftp.deletedN');
        } catch (err) { setStatus(err.message, true); }
      }
    });

    pasteBtn.onclick = async () => {
      const clip = sftpClipboard[sess.id];
      if (!clip) return;
      setStatus(t('sftp.working'));
      try {
        const res = await runBatch(clip.op, clip.paths, tab.cwd);
        // A cut is one-shot: what moved is gone from its old place. Anything
        // that failed stays on the clipboard so it can be retried elsewhere.
        if (clip.op === 'move') {
          const failed = new Set((res.failures || []).map((f) => f.path));
          clip.paths = clip.paths.filter((x) => failed.has(x));
          if (!clip.paths.length) delete sftpClipboard[sess.id];
        }
        await load(tab.cwd);
        reportBatch(res, clip.op === 'move' ? 'sftp.movedN' : 'sftp.copiedN');
        state.openTabs.forEach((x) => { if (x.kind === 'sftp' && x.sessionId === sess.id && x.refreshLang) x.refreshLang(); });
      } catch (err) { setStatus(err.message, true); }
    };

    pane.querySelector('.sftp-up').onclick = () => {
      const parent = tab.cwd.replace(/\/+$/, '').split('/').slice(0, -1).join('/') || '/';
      load(parent);
    };
    pane.querySelector('.sftp-refresh').onclick = () => load(tab.cwd);
    pane.querySelector('.sftp-mkdir').onclick = async () => {
      const name = prompt(t('sftp.newFolderName'));
      if (!name) return;
      try {
        await api(`/api/sftp/${sess.id}/mkdir`, { method: 'POST', body: JSON.stringify({ path: tab.cwd.replace(/\/$/, '') + '/' + name }) });
        load(tab.cwd);
      } catch (err) { setStatus(err.message, true); }
    };

    // ---- upload: files / folders / drag & drop, several in parallel ----
    // Items are {file, rel}; rel is the path below the target folder
    // ("a.txt" or "folder/sub/a.txt"). They are packed into tasks (one
    // XMLHttpRequest each — fetch() can't report upload progress) and a
    // pool of `concurrency` workers runs the tasks. Overall progress is the
    // sum of every task's bytes sent; speed is a smoothed rate over that
    // sum, sampled on a timer so it decays to 0 when the transfer stalls.
    concInput.value = String(loadConcurrency());
    concInput.addEventListener('change', () => {
      const n = clampConcurrency(concInput.value);
      concInput.value = String(n);
      try { localStorage.setItem(SFTP_CONC_KEY, String(n)); } catch (_) {}
    });

    let uploading = false;
    let cancelRequested = false;
    let hideTimer = null;
    const activeXhrs = new Set();

    function setUploadBusy(busy) {
      uploading = busy;
      uploadInput.disabled = busy;
      folderInput.disabled = busy;
      concInput.disabled = busy;
      uploadLabels.forEach((l) => l.classList.toggle('disabled', busy));
    }

    function buildTasks(items) {
      const tasks = [];
      let cur = null;
      const flush = () => { if (cur && cur.items.length) tasks.push(cur); cur = null; };
      for (const it of items) {
        if (it.file.size >= UPLOAD_SOLO_BYTES) {
          flush();
          tasks.push({ items: [it], bytes: it.file.size, loaded: 0 });
          continue;
        }
        if (cur && (cur.bytes + it.file.size > UPLOAD_BATCH_BYTES || cur.items.length >= UPLOAD_BATCH_FILES)) flush();
        if (!cur) cur = { items: [], bytes: 0, loaded: 0 };
        cur.items.push(it);
        cur.bytes += it.file.size;
      }
      flush();
      return tasks;
    }

    function postTask(task, dir, onProgress) {
      return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        activeXhrs.add(xhr);
        const settle = (fn, v) => { activeXhrs.delete(xhr); fn(v); };
        xhr.open('POST', `/api/sftp/${sess.id}/upload?path=${encodeURIComponent(dir)}`);
        xhr.withCredentials = true;
        // e.loaded also counts the multipart framing, hence the clamp.
        xhr.upload.onprogress = (e) => onProgress(Math.min(e.loaded, task.bytes));
        xhr.onload = () => {
          if (xhr.status === 401) { showLogin(); const e401 = new Error('unauthorized'); e401.fatal = true; settle(reject, e401); return; }
          if (xhr.status >= 200 && xhr.status < 300) { settle(resolve); return; }
          let msg = xhr.statusText || `HTTP ${xhr.status}`;
          try { msg = JSON.parse(xhr.responseText).error || msg; } catch (_) {}
          settle(reject, new Error(msg));
        };
        xhr.onerror = () => settle(reject, new Error(t('sftp.connectionLost')));
        xhr.onabort = () => { const err = new Error('cancelled'); err.cancelled = true; settle(reject, err); };
        const form = new FormData();
        // The relative path travels in its own "relpath" field right before
        // each file, NOT in the multipart filename: browsers may rewrite a
        // filename containing "/" (e.g. Chrome turns it into ":"), which
        // flattened dropped/selected folders on the server. The server
        // creates the parent folders and sanitizes the path.
        for (const it of task.items) {
          form.append('relpath', it.rel);
          form.append('file', it.file, it.file.name);
        }
        xhr.send(form);
      });
    }

    function fmtDuration(sec) {
      if (!Number.isFinite(sec) || sec < 0) return '--:--';
      sec = Math.round(sec);
      const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), r = sec % 60;
      const mm = String(m).padStart(2, '0'), ss = String(r).padStart(2, '0');
      return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
    }
    const fmtSpeed = (bps) => `${formatBytes(Math.round(bps))}/s`;

    async function runUpload(items, emptyDirs) {
      emptyDirs = emptyDirs || [];
      if (items.length === 0 && emptyDirs.length === 0) return;
      if (uploading) { setStatus(t('sftp.uploadBusy'), true); return; }

      const dir = tab.cwd; // pin the destination even if the user browses elsewhere meanwhile
      const concurrency = clampConcurrency(concInput.value);
      const tasks = buildTasks(items);
      const totalFiles = items.length;
      const totalBytes = items.reduce((sum, it) => sum + it.file.size, 0);
      let curBytes = 0;        // overall bytes sent so far
      let doneFiles = 0;
      let active = 0;
      let curName = items.length ? items[0].rel : '';
      let speed = 0;           // smoothed bytes/sec
      let lastTickT = performance.now(), lastTickB = 0;
      const startT = performance.now();
      const failures = [];     // {name, message} for files that could not be uploaded
      let fatal = false;       // e.g. logged out: no point trying the rest

      clearTimeout(hideTimer);
      cancelRequested = false;
      setUploadBusy(true);
      xferEl.classList.remove('hidden', 'error', 'done');
      xferCancel.classList.remove('hidden');
      setStatus('');

      function render() {
        const pct = totalBytes > 0 ? Math.min(100, (curBytes / totalBytes) * 100) : (totalFiles > 0 ? (doneFiles / totalFiles) * 100 : 0);
        xferFill.style.width = `${pct}%`;
        xferTitle.textContent = t('sftp.uploadingN', { done: doneFiles, total: totalFiles, active, name: curName });
        const parts = [`${pct.toFixed(1)}%`, `${formatBytes(curBytes)} / ${formatBytes(totalBytes)}`];
        if (totalBytes > 0 && curBytes >= totalBytes && doneFiles < totalFiles) {
          parts.push(t('sftp.finalizing'));
        } else {
          parts.push(fmtSpeed(speed));
          parts.push(t('sftp.eta', { time: speed > 0 ? fmtDuration((totalBytes - curBytes) / speed) : '--:--' }));
        }
        xferDetail.textContent = parts.join(' · ');
      }

      const ticker = setInterval(() => {
        const now = performance.now();
        const dt = (now - lastTickT) / 1000;
        const inst = Math.max(0, curBytes - lastTickB) / dt;
        speed = speed > 0 ? speed * 0.6 + inst * 0.4 : inst;
        lastTickT = now; lastTickB = curBytes;
        render();
      }, 500);
      render();

      const abortAll = () => { for (const x of Array.from(activeXhrs)) x.abort(); };
      xferCancel.onclick = () => { cancelRequested = true; abortAll(); };

      try {
        // Empty folders have no file to carry them, so create them directly.
        for (const rel of emptyDirs) {
          if (cancelRequested || fatal) break;
          try {
            await api(`/api/sftp/${sess.id}/mkdir`, { method: 'POST', body: JSON.stringify({ path: dir.replace(/\/$/, '') + '/' + rel }) });
          } catch (err) { failures.push({ name: rel + '/', message: err.message }); }
        }

        // Run one task. A failed multi-file request can't tell us which of
        // its files made it, so it is retried file by file: files that
        // succeed stay on the server and only the ones that really fail
        // end up in the failure report.
        const runTask = async (task) => {
          active++;
          curName = task.items[0].rel;
          try {
            await postTask(task, dir, (loaded) => {
              curBytes += loaded - task.loaded;
              task.loaded = loaded;
            });
            curBytes += task.bytes - task.loaded;
            task.loaded = task.bytes;
            doneFiles += task.items.length;
            return;
          } catch (err) {
            curBytes -= task.loaded; // this attempt's progress no longer counts
            task.loaded = 0;
            if (err.cancelled) return;
            if (err.fatal) { fatal = true; failures.push({ name: task.items[0].rel, message: err.message }); return; }
            if (task.items.length === 1) {
              failures.push({ name: task.items[0].rel, message: err.message });
              return;
            }
          } finally {
            active--;
          }
          for (const it of task.items) {
            if (cancelRequested || fatal) return;
            await runTask({ items: [it], bytes: it.file.size, loaded: 0 });
          }
        };

        let next = 0;
        const worker = async () => {
          while (!cancelRequested && !fatal) {
            const task = tasks[next++];
            if (!task) return;
            await runTask(task);
          }
        };
        if (!fatal) await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
        clearInterval(ticker);

        if (cancelRequested) {
          xferCancel.classList.add('hidden');
          xferTitle.textContent = t('sftp.uploadCancelled');
          xferDetail.textContent = t('sftp.uploadCancelledDetail', { done: doneFiles, total: totalFiles });
        } else if (failures.length) {
          // Everything that could be uploaded was; report only what failed.
          xferCancel.classList.add('hidden');
          xferEl.classList.add('error');
          xferTitle.textContent = t('sftp.uploadPartial', { done: doneFiles, total: totalFiles, failed: failures.length });
          const MAX_LISTED = 8;
          const lines = failures.slice(0, MAX_LISTED).map((f) => `${f.name}: ${f.message}`);
          if (failures.length > MAX_LISTED) lines.push(t('sftp.uploadMoreFailed', { count: failures.length - MAX_LISTED }));
          xferDetail.textContent = lines.join('\n');
        } else {
          const secs = (performance.now() - startT) / 1000;
          xferFill.style.width = '100%';
          xferEl.classList.add('done');
          xferCancel.classList.add('hidden');
          xferTitle.textContent = t('sftp.uploadComplete', { count: doneFiles });
          xferDetail.textContent = t('sftp.uploadSummary', { size: formatBytes(totalBytes), time: fmtDuration(secs), speed: fmtSpeed(secs > 0 ? totalBytes / secs : 0) });
          hideTimer = setTimeout(() => xferEl.classList.add('hidden'), 8000);
        }
      } finally {
        clearInterval(ticker);
        activeXhrs.clear();
        uploadInput.value = '';
        folderInput.value = '';
        setUploadBusy(false);
        load(tab.cwd);
      }
    }

    uploadInput.addEventListener('change', () => {
      // Copy out of the live FileList before the input is reset in finally{}.
      const files = Array.from(uploadInput.files || []);
      if (files.length) runUpload(files.map((f) => ({ file: f, rel: f.name })), []);
    });
    folderInput.addEventListener('change', () => {
      const files = Array.from(folderInput.files || []);
      if (files.length) runUpload(files.map((f) => ({ file: f, rel: f.webkitRelativePath || f.name })), []);
    });

    // ---- drag & drop (files and whole folders) ----
    async function collectDropped(entries) {
      const files = [];
      const emptyDirs = [];
      const readAll = (reader) => new Promise((resolve, reject) => {
        const all = [];
        (function more() {
          reader.readEntries((batch) => {
            if (!batch.length) resolve(all);
            else { all.push(...batch); more(); }
          }, reject);
        })();
      });
      async function walk(entry, prefix) {
        if (entry.isFile) {
          const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
          files.push({ file, rel: prefix + entry.name });
        } else if (entry.isDirectory) {
          const kids = await readAll(entry.createReader());
          const rel = prefix + entry.name;
          if (!kids.length) emptyDirs.push(rel);
          for (const k of kids) await walk(k, rel + '/');
        }
      }
      for (const e of entries) await walk(e, '');
      return { files, emptyDirs };
    }

    const hasFiles = (e) => !!(e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files'));
    let dragDepth = 0;
    pane.addEventListener('dragenter', (e) => {
      if (!hasFiles(e)) return; // tab reordering drags carry no files
      e.preventDefault();
      dragDepth++;
      pane.classList.add('drop-active');
      if (!uploading) setStatus(t('sftp.dropHint'));
    });
    pane.addEventListener('dragover', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });
    pane.addEventListener('dragleave', (e) => {
      if (!hasFiles(e)) return;
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) {
        pane.classList.remove('drop-active');
        if (!uploading) setStatus('');
      }
    });
    pane.addEventListener('drop', async (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth = 0;
      pane.classList.remove('drop-active');
      if (uploading) { setStatus(t('sftp.uploadBusy'), true); return; }
      const dt = e.dataTransfer;
      // webkitGetAsEntry must be called before the first await: the
      // DataTransfer is emptied once the event handler yields.
      const entries = [];
      for (const it of Array.from(dt.items || [])) {
        if (it.kind !== 'file') continue;
        const en = it.webkitGetAsEntry ? it.webkitGetAsEntry() : null;
        if (en) entries.push(en);
      }
      const plain = Array.from(dt.files || []);
      if (entries.length === 0) {
        setStatus('');
        runUpload(plain.map((f) => ({ file: f, rel: f.name })), []);
        return;
      }
      setStatus(t('sftp.scanning'));
      try {
        const res = await collectDropped(entries);
        setStatus('');
        runUpload(res.files, res.emptyDirs);
      } catch (err) {
        setStatus(err.message || String(err), true);
      }
    });

    load('.');
  }

  function formatBytes(n) {
    if (n < 1024) return `${n} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let i = -1;
    do { n /= 1024; i++; } while (n >= 1024 && i < units.length - 1);
    return `${n.toFixed(1)} ${units[i]}`;
  }

  // ---------------- language switching ----------------
  // Static markup is re-translated by I18n itself (data-i18n attributes,
  // including already-open SFTP panes). This refreshes everything that is
  // built from JS strings.
  I18n.onChange(() => {
    renderBuildVersion();
    applySidebarCollapsed(state.sidebarCollapsed);
    applyTheme(document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark');
    syncFullscreenButton();
    populateGroupSelect();
    renderTree();
    renderTunnels();
    renderTabBar();
    refreshTabStatusTexts();
    for (const tb of state.openTabs) if (tb.refreshLang) tb.refreshLang();
    if (state.layout !== 'single') {
      renderSplitSelects();
      applyPaneAssignments();
    }
  });

  // ---------------- init ----------------
  renderBuildVersion();
  applySidebarCollapsed(state.sidebarCollapsed); // sets the localized toggle title
  syncFullscreenButton();
  checkAuth();
})();