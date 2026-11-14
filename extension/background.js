import {DEFAULT_SETTINGS, X_HOSTS, httpsUrl, normalizePost, eligibility, validateMedia, publishText, safeError, publicJob} from './lib/core.js';
import {SquareClient} from './lib/square.js';

// Both the project root and the legacy extension/ directory can be loaded in Chrome.
const resource = file => chrome.runtime.getURL(chrome.runtime.getManifest().background.service_worker.replace(/[^/]+$/, '') + file);
const fromPage = (sender, file) => sender.id === chrome.runtime.id && sender.url?.split('#')[0] === resource(file);
async function bounded(promise, ms = 5000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('后台响应超时')), ms); })]); }
  finally { clearTimeout(timer); }
}

// Every mutation is serialized, including offscreen callbacks and alarm recovery.
let chain = Promise.resolve();
const serialized = fn => { const task = chain.then(fn); chain = task.catch(() => {}); return task; };
const ready = chrome.storage.local.setAccessLevel({accessLevel: 'TRUSTED_CONTEXTS'});
async function read() {
  await ready;
  const state = await chrome.storage.local.get(['settings', 'apiKey', 'jobs', 'seen', 'diagnostic', 'lastCapture', 'connectionCheck']);
  return {settings: {...DEFAULT_SETTINGS, ...state.settings}, apiKey: state.apiKey ?? '', jobs: state.jobs ?? [], seen: state.seen ?? {}, diagnostic: state.diagnostic ?? '', lastCapture: state.lastCapture ?? 0, connectionCheck: state.connectionCheck ?? null};
}
async function save(state) {
  await chrome.storage.local.set(state);
  const issues = state.jobs.filter(j => ['failed', 'review'].includes(j.status)).length;
  await chrome.action.setBadgeText({text: issues ? String(issues) : state.settings.enabled ? 'ON' : ''});
  await chrome.action.setBadgeBackgroundColor({color: issues ? '#d25c40' : '#318767'});
}
function view(state) {
  return {settings: state.settings, hasKey: Boolean(state.apiKey), jobs: state.jobs.map(publicJob), diagnostic: state.diagnostic, lastCapture: state.lastCapture, connectionCheck: state.connectionCheck};
}
function preparationFailed(job, error, retryable) {
  job.error = error; job.updatedAt = Date.now(); job.stage = '';
  if (retryable && (job.autoRetries ?? 0) < 3) {
    job.autoRetries = (job.autoRetries ?? 0) + 1;
    job.nextAttemptAt = Date.now() + [30000, 120000, 300000][job.autoRetries - 1];
    job.status = 'queued'; job.stage = `等待自动重试（${job.autoRetries}/3）`;
  } else { job.status = 'failed'; job.nextAttemptAt = 0; }
}
async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [resource('offscreen.html')]});
  if (!contexts.length) await chrome.offscreen.createDocument({url: resource('offscreen.html'), reasons: ['BLOBS'], justification: '下载帖子附件并在后台持续上传视频，使用 Blob 读取视频时长。'});
}
async function pump() {
  const state = await read();
  if (!state.settings.enabled || !state.apiKey || state.jobs.some(j => ['preparing', 'publishing'].includes(j.status))) return;
  const job = state.jobs.find(j => j.status === 'queued' && (j.nextAttemptAt ?? 0) <= Date.now());
  if (!job) return;
  try {
    await ensureOffscreen();
    job.status = 'preparing'; job.updatedAt = Date.now(); job.attempts = (job.attempts ?? 0) + 1;
    job.runId = crypto.randomUUID(); job.stage = '准备同步';
    await save(state);
    const result = await bounded(chrome.runtime.sendMessage({target: 'offscreen', type: 'RUN', job, apiKey: state.apiKey}));
    if (!result?.ok) throw new Error('后台媒体任务未启动');
  } catch (error) {
    // No publication gate could pass while this serialized start operation was pending.
    preparationFailed(job, safeError(error, state.apiKey), true);
    await save(state);
  }
}
function schedulePump() { void serialized(pump).catch(() => {}); }

