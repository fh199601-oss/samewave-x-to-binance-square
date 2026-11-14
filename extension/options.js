import {DEFAULT_SETTINGS} from './lib/core.js';
const $ = id => document.getElementById(id);
const live = Boolean(globalThis.chrome?.runtime?.id);
const fields = Object.keys(DEFAULT_SETTINGS).filter(k => k !== 'enabledAt');
let state = {settings: {...DEFAULT_SETTINGS}, hasKey: false, jobs: [], lastCapture: 0};
let filter = 'all', dirty = false, toastTimer;
function toast(message, error = false) { $('toast').textContent = message; $('toast').className = `toast${error ? ' error' : ''}`; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').classList.add('hidden'), 5000); }
function showConnection(result) {
  const el = $('connectionResult'); el.className = result ? `connection-result ${result.status}` : 'connection-result hidden';
  el.textContent = result?.message ?? '';
}
async function request(message) {
  if (!live) throw new Error('当前是界面预览，请先安装 Chrome 插件');
  const result = await chrome.runtime.sendMessage(message);
  if (!result?.ok) throw new Error(result?.error || '插件未响应，请重新打开设置页');
  return result;
}
function draft() { return Object.fromEntries(fields.map(key => [key, typeof DEFAULT_SETTINGS[key] === 'boolean' ? $(key).checked : $(key).value.trim().replace(/^@/, '')])); }
const formatTime = value => value ? new Intl.DateTimeFormat('zh-CN', {month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'}).format(value) : '等待第一条新帖';
function paint(fill = true) {
  if (fill) for (const key of fields) typeof DEFAULT_SETTINGS[key] === 'boolean' ? $(key).checked = state.settings[key] : $(key).value = state.settings[key];
  $('apiKey').placeholder = state.hasKey ? '已安全保存；留空则不修改' : '粘贴你的广场发帖 API Key';
  $('keyState').textContent = state.hasKey ? '✓ API 已保存在本机' : '尚未配置 API';
  $('removeKey').classList.toggle('hidden', !state.hasKey);
  if (!$('apiKey').value && !$('checkKey').disabled) showConnection(state.connectionCheck);
  $('statSent').firstChild.textContent = state.jobs.filter(j => j.status === 'sent').length;
  $('statPending').firstChild.textContent = state.jobs.filter(j => ['queued', 'preparing', 'publishing'].includes(j.status)).length;
  $('statAttention').firstChild.textContent = state.jobs.filter(j => ['failed', 'review'].includes(j.status)).length;
  $('statusDot').classList.toggle('on', state.settings.enabled);
  $('statusTitle').textContent = state.settings.enabled ? '正在等待你的下一次分享' : state.hasKey ? '同步已暂停' : '还差一步，就能同频';
  $('statusDescription').textContent = state.settings.enabled ? `正在同步 @${state.settings.handle} 的新帖。请在保存后刷新 X 页面。` : '填写账号与 API，选择偏好，然后开启自动同步。';
  $('lastCapture').textContent = formatTime(state.lastCapture);
  $('togglePause').textContent = state.settings.enabled ? '暂停同步' : '开启同步';
  $('diagnostic').textContent = state.diagnostic || '';
  $('diagnostic').classList.toggle('hidden', !state.diagnostic);
  paintJobs();
}
function button(text, fn) { const el = document.createElement('button'); el.type = 'button'; el.className = 'text-button'; el.textContent = text; el.onclick = () => fn().catch(e => toast(e.message, true)); return el; }
function link(text, href) { const el = document.createElement('a'); el.textContent = text; el.href = href; el.target = '_blank'; el.rel = 'noreferrer'; return el; }
async function act(job, action) {
  let confirmedAbsent = false;
  if (action === 'retry' && job.status === 'review') {
    confirmedAbsent = confirm('这个发布结果不确定。请先打开币安广场检查。\n\n只有确认广场没有该帖时，才点击「确定」重新发布，否则可能产生重复帖子。');
    if (!confirmedAbsent) return;
  }
  const result = await request({type: 'JOB_ACTION', id: job.id, action, confirmedAbsent}); state = result.state; paint(false);
}
function paintJobs() {
  const jobs = state.jobs.filter(j => filter === 'all' || (filter === 'pending' ? ['queued', 'preparing', 'publishing'].includes(j.status) : filter === 'attention' ? ['failed', 'review'].includes(j.status) : j.status === filter)).slice().reverse();
  $('jobs').replaceChildren();
  if (!jobs.length) {
    const empty = document.createElement('div'); empty.className = 'empty';
    const icon = document.createElement('span'); icon.textContent = '↗';
    const heading = document.createElement('h3'); heading.textContent = filter === 'all' ? '下一次分享，从这里开始' : '这里暂时没有记录';
    const hint = document.createElement('p'); hint.textContent = '同步结果会自动出现在这里'; empty.append(icon, heading, hint); $('jobs').append(empty); return;
  }
  const names = {queued: '排队中', preparing: '同步附件', publishing: '发布中', sent: '已同步', failed: '需处理', review: '待核对', dismissed: '已忽略'};
  for (const job of jobs) {
    const row = document.createElement('article'); row.className = 'job'; const body = document.createElement('div');
    const text = document.createElement('p'); text.textContent = job.text || `[${job.mediaCount} 个附件]`;
    const meta = document.createElement('small'); meta.textContent = `${formatTime(job.createdAt)}${job.stage ? ` · ${job.stage}` : ''}`;
    body.append(text, meta, link('查看 X ↗', job.sourceUrl)); if (job.squareUrl) body.append(link('查看广场 ↗', job.squareUrl));
    if (job.error) { const error = document.createElement('p'); error.className = 'job-error'; error.textContent = job.error; body.append(error); }
    if (['failed', 'review', 'queued'].includes(job.status)) {
      const actions = document.createElement('div'); actions.className = 'job-actions';
      if (job.status !== 'queued') actions.append(button(job.status === 'review' ? '核对后重试' : '重试', () => act(job, 'retry')));
      if (job.status === 'review') actions.append(button('确认已在广场发布', () => act(job, 'sent')));
      actions.append(button('忽略此条', () => act(job, 'dismiss'))); body.append(actions);
    }
    const badge = document.createElement('span'); badge.className = `job-badge ${job.status}`; badge.textContent = names[job.status] || job.status;
    row.append(body, badge); $('jobs').append(row);
  }
}
async function saveSettings() {
  $('saveButton').disabled = true;
  try {
    const result = await request({type: 'SAVE_SETTINGS', settings: draft(), apiKey: $('apiKey').value});
    state = result.state; $('apiKey').value = ''; dirty = false; paint(); $('saveHint').textContent = '设置已保存，请刷新已打开的 X 页面'; toast('设置已保存');
  } finally { $('saveButton').disabled = false; }
}
$('settingsForm').onsubmit = e => { e.preventDefault(); void saveSettings().catch(e => toast(e.message, true)); };
$('settingsForm').addEventListener('input', e => { dirty = true; $('saveHint').textContent = '有未保存的更改'; if (e.target.id === 'apiKey') showConnection(null); });
$('togglePause').onclick = async () => {
  try {
    if (!state.hasKey || !state.settings.handle) { $('accounts').scrollIntoView(); $('handle').focus(); toast('请先配置账号与 API，并保存设置'); return; }
    const result = await request({type: 'SET_ENABLED', enabled: !state.settings.enabled});
    state = result.state; $('enabled').checked = state.settings.enabled; paint(false); toast(state.settings.enabled ? '自动同步已开启，请刷新 X 页面' : '已暂停；已经发送的发布请求仍会完成');
  } catch (e) { toast(e.message, true); }
};
$('revealKey').onclick = () => { $('apiKey').type = $('apiKey').type === 'password' ? 'text' : 'password'; $('revealKey').textContent = $('apiKey').type === 'password' ? '显示' : '隐藏'; };
$('checkKey').onclick = async () => {
  $('checkKey').disabled = true; $('checkKey').textContent = '检测中…';
  showConnection({status: 'pending', message: '正在检测币安广场 API，请稍候（最多 20 秒）…'});
  try { const result = await request({type: 'CHECK_KEY', apiKey: $('apiKey').value}); showConnection(result.check); toast(result.message); }
  catch (e) { showConnection({status: 'error', message: e.message}); toast(e.message, true); }
  finally { $('checkKey').disabled = false; $('checkKey').textContent = '检测连接'; }
};
$('removeKey').onclick = async () => { if (!confirm('移除本机保存的 API 并暂停同步？')) return; try { state = (await request({type: 'REMOVE_KEY'})).state; paint(); toast('API 已移除'); } catch (e) { toast(e.message, true); } };
$('exportSettings').onclick = () => {
  const settings = draft(); settings.enabled = false;
  const blob = new Blob([JSON.stringify({app: 'samewave', version: 1, settings}, null, 2)], {type: 'application/json'});
  const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = 'samewave-preferences.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); toast('已导出偏好，不包含 API');
};
$('importSettings').onclick = () => $('importFile').click();
$('importFile').onchange = async () => {
  try {
    const file = $('importFile').files[0]; if (!file) return;
    if (file.size > 10000) throw new Error('配置文件过大');
    const data = JSON.parse(await file.text()); if (data.app !== 'samewave' || data.version !== 1 || !data.settings) throw new Error('不是同频配置文件');
    for (const key of fields) {
      if (key === 'enabled') { $(key).checked = false; continue; }
      if (typeof DEFAULT_SETTINGS[key] === 'boolean' && typeof data.settings[key] === 'boolean') $(key).checked = data.settings[key];
      if (key === 'handle' && typeof data.settings.handle === 'string') $(key).value = data.settings.handle.slice(0, 16);
    }
    dirty = true; $('saveHint').textContent = '已导入偏好，保存后生效'; toast('偏好已导入，请检查后保存');
  } catch (e) { toast(e.message, true); } finally { $('importFile').value = ''; }
};
async function refresh() { if (live) { state = (await request({type: 'GET_STATE'})).state; paint(!dirty); } }
$('refresh').onclick = () => void refresh().catch(e => toast(e.message, true));
document.querySelectorAll('[data-filter]').forEach(el => { el.onclick = () => { filter = el.dataset.filter; document.querySelectorAll('[data-filter]').forEach(e => e.classList.toggle('selected', e === el)); paintJobs(); }; });
$('openHelp').onclick = () => $('help').showModal(); $('closeHelp').onclick = () => $('help').close();
document.querySelectorAll('nav a').forEach(el => el.onclick = () => { document.querySelectorAll('nav a').forEach(e => e.classList.toggle('active', e === el)); });
$('today').textContent = new Intl.DateTimeFormat('zh-CN', {month: 'long', day: 'numeric', weekday: 'long'}).format(Date.now());
if (!live) { $('previewNotice').classList.remove('hidden'); $('modePill').textContent = '界面预览'; }
paint(); await refresh().catch(e => toast(e.message, true));
if (live) chrome.storage.onChanged.addListener(changes => {
  // A quick toggle in the toolbar is authoritative even while other form fields are dirty.
  if (changes.settings?.newValue) $('enabled').checked = Boolean(changes.settings.newValue.enabled);
  void refresh().catch(() => {});
});
