(() => {
  'use strict';

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
      throw new Error(msg);
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
  (async function showBuildVersion() {
    let version = 'unknown';
    try {
      const r = await fetch('/api/version', { credentials: 'include' });
      if (r.ok) version = (await r.json()).version || 'unknown';
    } catch (_) { /* offline / server not reachable yet — leave as unknown */ }
    console.log('[webssh] build version:', version);
    const text = `build ${version}`;
    const loginTag = document.getElementById('buildVersionTag');
    const appTag = document.getElementById('buildVersionTagApp');
    if (loginTag) loginTag.textContent = text;
    if (appTag) appTag.textContent = text;
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
      const tabs = state.openTabs.map((t) => ({ sessionId: t.sessionId, kind: t.kind, termId: t.termId || null }));
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
      if (created && t.sessionId === saved.activeSessionId && t.kind === saved.activeKind) {
        activeId = created.id;
      }
    }

    if (saved.layout && saved.layout !== 'single') {
      setLayout(saved.layout);
    } else if (activeId) {
      showTab(activeId);
    }
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
      errEl.textContent = 'Invalid username or password';
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
    sidebarToggleBtn.title = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
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
      pwError.textContent = 'New password must be at least 6 characters.';
      return;
    }
    if (newPassword !== confirmPassword) {
      pwError.textContent = 'New password and confirmation do not match.';
      return;
    }

    try {
      await api('/api/admin/password', {
        method: 'POST',
        body: JSON.stringify({ currentPassword, newUsername, newPassword }),
      });
    } catch (err) {
      pwError.textContent = err.message || 'Failed to change password';
      return;
    }

    // The server invalidated every session (including this one) so the
    // new credentials take effect immediately. Send everyone back to the
    // login screen.
    passwordDialog.close();
    alert('Password changed. Please sign in again with your new credentials.');
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
    btnThemeToggle.title = theme === 'light' ? 'Switch to dark theme' : 'Switch to light theme';
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
      actions.innerHTML = `<button data-act="rename">✎</button><button data-act="del">🗑</button>`;
      title.appendChild(actions);
      wrap.appendChild(title);

      actions.querySelector('[data-act="rename"]').onclick = (e) => { e.stopPropagation(); openGroupDialog(g); };
      actions.querySelector('[data-act="del"]').onclick = async (e) => {
        e.stopPropagation();
        if (confirm(`Delete group "${g.name}"? Sessions inside will become ungrouped.`)) {
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
      empty.textContent = 'No sessions match your search.';
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
    actions.innerHTML = `<button data-act="edit">✎</button><button data-act="files">📁</button><button data-act="del">🗑</button>`;
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
      if (confirm(`Delete session "${s.name}"?`)) {
        await api(`/api/sessions/${s.id}`, { method: 'DELETE' });
        closeTabForSession(s.id);
        await refreshAll();
      }
    };
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
    sel.innerHTML = '<option value="">(none)</option>';
    for (const g of state.groups) {
      const o = document.createElement('option'); o.value = g.id; o.textContent = g.name; sel.appendChild(o);
    }
  }

  // Empty/invalid -> default 30s; 0 (or negative) -> keepalive off.
  function parseKeepAlive(raw) {
    const n = parseInt(raw, 10);
    if (Number.isNaN(n)) return 30;
    return Math.min(Math.max(n, 0), 3600);
  }

  function openSessionDialog(sess) {
    document.getElementById('sessionDialogTitle').textContent = sess ? 'Edit Session' : 'New Session';
    document.getElementById('sessId').value = sess ? sess.id : '';
    document.getElementById('sessName').value = sess ? sess.name : '';
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
    else await api('/api/sessions', { method: 'POST', body: JSON.stringify(payload) });
    sessionDialog.close();
    await refreshAll();
  });

  // ---------------- group dialog ----------------
  const groupDialog = document.getElementById('groupDialog');
  document.getElementById('btnNewGroup').onclick = () => openGroupDialog(null);
  document.getElementById('groupCancel').onclick = () => groupDialog.close();

  function openGroupDialog(g) {
    document.getElementById('groupDialogTitle').textContent = g ? 'Rename Group' : 'New Group';
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

  function openTunnelDialog(t) {
    document.getElementById('tunnelId').value = t ? t.id : '';
    document.getElementById('tunnelName').value = t ? t.name : '';
    document.getElementById('tunnelSession').value = t ? t.sessionId : (state.sessions[0] && state.sessions[0].id) || '';
    document.getElementById('tunnelType').value = t ? t.type : 'local';
    document.getElementById('tunnelListenHost').value = t ? t.listenHost : '127.0.0.1';
    document.getElementById('tunnelListenPort').value = t ? t.listenPort : '';
    document.getElementById('tunnelTargetHost').value = t ? t.targetHost : '';
    document.getElementById('tunnelTargetPort').value = t ? t.targetPort : '';
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
      .filter((t) => matchesQuery([t.name, t.listenHost, t.targetHost], query))
      .slice()
      .sort((a, b) => naturalSort(a.name, b.name));

    if (query && filtered.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'search-empty';
      empty.textContent = 'No tunnels match your search.';
      tunnelListEl.appendChild(empty);
      return;
    }

    for (const t of filtered) {
      const row = document.createElement('div');
      row.className = 'tunnel-item';
      const badge = t.running ? '<span class="badge running">running</span>' : '<span class="badge">stopped</span>';
      const detail = t.type === 'dynamic'
        ? `SOCKS5 ${t.listenHost}:${t.listenPort}`
        : `${t.listenHost}:${t.listenPort} → ${t.targetHost}:${t.targetPort}`;
      row.innerHTML = `${badge}<span class="name item-main">
        <span class="item-title" title="${escapeHtml(t.name)}">${escapeHtml(t.name)}</span>
        <span class="session-sub" title="${escapeHtml(detail)}">${escapeHtml(detail)}</span>
      </span>`;
      const actions = document.createElement('span');
      actions.className = 'item-actions';
      actions.innerHTML = t.running
        ? `<button data-act="stop">⏹</button><button data-act="del">🗑</button>`
        : `<button data-act="start">▶</button><button data-act="edit">✎</button><button data-act="del">🗑</button>`;
      row.appendChild(actions);

      const startBtn = actions.querySelector('[data-act="start"]');
      if (startBtn) startBtn.onclick = async () => { await api(`/api/tunnels/${t.id}/start`, { method: 'POST' }); await refreshAll(); };
      const stopBtn = actions.querySelector('[data-act="stop"]');
      if (stopBtn) stopBtn.onclick = async () => { await api(`/api/tunnels/${t.id}/stop`, { method: 'POST' }); await refreshAll(); };
      const editBtn = actions.querySelector('[data-act="edit"]');
      if (editBtn) editBtn.onclick = () => openTunnelDialog(t);
      const delBtn = actions.querySelector('[data-act="del"]');
      if (delBtn) delBtn.onclick = async () => {
        if (confirm(`Delete tunnel "${t.name}"?`)) { await api(`/api/tunnels/${t.id}`, { method: 'DELETE' }); await refreshAll(); }
      };

      tunnelListEl.appendChild(row);
    }
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
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      theme: { background: '#1e1e1e' },
    });
    const fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);

    const pane = document.createElement('div');
    pane.className = 'term-pane';
    pane.id = tabId;
    terminalsEl.appendChild(pane);

    const tab = { id: tabId, sessionId: sess.id, termId, name: sess.name, kind: 'terminal', term, fitAddon, ws: null, pane };
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
    ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data);
        if (msg.type === 'data') tab.term.write(msg.data);
        else if (msg.type === 'error') tab.term.write(`\r\n\x1b[31m[error] ${msg.message}\x1b[0m\r\n`);
        else if (msg.type === 'closed') tab.term.write('\r\n\x1b[33m[connection closed]\x1b[0m\r\n');
      } catch (_) {}
    };
    ws.onclose = () => {
      tab.term.write('\r\n\x1b[33m[disconnected]\x1b[0m\r\n');
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
    for (const t of state.openTabs) {
      const el = document.createElement('div');
      const paneIdx = state.paneTabs.indexOf(t.id);
      const isActive = isSplit ? paneIdx !== -1 : t.id === state.activeTab;
      el.className = 'tab' + (isActive ? ' active' : '');
      const icon = t.kind === 'sftp' ? '📁' : '🖥';
      const badge = isSplit && paneIdx !== -1
        ? `<span class="split-badge">${PANE_BADGES[paneIdx] || paneIdx}</span>`
        : '';
      el.title = t.name;
      el.innerHTML = `<span class="tab-label">${icon} ${escapeHtml(t.name)}</span>${badge}<span class="close">✕</span>`;
      el.onclick = () => showTab(t.id);
      el.querySelector('.close').onclick = (e) => { e.stopPropagation(); closeTab(t.id); };
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
    btnFullscreen.title = active ? 'Exit full screen' : 'Full screen';
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
      const options = ['<option value="">(empty)</option>'].concat(
        state.openTabs
          .filter((t) => !assignedElsewhere.has(t.id))
          .map((t) => {
            const icon = t.kind === 'sftp' ? '📁' : '🖥';
            const sel = t.id === state.paneTabs[i] ? ' selected' : '';
            return `<option value="${t.id}"${sel}>${icon} ${escapeHtml(t.name)}</option>`;
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
        empty.textContent = 'Choose a session above';
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
  function openSftpTab(sess) {
    const tabId = `sftp-${sess.id}-${Date.now()}`;
    const pane = document.createElement('div');
    pane.className = 'term-pane sftp-pane';
    pane.id = tabId;
    pane.innerHTML = `
      <div class="sftp-toolbar">
        <button class="sftp-up" title="Up one level">⬆</button>
        <span class="sftp-path"></span>
        <span class="sftp-spacer"></span>
        <button class="sftp-refresh" title="Refresh">⟳</button>
        <button class="sftp-mkdir" title="New folder">＋Folder</button>
        <label class="sftp-upload-btn">⬆ Upload<input type="file" class="sftp-upload-input" multiple hidden /></label>
      </div>
      <div class="sftp-status"></div>
      <div class="sftp-transfer hidden">
        <div class="xfer-head">
          <span class="xfer-title"></span>
          <button type="button" class="xfer-cancel" title="Cancel upload">✕ Cancel</button>
        </div>
        <div class="xfer-bar"><div class="xfer-bar-fill"></div></div>
        <div class="xfer-detail"></div>
      </div>
      <div class="sftp-list"></div>
    `;
    terminalsEl.appendChild(pane);

    const tab = { id: tabId, sessionId: sess.id, name: sess.name, kind: 'sftp', pane, cwd: '.' };
    state.openTabs.push(tab);
    renderTabBar();
    showTab(tabId);
    saveWorkspace();

    const pathEl = pane.querySelector('.sftp-path');
    const listEl = pane.querySelector('.sftp-list');
    const statusEl = pane.querySelector('.sftp-status');
    const uploadInput = pane.querySelector('.sftp-upload-input');
    const uploadLabel = pane.querySelector('.sftp-upload-btn');
    const xferEl = pane.querySelector('.sftp-transfer');
    const xferTitle = pane.querySelector('.xfer-title');
    const xferFill = pane.querySelector('.xfer-bar-fill');
    const xferDetail = pane.querySelector('.xfer-detail');
    const xferCancel = pane.querySelector('.xfer-cancel');

    function setStatus(msg, isError) {
      statusEl.textContent = msg || '';
      statusEl.classList.toggle('error', !!isError);
    }

    async function load(dir) {
      setStatus('Loading…');
      try {
        const res = await api(`/api/sftp/${sess.id}/list?path=${encodeURIComponent(dir)}`);
        tab.cwd = res.path || dir;
        pathEl.textContent = tab.cwd;
        renderEntries(res.entries || []);
        setStatus('');
      } catch (err) {
        setStatus(err.message, true);
        listEl.innerHTML = '';
      }
    }

    function renderEntries(entries) {
      listEl.innerHTML = '';
      entries
        .slice()
        .sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1))
        .forEach((entry) => {
          const row = document.createElement('div');
          row.className = 'sftp-row';
          const icon = entry.isDir ? '📁' : '📄';
          const sizeStr = entry.isDir ? '' : formatBytes(entry.size);
          row.innerHTML = `
            <span class="sftp-name">${icon} ${escapeHtml(entry.name)}</span>
            <span class="sftp-size">${sizeStr}</span>
            <span class="sftp-actions">
              ${entry.isDir ? '' : '<button data-act="dl" title="Download">⬇</button>'}
              <button data-act="rn" title="Rename">✎</button>
              <button data-act="rm" title="Delete">🗑</button>
            </span>`;
          row.querySelector('.sftp-name').onclick = () => {
            if (entry.isDir) load(entry.path);
          };
          const dlBtn = row.querySelector('[data-act="dl"]');
          if (dlBtn) dlBtn.onclick = (e) => {
            e.stopPropagation();
            window.location.href = `/api/sftp/${sess.id}/download?path=${encodeURIComponent(entry.path)}`;
          };
          row.querySelector('[data-act="rn"]').onclick = async (e) => {
            e.stopPropagation();
            const name = prompt('New name:', entry.name);
            if (!name || name === entry.name) return;
            const newPath = tab.cwd.replace(/\/$/, '') + '/' + name;
            try {
              await api(`/api/sftp/${sess.id}/rename`, { method: 'POST', body: JSON.stringify({ oldPath: entry.path, newPath }) });
              load(tab.cwd);
            } catch (err) { setStatus(err.message, true); }
          };
          row.querySelector('[data-act="rm"]').onclick = async (e) => {
            e.stopPropagation();
            if (!confirm(`Delete "${entry.name}"?${entry.isDir ? ' (and everything inside it)' : ''}`)) return;
            try {
              await api(`/api/sftp/${sess.id}/remove?path=${encodeURIComponent(entry.path)}`, { method: 'DELETE' });
              load(tab.cwd);
            } catch (err) { setStatus(err.message, true); }
          };
          listEl.appendChild(row);
        });
    }

    pane.querySelector('.sftp-up').onclick = () => {
      const parent = tab.cwd.replace(/\/+$/, '').split('/').slice(0, -1).join('/') || '/';
      load(parent);
    };
    pane.querySelector('.sftp-refresh').onclick = () => load(tab.cwd);
    pane.querySelector('.sftp-mkdir').onclick = async () => {
      const name = prompt('New folder name:');
      if (!name) return;
      try {
        await api(`/api/sftp/${sess.id}/mkdir`, { method: 'POST', body: JSON.stringify({ path: tab.cwd.replace(/\/$/, '') + '/' + name }) });
        load(tab.cwd);
      } catch (err) { setStatus(err.message, true); }
    };
    // ---- upload with progress / speed / ETA ----
    // One XMLHttpRequest per file (fetch() can't report upload progress),
    // run one after another. Overall progress = bytes of finished files +
    // bytes sent of the current one; speed is a smoothed rate over that
    // overall figure, so it stays continuous across file boundaries.
    let currentXhr = null;
    let cancelRequested = false;
    let hideTimer = null;

    function uploadOne(file, dir, onProgress, onSent) {
      return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        currentXhr = xhr;
        xhr.open('POST', `/api/sftp/${sess.id}/upload?path=${encodeURIComponent(dir)}`);
        xhr.withCredentials = true;
        xhr.upload.onprogress = (e) => {
          // e.loaded also counts the few hundred bytes of multipart framing.
          onProgress(Math.min(e.loaded, file.size));
        };
        // Fires when the browser has sent the whole body; the server may
        // still be flushing the tail to the remote host.
        xhr.upload.onload = () => onSent();
        xhr.onload = () => {
          if (xhr.status === 401) { showLogin(); reject(new Error('unauthorized')); return; }
          if (xhr.status >= 200 && xhr.status < 300) { resolve(); return; }
          let msg = xhr.statusText || `HTTP ${xhr.status}`;
          try { msg = JSON.parse(xhr.responseText).error || msg; } catch (_) {}
          reject(new Error(msg));
        };
        xhr.onerror = () => reject(new Error('connection lost during upload (the server may have rejected the request — check the target folder permissions)'));
        xhr.onabort = () => { const err = new Error('cancelled'); err.cancelled = true; reject(err); };
        const form = new FormData();
        form.append('file', file, file.name);
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

    async function uploadFiles(fileList) {
      const files = Array.from(fileList);
      const dir = tab.cwd; // pin the destination even if the user browses elsewhere meanwhile
      const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
      let doneBytes = 0;      // bytes of fully uploaded files
      let curBytes = 0;       // overall bytes sent so far
      let index = 0;          // 1-based index of the file in flight
      let curName = '';
      let sentAll = false;    // current file fully sent, waiting on the server
      let speed = 0;          // smoothed bytes/sec
      let lastTickT = performance.now(), lastTickB = 0;
      const startT = performance.now();
      let completed = 0;

      clearTimeout(hideTimer);
      cancelRequested = false;
      uploadInput.disabled = true;
      uploadLabel.classList.add('disabled');
      xferEl.classList.remove('hidden', 'error', 'done');
      xferCancel.classList.remove('hidden');
      setStatus('');

      function render() {
        const pct = totalBytes > 0 ? Math.min(100, (curBytes / totalBytes) * 100) : 0;
        xferFill.style.width = `${pct}%`;
        xferTitle.textContent = `Uploading ${index}/${files.length}: ${curName}`;
        const parts = [`${pct.toFixed(1)}%`, `${formatBytes(curBytes)} / ${formatBytes(totalBytes)}`];
        if (sentAll && index === files.length && curBytes >= totalBytes) {
          parts.push('finalizing on remote…');
        } else {
          parts.push(fmtSpeed(speed));
          parts.push(`ETA ${speed > 0 ? fmtDuration((totalBytes - curBytes) / speed) : '--:--'}`);
        }
        xferDetail.textContent = parts.join(' · ');
      }

      // Speed is sampled on a timer, not per progress event: events stop
      // entirely when the transfer stalls, and the readout must decay to 0
      // instead of freezing on the last good number.
      const ticker = setInterval(() => {
        const now = performance.now();
        const dt = (now - lastTickT) / 1000;
        const inst = Math.max(0, curBytes - lastTickB) / dt;
        speed = speed > 0 ? speed * 0.6 + inst * 0.4 : inst;
        lastTickT = now; lastTickB = curBytes;
        render();
      }, 500);

      try {
        for (const file of files) {
          if (cancelRequested) { const e = new Error('cancelled'); e.cancelled = true; throw e; }
          index++;
          curName = file.name;
          sentAll = false;
          render();
          await uploadOne(
            file, dir,
            (loaded) => { curBytes = doneBytes + loaded; render(); },
            () => { sentAll = true; render(); },
          );
          doneBytes += file.size;
          curBytes = doneBytes;
          completed++;
        }
        clearInterval(ticker);
        const secs = (performance.now() - startT) / 1000;
        xferFill.style.width = '100%';
        xferEl.classList.add('done');
        xferCancel.classList.add('hidden');
        xferTitle.textContent = `Upload complete: ${completed} file(s)`;
        xferDetail.textContent = `${formatBytes(totalBytes)} in ${fmtDuration(secs)} · avg ${fmtSpeed(secs > 0 ? totalBytes / secs : 0)}`;
        hideTimer = setTimeout(() => xferEl.classList.add('hidden'), 8000);
      } catch (err) {
        clearInterval(ticker);
        xferCancel.classList.add('hidden');
        if (err.cancelled) {
          xferTitle.textContent = 'Upload cancelled';
          xferDetail.textContent = `${completed} of ${files.length} file(s) uploaded before cancelling; "${curName}" was not kept.`;
        } else {
          xferEl.classList.add('error');
          xferTitle.textContent = `Upload failed: ${curName}`;
          xferDetail.textContent = `${err.message}${completed ? ` (${completed} earlier file(s) uploaded)` : ''}`;
        }
      } finally {
        currentXhr = null;
        uploadInput.value = '';
        uploadInput.disabled = false;
        uploadLabel.classList.remove('disabled');
        load(tab.cwd);
      }
    }

    xferCancel.onclick = () => {
      cancelRequested = true;
      if (currentXhr) currentXhr.abort();
    };

    uploadInput.addEventListener('change', () => {
      const fileList = uploadInput.files;
      if (!fileList || fileList.length === 0) return;
      // Copy out of the live FileList before the input is reset in finally{}.
      uploadFiles(Array.from(fileList));
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

  // ---------------- init ----------------
  checkAuth();
})();