async function dispatch(message, sender) {
  const state = await read();
  const ownPage = fromPage(sender, 'options.html');
  const popup = fromPage(sender, 'popup.html');
  const offscreen = sender.id === chrome.runtime.id && sender.url === resource('offscreen.html');
  if (message.type === 'CAPTURE') {
    if (sender.id !== chrome.runtime.id || sender.frameId !== 0 || !httpsUrl(sender.url, X_HOSTS)) throw new Error('来源不受支持');
    if (!state.settings.enabled) return {ok: true};
    if (message.diagnostic) {
      state.diagnostic = String(message.diagnostic).slice(0, 250); await save(state); return {ok: true};
    }
    const post = normalizePost(message.post);
    const reason = eligibility(post, state.settings);
    if (reason || state.seen[post.id]) return {ok: true, skipped: true};
    if (state.jobs.filter(j => ['queued', 'preparing', 'publishing'].includes(j.status)).length >= 100) {
      state.diagnostic = '待同步任务超过 100 条，有新帖未能入队，请先处理队列'; await save(state);
      throw new Error(state.diagnostic);
    }
    let error = '';
    try { validateMedia(post); } catch (e) { error = e.message; }
    const job = {...post, text: publishText(post, state.settings), status: error ? 'failed' : 'queued', error, updatedAt: Date.now(), attempts: 0};
    state.jobs.push(job); state.seen[post.id] = Date.now(); state.lastCapture = Date.now(); state.diagnostic = '';
    // Preserve the ledger independently when trimming old, completed display records.
    if (state.jobs.length > 500) state.jobs = state.jobs.filter((j, i) => i >= state.jobs.length - 500 || !['sent', 'dismissed'].includes(j.status));
    await save(state); schedulePump(); return {ok: true};
  }
  if (offscreen) {
    const job = state.jobs.find(j => j.id === message.id);
    if (!job) throw new Error('任务不存在');
    if (job.runId && message.runId !== job.runId) return {ok: false, error: '任务批次已过期'};
    if (message.type === 'STAGE') {
      if (!['preparing', 'publishing'].includes(job.status)) return {ok: false};
      job.stage = String(message.stage ?? '').slice(0, 100); job.updatedAt = Date.now();
    } else if (message.type === 'PUBLISH_GATE') {
      if (!state.settings.enabled) return {ok: false, paused: true};
      if (job.status !== 'preparing') return {ok: false};
      job.status = 'publishing'; job.stage = '正在发布到广场'; job.updatedAt = Date.now();
    } else if (message.type === 'COMPLETE') {
      if (job.completionRunId === message.runId && job.runId) return {ok: true};
      if (!['preparing', 'publishing'].includes(job.status)) return {ok: false};
      if (!['sent', 'failed', 'review', 'paused'].includes(message.status)) throw new Error('无效结果');
      const beforePublish = job.status === 'preparing';
      if (message.status === 'paused' && !beforePublish) return {ok: false};
      job.status = message.status; job.error = safeError(message.error ?? '', state.apiKey); job.stage = ''; job.updatedAt = Date.now();
      job.completionRunId = message.runId;
      if (message.status === 'failed') preparationFailed(job, job.error, beforePublish && message.retryable === true);
      if (message.status === 'paused') { job.status = 'queued'; job.nextAttemptAt = 0; job.stage = '等待恢复同步'; job.error = ''; }
      job.squareUrl = httpsUrl(message.squareUrl, ['www.binance.com', 'binance.com']) ? message.squareUrl : '';
    } else throw new Error('不支持的后台消息');
    await save(state); if (message.type === 'COMPLETE') schedulePump(); return {ok: true};
  }
  if (!ownPage && !popup) throw new Error('只能从插件面板操作');
  if (message.type === 'GET_STATE') return {ok: true, state: view(state)};
  if (message.type === 'SET_ENABLED') {
    if (typeof message.enabled !== 'boolean') throw new Error('同步开关值无效');
    if (message.enabled && (!state.apiKey || !state.settings.handle)) throw new Error('请先在工作台配置账号与 API');
    if (message.enabled && !state.settings.enabled) state.settings.enabledAt = Date.now();
    state.settings.enabled = message.enabled; await save(state); schedulePump(); return {ok: true, state: view(state)};
  }
  if (!ownPage) throw new Error('请在工作台修改详细设置');
  if (message.type === 'SAVE_SETTINGS') {
    const proposed = message.settings ?? {};
    const handle = String(proposed.handle ?? '').trim().replace(/^@/, '');
    if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) throw new Error('请填写有效的 X 用户名（@ 后的名字，不是昵称）');
    const active = state.jobs.some(j => ['preparing', 'publishing'].includes(j.status));
    const newKey = typeof message.apiKey === 'string' ? message.apiKey.trim() : '';
    if (newKey && (!/^[A-Za-z0-9_-]{16,256}$/.test(newKey))) throw new Error('API Key 格式不正确');
    if (active && (newKey || handle.toLowerCase() !== state.settings.handle.toLowerCase())) throw new Error('请等待当前任务完成，再更换账号或 API');
    if (state.jobs.some(j => !['sent', 'dismissed'].includes(j.status)) && ((newKey && newKey !== state.apiKey) || handle.toLowerCase() !== state.settings.handle.toLowerCase())) throw new Error('请先处理或忽略所有未完成任务，再更换账号或 API，避免旧帖发到新账号');
    if (newKey && newKey !== state.apiKey) { state.apiKey = newKey; state.connectionCheck = null; }
    const next = {...state.settings, handle};
    for (const key of Object.keys(DEFAULT_SETTINGS)) if (typeof DEFAULT_SETTINGS[key] === 'boolean') next[key] = Boolean(proposed[key]);
    if (next.enabled && !state.apiKey) throw new Error('请先填写币安广场 API Key');
    if (next.enabled && (!state.settings.enabled || next.handle !== state.settings.handle)) next.enabledAt = Date.now();
    state.settings = next; await save(state); schedulePump(); return {ok: true, state: view(state)};
  }
  if (message.type === 'REMOVE_KEY') {
    if (state.jobs.some(j => ['preparing', 'publishing'].includes(j.status))) throw new Error('请等待当前任务结束再移除 API');
    state.apiKey = ''; state.settings.enabled = false; state.connectionCheck = null; await save(state); return {ok: true, state: view(state)};
  }
  if (message.type === 'JOB_ACTION') {
    const job = state.jobs.find(j => j.id === message.id);
    if (!job || ['preparing', 'publishing', 'sent', 'dismissed'].includes(job.status)) throw new Error('此任务当前不可操作');
    if (message.action === 'retry') {
      if (job.status === 'review' && message.confirmedAbsent !== true) throw new Error('请先确认广场中没有这条帖子');
      validateMedia(job); job.status = 'queued'; job.error = ''; job.autoRetries = 0; job.nextAttemptAt = 0;
    } else if (message.action === 'sent') job.status = 'sent';
    else if (message.action === 'dismiss') job.status = 'dismissed';
    else throw new Error('不支持的操作');
    job.updatedAt = Date.now(); await save(state); schedulePump(); return {ok: true, state: view(state)};
  }
  throw new Error('未知操作');
}
async function checkConnection(message, sender) {
  if (!fromPage(sender, 'options.html')) throw new Error('只能从插件设置页检测');
  const key = String(message.apiKey || (await read()).apiKey).trim();
  if (!key) throw new Error('请先填写 API Key');
  let result;
  try {
    const ticket = await new SquareClient(key, {timeoutMs: 20000}).api('/image/presignedUrl', {imageName: 'connection-check.png'});
    if (!ticket?.fileTicket || !ticket?.presignedUrl) throw new Error('币安响应缺少上传凭据，尚不能确认 API 可用');
    result = {status: 'success', message: '连接成功，API 可用；未发布测试帖', checkedAt: Date.now()};
  } catch (error) { result = {status: 'error', message: safeError(error, key), checkedAt: Date.now()}; }
  // Read the latest state after the network call; don't overwrite captures or a newer key.
  await serialized(async () => { const state = await read(); if (key === state.apiKey) { state.connectionCheck = result; await save(state); } });
  return {ok: result.status === 'success', message: result.message, error: result.status === 'error' ? result.message : undefined, check: result};
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.target === 'offscreen') return;
  const task = message?.type === 'CHECK_KEY' ? checkConnection(message, sender) : serialized(() => dispatch(message ?? {}, sender));
  task.then(respond, error => respond({ok: false, error: safeError(error)}));
  return true;
});
async function recover() {
  const state = await read();
  let running = [];
  const contexts = await chrome.runtime.getContexts({contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [resource('offscreen.html')]});
  if (contexts.length) {
    try {
      const status = await bounded(chrome.runtime.sendMessage({target: 'offscreen', type: 'STATUS'}));
      if (!status?.ok || !Array.isArray(status.running)) return;
      running = status.running;
    } catch { return; } // Unresponsive is not proof of termination; don't launch a second attempt.
  }
  for (const job of state.jobs) {
    if (!['preparing', 'publishing'].includes(job.status) || running.some(r => typeof r === 'string' ? r === job.id : r.id === job.id && r.runId === job.runId)) continue;
    if (job.status === 'publishing') { job.status = 'review'; job.error = '浏览器在发布过程中中断，请先到广场核对'; }
    else { job.status = 'queued'; job.stage = ''; }
    job.updatedAt = Date.now();
  }
  await save(state); schedulePump();
}
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === 'recover') void serialized(recover); });
chrome.runtime.onStartup.addListener(() => { void serialized(recover); });
chrome.runtime.onInstalled.addListener(details => {
  void chrome.alarms.create('recover', {periodInMinutes: 1});
  if (details.reason === 'install') void chrome.runtime.openOptionsPage();
});
chrome.action.onClicked.addListener(() => { void chrome.runtime.openOptionsPage(); });
void chrome.alarms.create('recover', {periodInMinutes: 1});
