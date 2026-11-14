export const DEFAULT_SETTINGS = Object.freeze({handle: '', enabled: false, enabledAt: 0, syncOriginals: true, syncReplies: false, syncQuotes: false, syncReposts: false, syncText: true, syncImages: true, syncVideos: true, appendSource: false});
export const X_HOSTS = ['x.com', 'www.x.com', 'twitter.com'];
export function httpsUrl(raw, hosts) {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && hosts.includes(url.hostname);
  } catch { return false; }
}
export function normalizePost(post) {
  if (!post || !/^\d{10,25}$/.test(post.id) || !/^[A-Za-z0-9_]{1,15}$/.test(post.handle)) throw new Error('X 帖子标识无效');
  if (typeof post.text !== 'string' || post.text.length > 100000 || !Array.isArray(post.media) || post.media.length > 4) throw new Error('X 帖子格式无效');
  const media = post.media.map(m => ({type: m.type, url: m.url, cover: m.cover, duration: Number(m.duration) || 0}));
  return {
    id: post.id, handle: post.handle, text: post.text, media,
    expectedMedia: Number(post.expectedMedia) || 0, contextUrl: httpsUrl(post.contextUrl, X_HOSTS) ? post.contextUrl : '',
    createdAt: Number(post.createdAt), capturedAt: Number(post.capturedAt),
    reply: Boolean(post.reply), quote: Boolean(post.quote), retweet: Boolean(post.retweet), unsupported: Boolean(post.unsupported),
    sourceUrl: `https://x.com/${post.handle}/status/${post.id}`
  };
}
export function eligibility(post, settings, now = Date.now()) {
  if (!settings.enabled) return '同步未开启';
  if (post.handle.toLowerCase() !== settings.handle.toLowerCase()) return '其他账号';
  if (post.retweet ? !settings.syncReposts : post.reply ? !settings.syncReplies : post.quote ? !settings.syncQuotes : !settings.syncOriginals) return '已按帖子类型过滤';
  if (post.media.some(m => m.type === 'video' || m.type === 'animated_gif') ? !settings.syncVideos : (post.media.length || post.expectedMedia) ? !settings.syncImages : !settings.syncText) return '已按内容类型过滤';
  if (!Number.isFinite(post.createdAt) || post.createdAt < settings.enabledAt - 2000 || Math.abs(now - post.createdAt) > 10 * 60 * 1000) return '不是刚发布的新帖';
  return '';
}
export function validateMedia(post) {
  if (post.unsupported) throw new Error('投票、卡片或 X 文章尚不支持自动同步，请手动处理');
  if (post.media.length !== post.expectedMedia) throw new Error('X 未返回完整媒体，已暂停，避免漏发附件');
  if (!post.text.trim() && post.media.length === 0) throw new Error('帖子没有正文或媒体');
  const videos = post.media.filter(m => m.type === 'video' || m.type === 'animated_gif');
  if (videos.length && (videos.length !== 1 || post.media.length !== 1)) throw new Error('广场不支持图片和视频混发或多个视频');
  for (const media of post.media) {
    if (media.type === 'photo') {
      if (!httpsUrl(media.url, ['pbs.twimg.com'])) throw new Error('图片地址不完整或不受支持');
    } else if (media.type === 'video' || media.type === 'animated_gif') {
      if (!httpsUrl(media.url, ['video.twimg.com']) || !httpsUrl(media.cover, ['pbs.twimg.com'])) throw new Error('X 尚未返回完整 MP4 视频及封面地址');
    } else throw new Error('暂不支持此媒体格式');
  }
}
export function publishText(post, settings) {
  let text = post.text;
  if (post.quote && post.contextUrl && !text.includes(post.contextUrl)) text += `\n\n引用：${post.contextUrl}`;
  if (post.reply && post.contextUrl && !text.includes(post.contextUrl)) text += `\n\n回复：${post.contextUrl}`;
  if (settings.appendSource && !text.includes(post.sourceUrl)) text += `\n\n${post.sourceUrl}`;
  return text.trim();
}
export function safeError(error, key = '') {
  let message = String(error?.message ?? error ?? '未知错误');
  if (key) message = message.split(key).join('[已隐藏]');
  return message.replace(/https?:\/\/\S+/g, '[地址已隐藏]').slice(0, 400);
}
export function publicJob(job) {
  const {id, status, text, sourceUrl, createdAt, updatedAt, error, squareUrl, stage, media, attempts} = job;
  return {id, status, text: text.slice(0, 140), sourceUrl, createdAt, updatedAt, error, squareUrl, stage, attempts, mediaCount: media.length};
}
