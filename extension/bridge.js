(() => {
  const inFlight = new Map();
  function warn() {
    if (document.getElementById('samewave-capture-warning')) return;
    if (!document.body) { window.addEventListener('DOMContentLoaded', warn, {once: true}); return; }
    const box = document.createElement('div'); box.id = 'samewave-capture-warning';
    Object.assign(box.style, {position: 'fixed', bottom: '24px', left: '24px', zIndex: '2147483647', maxWidth: '360px'});
    const shadow = box.attachShadow({mode: 'closed'});
    const content = document.createElement('div'); content.setAttribute('role', 'status');
    Object.assign(content.style, {background: '#fff5d5', color: '#574820', border: '1px solid #e8d38d', borderRadius: '12px', padding: '16px', font: '13px/1.8 sans-serif', boxShadow: '0 4px 20px #0002'});
    content.textContent = '同频暂未确认这条帖子的入队结果。请检查插件同步记录；若刚更新插件，请刷新 X 页面。';
    const close = document.createElement('button'); close.textContent = '知道了'; close.onclick = () => box.remove();
    Object.assign(close.style, {display: 'block', marginTop: '10px', background: '#edc450', border: '0', borderRadius: '6px', padding: '5px 12px', cursor: 'pointer'});
    content.append(close); shadow.append(content); document.body.append(box);
  }
  async function deliver(message) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const result = await chrome.runtime.sendMessage(message);
        if (result?.ok) return;
        if (result?.error) break;
      } catch (error) { if (String(error.message).includes('Extension context invalidated')) break; }
      if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
    }
    warn();
  }
  window.addEventListener('message', event => {
    if (event.source !== window || event.origin !== location.origin || event.data?.channel !== 'x-square-created-v1') return;
    const {post, diagnostic} = event.data;
    if (post && (typeof post.text !== 'string' || post.text.length > 100000)) return;
    const id = post?.id || 'diagnostic';
    if (inFlight.has(id)) return;
    const pending = deliver({type: 'CAPTURE', post, diagnostic}).finally(() => inFlight.delete(id));
    inFlight.set(id, pending);
  });
})();
