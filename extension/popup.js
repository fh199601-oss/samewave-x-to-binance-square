const $ = id => document.getElementById(id);
const live = Boolean(globalThis.chrome?.runtime?.id);
let state, changing = false;
async function request(message) {
  const result = await chrome.runtime.sendMessage(message);
  if (!result?.ok) throw new Error(result?.error || '插件未响应，请重开面板');
  return result.state;
}
function paint() {
  const {settings = {}, hasKey = false, jobs = []} = state ?? {};
  const configured = Boolean(hasKey && settings.handle);
  $('status').textContent = settings.enabled ? '同步已开启' : configured ? '已暂停' : '待配置';
  $('account').textContent = settings.handle ? `@${settings.handle} → 币安广场` : '连接账号，开始你的第一次同频。';
  $('enabled').checked = Boolean(settings.enabled); $('enabled').disabled = changing || !configured || !live;
  $('toggleHint').textContent = !live ? '界面预览 · 安装后可操作' : !configured ? '先在工作台配置账号与 API' : settings.enabled ? '新帖会按你的偏好自动同步' : '已暂停，开启后继续同步新帖';
  $('sent').textContent = jobs.filter(j => j.status === 'sent').length;
  $('pending').textContent = jobs.filter(j => ['queued', 'preparing', 'publishing'].includes(j.status)).length;
  $('attention').textContent = jobs.filter(j => ['failed', 'review'].includes(j.status)).length;
}
async function refresh() { if (live) { state = await request({type: 'GET_STATE'}); paint(); } }
$('open').onclick = () => { if (live) { chrome.runtime.openOptionsPage(); window.close(); } };
$('enabled').onchange = async () => {
  const enabled = $('enabled').checked; changing = true; $('enabled').disabled = true; $('feedback').textContent = '';
  try {
    state = await request({type: 'SET_ENABLED', enabled});
    $('feedback').textContent = enabled ? '已开启，设置立即生效' : '已暂停；已经发出的请求仍会完成';
  } catch (error) { $('feedback').textContent = error.message; }
  finally { changing = false; paint(); }
};
paint();
if (live) {
  void refresh().catch(error => { $('feedback').textContent = error.message; });
  chrome.storage.onChanged.addListener(() => { void refresh().catch(() => {}); });
}
