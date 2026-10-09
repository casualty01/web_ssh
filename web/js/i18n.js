/*
 * Minimal i18n for WebSSH (no dependencies).
 *
 * - Supported languages live in LANGS below. To add one, add an entry with a
 *   `name` (shown in the language picker) and a `messages` table.
 * - First visit: the language is detected from the browser (navigator.languages)
 *   and saved to localStorage ('webssh-lang'). After that the saved value wins;
 *   the user can change it with the language picker, which saves it again.
 * - Static markup is translated via data attributes:
 *     data-i18n="key"              -> textContent
 *     data-i18n-html="key"         -> innerHTML (trusted dictionary strings only)
 *     data-i18n-title="key"        -> title attribute
 *     data-i18n-placeholder="key"  -> placeholder attribute
 * - Dynamic strings: I18n.t('key', { name: 'x' }) replaces {name} placeholders.
 * - Listeners: I18n.onChange(fn) runs after every language change.
 */
(function () {
  'use strict';

  const STORAGE_KEY = 'webssh-lang';
  const DEFAULT_LANG = 'en';

  const en = {
    'app.title': 'WebSSH',
    'common.cancel': 'Cancel',
    'common.save': 'Save',
    'common.none': '(none)',
    'common.empty': '(empty)',
    'common.edit': 'Edit',
    'common.delete': 'Delete',
    'common.rename': 'Rename',
    'common.start': 'Start',
    'common.stop': 'Stop',
    'common.language': 'Language',

    // login
    'login.username': 'Username',
    'login.password': 'Password',
    'login.submit': 'Sign in',
    'login.error': 'Invalid username or password',
    'build.version': 'build {version}',

    // sidebar
    'sidebar.collapse': 'Collapse sidebar',
    'sidebar.expand': 'Expand sidebar',
    'sidebar.resize': 'Drag to resize',
    'search.placeholder': 'Search sessions & tunnels…',
    'search.clear': 'Clear search',
    'search.noSessions': 'No sessions match your search.',
    'search.noTunnels': 'No tunnels match your search.',
    'sessions.title': 'Sessions',
    'group.newTitle': 'New group',
    'group.newBtn': '＋Group',
    'session.newTitle': 'New session',
    'session.newBtn': '＋Session',
    'tunnels.title': 'Tunnels',
    'tunnel.newTitle': 'New tunnel',
    'tunnel.newBtn': '＋Tunnel',
    'footer.signOut': 'Sign out',
    'footer.changePassword': 'Change admin password',
    'theme.toLight': 'Switch to light theme',
    'theme.toDark': 'Switch to dark theme',
    'item.files': 'Files (SFTP)',

    // main area
    'layout.single': 'Single pane',
    'layout.horizontal': 'Left / Right split',
    'layout.vertical': 'Top / Bottom split',
    'layout.grid': '4-pane grid',
    'fullscreen.enter': 'Full screen',
    'fullscreen.exit': 'Exit full screen',
    'empty.state': 'Select a session on the left, or click <b>＋Session</b> to add one.',
    'split.choose': 'Choose a session above',

    // session dialog
    'session.dialog.new': 'New Session',
    'session.dialog.edit': 'Edit Session',
    'field.name': 'Name',
    'field.group': 'Group',
    'field.host': 'Host',
    'field.port': 'Port',
    'field.username': 'Username',
    'field.authType': 'Auth type',
    'field.password': 'Password',
    'field.privateKeyOption': 'Private Key',
    'field.privateKey': 'Private Key (PEM)',
    'field.passphrase': 'Key passphrase',
    'field.keepAlive': 'Keepalive interval (seconds)',
    'field.keepAliveHint': "Sends an SSH keepalive probe this often so idle connections aren't dropped by NAT/firewalls, and dead links are detected. 0 = off.",
    'field.keepExisting': '(leave blank to keep existing)',

    // group dialog
    'group.dialog.new': 'New Group',
    'group.dialog.rename': 'Rename Group',
    'group.confirmDelete': 'Delete group "{name}"? Sessions inside will become ungrouped.',

    'session.confirmDelete': 'Delete session "{name}"?',

    // tunnel dialog
    'tunnel.dialog.new': 'New Tunnel',
    'tunnel.dialog.edit': 'Edit Tunnel',
    'tunnel.viaSession': 'Via session',
    'tunnel.type': 'Type',
    'tunnel.type.local': 'Local (-L)',
    'tunnel.type.remote': 'Remote (-R)',
    'tunnel.type.dynamic': 'Dynamic / SOCKS5 (-D)',
    'tunnel.listenHost': 'Listen host',
    'tunnel.listenPort': 'Listen port',
    'tunnel.targetHost': 'Target host',
    'tunnel.targetPort': 'Target port',
    'tunnel.running': 'running',
    'tunnel.stopped': 'stopped',
    'tunnel.confirmDelete': 'Delete tunnel "{name}"?',

    // change password dialog
    'pw.title': 'Change Admin Password',
    'pw.current': 'Current password',
    'pw.newUsername': 'New username',
    'pw.keepCurrent': '(leave blank to keep current)',
    'pw.new': 'New password',
    'pw.confirm': 'Confirm new password',
    'pw.tooShort': 'New password must be at least 6 characters.',
    'pw.mismatch': 'New password and confirmation do not match.',
    'pw.failed': 'Failed to change password',
    'pw.changed': 'Password changed. Please sign in again with your new credentials.',

    // terminal (written into the xterm buffer)
    'term.error': '[error] {message}',
    'term.closed': '[connection closed]',
    'term.disconnected': '[disconnected]',

    // sftp
    'sftp.up': 'Up one level',
    'sftp.refresh': 'Refresh',
    'sftp.newFolder': 'New folder',
    'sftp.newFolderBtn': '＋Folder',
    'sftp.upload': '⬆ Upload',
    'sftp.cancelUploadTitle': 'Cancel upload',
    'sftp.cancelUploadBtn': '✕ Cancel',
    'sftp.loading': 'Loading…',
    'sftp.download': 'Download',
    'sftp.newName': 'New name:',
    'sftp.newFolderName': 'New folder name:',
    'sftp.confirmDelete': 'Delete "{name}"?',
    'sftp.confirmDeleteDir': 'Delete "{name}"? (and everything inside it)',
    'sftp.uploading': 'Uploading {index}/{total}: {name}',
    'sftp.finalizing': 'finalizing on remote…',
    'sftp.eta': 'ETA {time}',
    'sftp.uploadComplete': 'Upload complete: {count} file(s)',
    'sftp.uploadSummary': '{size} in {time} · avg {speed}',
    'sftp.uploadCancelled': 'Upload cancelled',
    'sftp.uploadCancelledDetail': '{done} of {total} file(s) uploaded before cancelling; "{name}" was not kept.',
    'sftp.uploadFailed': 'Upload failed: {name}',
    'sftp.earlierUploaded': ' ({count} earlier file(s) uploaded)',
    'sftp.connectionLost': 'connection lost during upload (the server may have rejected the request — check the target folder permissions)',
  };

  const zhCN = {
    'app.title': 'WebSSH',
    'common.cancel': '取消',
    'common.save': '保存',
    'common.none': '（无）',
    'common.empty': '（空）',
    'common.edit': '编辑',
    'common.delete': '删除',
    'common.rename': '重命名',
    'common.start': '启动',
    'common.stop': '停止',
    'common.language': '语言',

    'login.username': '用户名',
    'login.password': '密码',
    'login.submit': '登录',
    'login.error': '用户名或密码错误',
    'build.version': '构建版本 {version}',

    'sidebar.collapse': '收起侧边栏',
    'sidebar.expand': '展开侧边栏',
    'sidebar.resize': '拖动调整宽度',
    'search.placeholder': '搜索会话和隧道…',
    'search.clear': '清除搜索',
    'search.noSessions': '没有匹配的会话。',
    'search.noTunnels': '没有匹配的隧道。',
    'sessions.title': '会话',
    'group.newTitle': '新建分组',
    'group.newBtn': '＋分组',
    'session.newTitle': '新建会话',
    'session.newBtn': '＋会话',
    'tunnels.title': '隧道',
    'tunnel.newTitle': '新建隧道',
    'tunnel.newBtn': '＋隧道',
    'footer.signOut': '退出登录',
    'footer.changePassword': '修改管理员密码',
    'theme.toLight': '切换到浅色主题',
    'theme.toDark': '切换到深色主题',
    'item.files': '文件（SFTP）',

    'layout.single': '单窗格',
    'layout.horizontal': '左右分屏',
    'layout.vertical': '上下分屏',
    'layout.grid': '四宫格',
    'fullscreen.enter': '全屏',
    'fullscreen.exit': '退出全屏',
    'empty.state': '请在左侧选择一个会话，或点击 <b>＋会话</b> 新建。',
    'split.choose': '请在上方选择会话',

    'session.dialog.new': '新建会话',
    'session.dialog.edit': '编辑会话',
    'field.name': '名称',
    'field.group': '分组',
    'field.host': '主机',
    'field.port': '端口',
    'field.username': '用户名',
    'field.authType': '认证方式',
    'field.password': '密码',
    'field.privateKeyOption': '私钥',
    'field.privateKey': '私钥（PEM）',
    'field.passphrase': '私钥口令',
    'field.keepAlive': '保活间隔（秒）',
    'field.keepAliveHint': '按此间隔发送 SSH 保活探测，避免空闲连接被 NAT/防火墙断开，并能及时发现失效链路。0 表示关闭。',
    'field.keepExisting': '（留空则保持不变）',

    'group.dialog.new': '新建分组',
    'group.dialog.rename': '重命名分组',
    'group.confirmDelete': '确定删除分组“{name}”吗？组内的会话将变为未分组。',

    'session.confirmDelete': '确定删除会话“{name}”吗？',

    'tunnel.dialog.new': '新建隧道',
    'tunnel.dialog.edit': '编辑隧道',
    'tunnel.viaSession': '经由会话',
    'tunnel.type': '类型',
    'tunnel.type.local': '本地转发 (-L)',
    'tunnel.type.remote': '远程转发 (-R)',
    'tunnel.type.dynamic': '动态 / SOCKS5 (-D)',
    'tunnel.listenHost': '监听地址',
    'tunnel.listenPort': '监听端口',
    'tunnel.targetHost': '目标主机',
    'tunnel.targetPort': '目标端口',
    'tunnel.running': '运行中',
    'tunnel.stopped': '已停止',
    'tunnel.confirmDelete': '确定删除隧道“{name}”吗？',

    'pw.title': '修改管理员密码',
    'pw.current': '当前密码',
    'pw.newUsername': '新用户名',
    'pw.keepCurrent': '（留空则保持当前用户名）',
    'pw.new': '新密码',
    'pw.confirm': '确认新密码',
    'pw.tooShort': '新密码长度至少为 6 位。',
    'pw.mismatch': '两次输入的新密码不一致。',
    'pw.failed': '修改密码失败',
    'pw.changed': '密码已修改，请使用新的凭据重新登录。',

    'term.error': '[错误] {message}',
    'term.closed': '[连接已关闭]',
    'term.disconnected': '[已断开连接]',

    'sftp.up': '上一级',
    'sftp.refresh': '刷新',
    'sftp.newFolder': '新建文件夹',
    'sftp.newFolderBtn': '＋文件夹',
    'sftp.upload': '⬆ 上传',
    'sftp.cancelUploadTitle': '取消上传',
    'sftp.cancelUploadBtn': '✕ 取消',
    'sftp.loading': '加载中…',
    'sftp.download': '下载',
    'sftp.newName': '新名称：',
    'sftp.newFolderName': '新文件夹名称：',
    'sftp.confirmDelete': '确定删除“{name}”吗？',
    'sftp.confirmDeleteDir': '确定删除“{name}”吗？（其中的所有内容也会一并删除）',
    'sftp.uploading': '正在上传 {index}/{total}：{name}',
    'sftp.finalizing': '正在远端写入…',
    'sftp.eta': '剩余 {time}',
    'sftp.uploadComplete': '上传完成：共 {count} 个文件',
    'sftp.uploadSummary': '共 {size}，耗时 {time} · 平均 {speed}',
    'sftp.uploadCancelled': '上传已取消',
    'sftp.uploadCancelledDetail': '取消前已上传 {done}/{total} 个文件；“{name}”未保留。',
    'sftp.uploadFailed': '上传失败：{name}',
    'sftp.earlierUploaded': '（此前已上传 {count} 个文件）',
    'sftp.connectionLost': '上传过程中连接中断（服务器可能拒绝了请求，请检查目标文件夹权限）',
  };

  // Error strings returned by the Go backend (always English). Exact matches
  // are translated for display; anything not listed is shown unchanged.
  const zhCNServerErrors = {
    'bad request': '请求无效',
    'invalid credentials': '凭据无效',
    'unauthorized': '未授权，请重新登录',
    'method not allowed': '不支持的请求方法',
    'unknown action': '未知操作',
    'current password is incorrect': '当前密码不正确',
    'new password must be at least 6 characters': '新密码长度至少为 6 位',
    'failed to save new credentials': '保存新凭据失败',
    'name is required': '名称不能为空',
    'name, host and username are required': '名称、主机和用户名为必填项',
    'name and sessionId are required': '名称和会话为必填项',
    'sessionId does not reference an existing session': '所选会话不存在',
    'group not found': '未找到该分组',
    'session not found': '未找到该会话',
    'tunnel not found': '未找到该隧道',
    'path is required': '路径不能为空',
    'oldPath and newPath are required': '原路径和新路径不能为空',
    'refusing to remove root/empty path': '拒绝删除根目录或空路径',
  };

  const LANGS = {
    en: { name: 'English', messages: en, serverErrors: {} },
    'zh-CN': { name: '简体中文', messages: zhCN, serverErrors: zhCNServerErrors },
  };

  // ---------------- detection / persistence ----------------
  function normalize(tag) {
    if (!tag) return null;
    const lower = String(tag).toLowerCase();
    if (lower.startsWith('zh')) return 'zh-CN'; // zh, zh-CN, zh-TW, zh-HK… -> Chinese
    if (lower.startsWith('en')) return 'en';
    return null;
  }

  function detectLang() {
    const prefs = (navigator.languages && navigator.languages.length)
      ? navigator.languages
      : [navigator.language || navigator.userLanguage];
    for (const tag of prefs) {
      const lang = normalize(tag);
      if (lang) return lang; // first browser-preferred language we support
    }
    return DEFAULT_LANG;
  }

  function loadSaved() {
    try {
      const v = localStorage.getItem(STORAGE_KEY);
      if (v && LANGS[v]) return v;
    } catch (_) {}
    return null;
  }

  function save(lang) {
    try { localStorage.setItem(STORAGE_KEY, lang); } catch (_) {}
  }

  // First visit: detect from the browser and persist it.
  let current = loadSaved();
  if (!current) {
    current = detectLang();
    save(current);
  }

  const listeners = [];

  // ---------------- API ----------------
  function t(key, params) {
    let s = LANGS[current].messages[key];
    if (s === undefined) s = en[key];
    if (s === undefined) return key;
    if (params) {
      s = s.replace(/\{(\w+)\}/g, (m, k) => (params[k] !== undefined ? params[k] : m));
    }
    return s;
  }

  function err(message) {
    const map = LANGS[current].serverErrors;
    return (map && map[message]) || message;
  }

  function apply(root) {
    root = root || document;
    root.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
    root.querySelectorAll('[data-i18n-html]').forEach((el) => { el.innerHTML = t(el.dataset.i18nHtml); });
    root.querySelectorAll('[data-i18n-title]').forEach((el) => { el.title = t(el.dataset.i18nTitle); });
    root.querySelectorAll('[data-i18n-placeholder]').forEach((el) => { el.placeholder = t(el.dataset.i18nPlaceholder); });
  }

  function syncPickers() {
    document.querySelectorAll('select.lang-select').forEach((sel) => {
      if (sel.options.length !== Object.keys(LANGS).length) {
        sel.innerHTML = '';
        for (const code of Object.keys(LANGS)) {
          const o = document.createElement('option');
          o.value = code;
          o.textContent = LANGS[code].name;
          sel.appendChild(o);
        }
      }
      sel.value = current;
      sel.title = t('common.language');
      sel.setAttribute('aria-label', t('common.language'));
    });
  }

  function applyAll() {
    document.documentElement.lang = current;
    document.title = t('app.title');
    apply(document);
    syncPickers();
  }

  function setLang(lang) {
    if (!LANGS[lang]) return;
    current = lang;
    save(lang);
    applyAll();
    for (const fn of listeners) {
      try { fn(lang); } catch (e) { console.error(e); }
    }
  }

  function onChange(fn) { listeners.push(fn); }

  window.I18n = {
    t, err, apply, setLang, onChange, detectLang,
    getLang: () => current,
    languages: () => Object.keys(LANGS).map((code) => ({ code, name: LANGS[code].name })),
  };

  // Translate the static markup as soon as it exists and wire up the pickers.
  function init() {
    applyAll();
    document.addEventListener('change', (e) => {
      const el = e.target;
      if (el && el.classList && el.classList.contains('lang-select')) setLang(el.value);
    });
  }
  document.documentElement.lang = current;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
