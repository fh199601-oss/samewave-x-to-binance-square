(() => {
  if (globalThis.__xSquareHook) return;
  globalThis.__xSquareHook = true;
  const channel = 'x-square-created-v1';
  function isCreate(raw, method) {
    try {
      const url = new URL(raw, location.href);
      return method?.toUpperCase() === 'POST'
        && ['x.com', 'www.x.com', 'api.x.com', 'twitter.com', 'api.twitter.com'].includes(url.hostname)
        && /\/graphql\/[^/]+\/(CreateTweet|CreateNoteTweet|CreateRetweet)$/.test(url.pathname);
    } catch { return false; }
  }
  function variables(body) {
    try { return JSON.parse(body).variables ?? {}; } catch { return {}; }
  }
  function actorHandle() {
    const href = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]')?.getAttribute('href') ?? '';
    return /^\/[A-Za-z0-9_]{1,15}\/?$/.test(href) ? href.replaceAll('/', '') : '';
  }
  function deliver(payload, body, actor) {
    try {
      const post = globalThis.XSquareParser.parse(payload, variables(body), actor);
      if (post) window.postMessage({channel, post}, location.origin);
      else window.postMessage({channel, diagnostic: 'X 已响应发帖请求，但插件未识别完整帖子。请检查同步记录；可能需要适配新版 X。'}, location.origin);
    } catch { /* Never interfere with X posting. */ }
  }
  const originalFetch = window.fetch;
  window.fetch = function(input, init) {
    const url = typeof input === 'string' || input instanceof URL ? String(input) : input?.url;
    const method = init?.method ?? input?.method ?? 'GET';
    let body = Promise.resolve(init?.body);
    const tracked = isCreate(url, method);
    const actor = tracked ? actorHandle() : '';
    if (tracked && init?.body === undefined && input instanceof Request) body = input.clone().text().catch(() => '');
    const result = originalFetch.apply(this, arguments);
    if (tracked) result.then(response => {
      if (response.ok) Promise.all([response.clone().json(), body]).then(([json, requestBody]) => deliver(json, requestBody, actor)).catch(() => {});
    }).catch(() => {});
    return result;
  };
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  const trackedRequests = new WeakMap();
  XMLHttpRequest.prototype.open = function(method, url) {
    trackedRequests.set(this, isCreate(url, method));
    return originalOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function(body) {
    const actor = trackedRequests.get(this) ? actorHandle() : '';
    if (trackedRequests.get(this)) this.addEventListener('load', () => {
      if (this.status < 200 || this.status >= 300) return;
      try { deliver(this.responseType === 'json' ? this.response : JSON.parse(this.responseText), body, actor); } catch {}
    }, {once: true});
    return originalSend.apply(this, arguments);
  };
})();
