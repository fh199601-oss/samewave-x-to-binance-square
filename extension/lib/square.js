// Wire format verified against Binance's official square-post scripts (2026-11-14).
const BASE = 'https://www.binance.com/bapi/composite';
export class PublishUncertainError extends Error {}
export class RetryableError extends Error {}
export class ApiRejectedError extends Error {}
export class SquareClient {
  constructor(key, {fetcher = fetch, sleep = ms => new Promise(r => setTimeout(r, ms)), timeoutMs = 90000} = {}) {
    // Chrome's native fetch is receiver-sensitive in both Window and WorkerGlobalScope.
    this.key = key; this.fetcher = fetcher.bind(globalThis); this.sleep = sleep; this.timeoutMs = timeoutMs;
  }
  async api(endpoint, body, publish = false) {
    let response, json;
    try {
      response = await this.fetcher(`${BASE}/${publish ? 'v1' : 'v2'}/public/pgc/openApi${endpoint}`, {
        method: 'POST', credentials: 'omit', redirect: 'error',
        headers: {'X-Square-OpenAPI-Key': this.key, 'Content-Type': 'application/json', clienttype: 'binanceSkill'},
        body: JSON.stringify(body), signal: AbortSignal.timeout(this.timeoutMs)
      });
      if (publish && response.status >= 500) throw new PublishUncertainError(`广场返回 HTTP ${response.status}，可能已发布，请先到广场核对`);
      if (!publish && (response.status === 429 || response.status >= 500)) throw new RetryableError(`币安媒体接口暂时不可用（HTTP ${response.status}）`);
      json = await response.json();
    } catch (error) {
      if (publish) throw new PublishUncertainError(error instanceof PublishUncertainError ? error.message : '发布请求已发送，但未收到确定结果，请先到广场核对');
      if (error instanceof RetryableError) throw error;
      if (response) throw new Error(`币安接口返回了无法解析的响应（HTTP ${response.status}），可能是网关或访问限制`);
      if (error?.name === 'TimeoutError' || error?.name === 'AbortError') throw new RetryableError('连接币安接口超时，请检查当前 Chrome 的网络或代理后重试');
      if (String(error?.message).includes('Illegal invocation')) throw new Error('插件请求调用异常，请重新加载最新版本');
      throw new RetryableError('无法连接币安接口，请检查当前 Chrome 的网络、代理及插件的网站访问权限');
    }
    if (json.code !== '000000') {
      if (publish && (typeof json.code !== 'string' || !/^\d+$/.test(json.code))) throw new PublishUncertainError('广场响应格式异常，请先到广场核对');
      throw new ApiRejectedError(`币安 ${json.code ?? response.status}：${json.message ?? '请求未成功'}`);
    }
    if (!response.ok) {
      if (publish) throw new PublishUncertainError('广场响应状态不一致，请先核对');
      throw new Error(`接口 HTTP ${response.status}`);
    }
    return json.data;
  }
  async upload(url, blob, contentType) {
    const dest = new URL(url);
    const allowed = dest.hostname.endsWith('.amazonaws.com') || dest.hostname.endsWith('.bnbstatic.com') || dest.hostname === 'www.binance.com';
    if (dest.protocol !== 'https:' || dest.username || dest.password || dest.port || !allowed) throw new Error('币安返回了尚未授权的媒体上传域名，请更新插件权限后重试');
    let response;
    try { response = await this.fetcher(url, {method: 'PUT', credentials: 'omit', redirect: 'error', headers: {'Content-Type': contentType}, body: blob, signal: AbortSignal.timeout(600000)}); }
    catch { throw new RetryableError('媒体上传连接中断或超时'); }
    if (response.status === 429 || response.status >= 500) throw new RetryableError(`媒体上传暂时失败（HTTP ${response.status}）`);
    if (!response.ok) throw new Error(`媒体上传失败（HTTP ${response.status}）`);
  }
  async poll(fileTicket) {
    const deadline = Date.now() + 300000;
    for (let n = 0; n < 100; n++) {
      if (Date.now() >= deadline) break;
      const data = await this.api('/image/imageStatus', {fileTicket});
      if (data?.status === 1) return data;
      if (data?.status === 2) throw new Error(`媒体处理失败：${data.failedReason ?? '请更换媒体'}`);
      await this.sleep(3000);
    }
    throw new Error('广场媒体处理超过 5 分钟，请稍后重试');
  }
  async image(blob, name) {
    const {presignedUrl, fileTicket} = await this.api('/image/presignedUrl', {imageName: name});
    if (!fileTicket) throw new Error('上传凭据缺失');
    await this.upload(presignedUrl, blob, blob.type);
    const result = await this.poll(fileTicket);
    if (!result.imageUrl) throw new Error('广场未返回处理后的图片');
    return result.imageUrl;
  }
  async video(blob, name) {
    const {presignedUrl, fileTicket} = await this.api('/video/preSign', {fileName: name, size: blob.size});
    if (!fileTicket) throw new Error('上传凭据缺失');
    await this.upload(presignedUrl, blob, 'video/mp4');
    await this.poll(fileTicket);
    return fileTicket;
  }
  publish(body) { return this.api('/content/add', body, true); }
}
