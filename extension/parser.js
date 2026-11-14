/* Only parses successful create-post responses. No timeline discovery or credentials. */
(() => {
  const unwrap = value => value?.tweet ?? value;
  function parse(payload, variables = {}, actor = '') {
    const data = payload?.data;
    const retweet = data?.create_retweet?.retweet_results?.result;
    if (retweet?.rest_id && variables.tweet_id && actor) return {
      id: String(retweet.rest_id), handle: actor,
      text: `转发自 X：\nhttps://x.com/i/status/${variables.tweet_id}`,
      createdAt: Date.now(), capturedAt: Date.now(), media: [], expectedMedia: 0,
      reply: false, quote: false, retweet: true, unsupported: false
    };
    const result = unwrap(data?.create_tweet?.tweet_results?.result
      ?? data?.notetweet_create?.tweet_results?.result
      ?? data?.create_note_tweet?.tweet_results?.result);
    if (!result?.rest_id || !result?.legacy) return null;
    const legacy = result.legacy;
    const user = result.core?.user_results?.result;
    const handle = user?.core?.screen_name ?? user?.legacy?.screen_name;
    if (!handle) return null;
    const note = result.note_tweet?.note_tweet_results?.result;
    let text = typeof variables.tweet_text === 'string' ? variables.tweet_text : note?.text ?? legacy.full_text ?? '';
    const entities = [...(legacy.entities?.urls ?? []), ...(note?.entity_set?.urls ?? [])];
    // Restore links only if using the server's t.co-encoded text.
    if (typeof variables.tweet_text !== 'string') {
      for (const entity of entities) if (entity.url && entity.expanded_url) text = text.split(entity.url).join(entity.expanded_url);
    }
    const rawMedia = legacy.extended_entities?.media ?? legacy.entities?.media ?? [];
    const media = rawMedia.map(item => {
      if (typeof variables.tweet_text !== 'string' && item.url) text = text.split(item.url).join('');
      if (item.type === 'photo') return {type: 'photo', url: item.media_url_https};
      const variants = (item.video_info?.variants ?? [])
        .filter(v => v.content_type === 'video/mp4' && v.url)
        .sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0));
      return {type: item.type, url: variants[0]?.url, cover: item.media_url_https, duration: (item.video_info?.duration_millis ?? 0) / 1000};
    });
    const expectedMedia = Math.max(variables.media?.media_entities?.length ?? 0, rawMedia.length);
    const quotedId = legacy.quoted_status_id_str;
    return {
      id: String(result.rest_id), handle, text: text.trim(), media, expectedMedia,
      createdAt: Date.parse(legacy.created_at), capturedAt: Date.now(),
      reply: Boolean(legacy.in_reply_to_status_id_str || variables.reply?.in_reply_to_tweet_id),
      quote: Boolean(quotedId || legacy.is_quote_status || variables.attachment_url),
      retweet: Boolean(legacy.retweeted_status_result),
      contextUrl: quotedId ? `https://x.com/i/status/${quotedId}` : variables.attachment_url
        ?? (legacy.in_reply_to_status_id_str ? `https://x.com/i/status/${legacy.in_reply_to_status_id_str}` : ''),
      unsupported: Boolean(variables.card_uri || result.card?.legacy?.name?.includes('poll') || result.article),
      sourceUrl: `https://x.com/${handle}/status/${result.rest_id}`
    };
  }
  globalThis.XSquareParser = Object.freeze({parse});
})();
