import {SquareClient, RetryableError, ApiRejectedError} from './lib/square.js';
import {validateMedia, safeError, httpsUrl} from './lib/core.js';
const running = new Map();
class SyncPausedError extends Error {}
async function send(type, id, rest = {}) {
  const response = await chrome.runtime.sendMessage({type, id, ...rest});
  if (!response?.ok) {
    if (response?.paused) throw new SyncPausedError('同步已暂停，尚未发布');
    throw new Error(response?.error || '后台未确认接收，请检查同步记录');
  }
  return response;
}
async function download(raw, video = false) {
  try {
  if (!httpsUrl(raw, video ? ['video.twimg.com'] : ['pbs.twimg.com'])) throw new Error('不受支持的媒体地址');
  const url = new URL(raw);
  if (!video && /\/media\//.test(url.pathname)) url.searchParams.set('name', 'orig');
  const response = await fetch(url, {credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(600000)});
  if (response.status === 429 || response.status >= 500) throw new RetryableError(`X 附件暂时无法下载（HTTP ${response.status}）`);
  if (!response.ok) throw new Error(`X 附件下载失败（HTTP ${response.status}）`);
  const max = (video ? 512 : 20) * 1024 * 1024;
  const type = response.headers.get('content-type')?.split(';')[0] ?? '';
  if (!(video ? type === 'video/mp4' : /^image\/(jpeg|png|webp|gif)$/.test(type))) throw new Error('X 返回的媒体格式不支持');
  if (Number(response.headers.get('content-length')) > max) { await response.body.cancel(); throw new Error('附件超过插件大小限制'); }
  const reader = response.body.getReader(); const chunks = []; let size = 0;
  while (true) {
    const {done, value} = await reader.read(); if (done) break;
    size += value.byteLength;
    if (size > max) { await reader.cancel(); throw new Error('附件超过插件大小限制'); }
    chunks.push(value);
  }
  if (!size) throw new Error('X 返回空媒体');
  return new Blob(chunks, {type});
  } catch (error) {
    if (['TypeError', 'TimeoutError', 'AbortError'].includes(error.name)) throw new RetryableError('X 附件下载连接中断或超时');
    throw error;
  }
}
function durationOf(blob) {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video'); const url = URL.createObjectURL(blob);
    let finished = false;
    const finish = (error) => { if (finished) return; finished = true; clearTimeout(timer); const duration = video.duration; video.onloadedmetadata = null; video.onerror = null; video.removeAttribute('src'); video.load(); URL.revokeObjectURL(url); error ? reject(error) : resolve(duration); };
    const timer = setTimeout(() => finish(new Error('无法读取视频时长')), 30000);
    video.onloadedmetadata = () => Number.isFinite(video.duration) && video.duration > 0 ? finish() : finish(new Error('视频时长无效'));
    video.onerror = () => finish(new Error('浏览器无法解析该视频')); video.preload = 'metadata'; video.src = url;
  });
}
const ext = blob => ({'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif'}[blob.type] ?? 'png');
async function run(job, apiKey) {
  let stage = '准备附件'; let publishing = false;
  const notify = (type, rest = {}) => send(type, job.id, {runId: job.runId, ...rest});
  const heartbeat = setInterval(() => { void notify('STAGE', {stage}).catch(() => {}); }, 20000);
  const report = async value => { stage = value; await notify('STAGE', {stage}); };
  const client = new SquareClient(apiKey);
  let completion;
  try {
    validateMedia(job);
    let body = {contentType: 1, bodyTextOnly: job.text};
    const video = job.media.find(m => m.type === 'video' || m.type === 'animated_gif');
    if (video) {
      await report('下载视频'); const blob = await download(video.url, true);
      const duration = video.duration || await durationOf(blob);
      await report('上传并处理视频'); const fileTicket = await client.video(blob, `${job.id}.mp4`);
      await report('上传视频封面'); const coverBlob = await download(video.cover);
      const cover = await client.image(coverBlob, `${job.id}-cover.${ext(coverBlob)}`);
      body = {contentType: 3, fileTicket, cover, videoTimeSeconds: duration, isPublish: true};
      if (job.text) body.bodyTextOnly = job.text;
    } else if (job.media.length) {
      body.imageList = [];
      for (let i = 0; i < job.media.length; i++) {
        await report(`同步图片 ${i + 1}/${job.media.length}`);
        const blob = await download(job.media[i].url);
        body.imageList.push(await client.image(blob, `${job.id}-${i}.${ext(blob)}`));
      }
    }
    await notify('PUBLISH_GATE'); publishing = true; stage = '正在发布到广场';
    const result = await client.publish(body);
    completion = {status: 'sent', squareUrl: result?.shareLink || (result?.id ? `https://www.binance.com/square/post/${result.id}` : '')};
  } catch (error) {
    const status = !publishing && error instanceof SyncPausedError ? 'paused' : publishing && !(error instanceof ApiRejectedError) ? 'review' : 'failed';
    completion = {status, retryable: !publishing && error instanceof RetryableError, error: safeError(error, apiKey)};
  }
  try {
    // Retry only delivery of the same result, never the publication itself.
    for (let attempt = 0; attempt < 3; attempt++) {
      try { await notify('COMPLETE', completion); break; }
      catch { if (attempt < 2) await client.sleep(1000 * (attempt + 1)); }
    }
  } finally { clearInterval(heartbeat); running.delete(job.id); }
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || sender.tab || message?.target !== 'offscreen') return;
  if (message.type === 'STATUS') { respond({ok: true, running: [...running].map(([id, runId]) => ({id, runId}))}); return; }
  if (message.type === 'RUN') {
    if (running.has(message.job.id) && running.get(message.job.id) !== message.job.runId) { respond({ok: false}); return; }
    if (!running.has(message.job.id)) { running.set(message.job.id, message.job.runId); void run(message.job, message.apiKey); }
    respond({ok: true});
  }
});
