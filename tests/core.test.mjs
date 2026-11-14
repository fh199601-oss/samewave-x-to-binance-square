import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {DEFAULT_SETTINGS, normalizePost, eligibility, validateMedia, publishText, safeError, httpsUrl} from '../extension/lib/core.js';
const now = Date.now();
const post = {id:'1999999999999999999',handle:'example',text:'你好 #BTC $BNB',media:[],expectedMedia:0,createdAt:now,capturedAt:now};
const settings = {...DEFAULT_SETTINGS, handle:'example',enabled:true,enabledAt:now - 1000};
test('shareable defaults contain no account and start disabled', () => { assert.equal(DEFAULT_SETTINGS.handle, ''); assert.equal(DEFAULT_SETTINGS.enabled, false); });
test('only the configured account can sync', () => { assert.equal(eligibility(post, settings), ''); assert.equal(eligibility({...post,handle:'someone'}, settings),'其他账号'); });
test('switch and timestamp prevent backfill', () => {
  assert.ok(eligibility(post, {...settings,enabled:false}));
  assert.ok(eligibility({...post,createdAt:now-3600000},settings));
  assert.ok(eligibility({...post,createdAt:NaN},settings));
  assert.ok(eligibility({...post,createdAt:now+3600000},settings));
});
for (const [kind, option] of [['reply','syncReplies'],['quote','syncQuotes'],['retweet','syncReposts']]) test(`${kind} is an independent opt-in`, () => {
  assert.ok(eligibility({...post,[kind]:true},settings));
  assert.equal(eligibility({...post,[kind]:true},{...settings,[option]:true}),'');
});
test('original, image and video filters skip whole posts', () => {
  assert.ok(eligibility(post,{...settings,syncOriginals:false}));
  assert.ok(eligibility(post,{...settings,syncText:false}));
  assert.ok(eligibility({...post,media:[{type:'photo'}]}, {...settings,syncImages:false}));
  assert.ok(eligibility({...post,media:[{type:'video'}]}, {...settings,syncVideos:false}));
});
test('normalization drops page-supplied destinations', () => {
  const p=normalizePost({...post,sourceUrl:'https://evil.test',contextUrl:'javascript:alert(1)'});
  assert.equal(p.sourceUrl, `https://x.com/example/status/${post.id}`); assert.equal(p.contextUrl,'');
});
test('media cannot silently disappear or target a non-CDN URL', () => {
  assert.throws(()=>validateMedia({...post,expectedMedia:1}),/完整媒体/);
  assert.throws(()=>validateMedia({...post,expectedMedia:1,media:[{type:'photo',url:'https://pbs.twimg.com.evil.test/photo'}]}),/图片地址/);
  assert.throws(()=>validateMedia({...post,expectedMedia:2,media:[{type:'video'},{type:'photo'}]}),/混发/);
  assert.throws(()=>validateMedia({...post,unsupported:true}),/投票/);
});
test('valid image and video URLs pass', () => {
  validateMedia({...post,expectedMedia:1,media:[{type:'photo',url:'https://pbs.twimg.com/media/image.jpg'}]});
  validateMedia({...post,expectedMedia:1,media:[{type:'video',url:'https://video.twimg.com/video.mp4',cover:'https://pbs.twimg.com/cover.jpg',duration:0}]});
});
test('text preserves hashtags, cashtags, and optional provenance', () => {
  const p=normalizePost(post); assert.equal(publishText(p,settings),post.text);
  assert.ok(publishText({...p,quote:true,contextUrl:'https://x.com/i/status/123'},settings).endsWith('引用：https://x.com/i/status/123'));
  assert.ok(publishText(p,{...settings,appendSource:true}).endsWith(p.sourceUrl));
});
test('URL validation rejects embedded credentials, HTTP, and nonstandard port', () => {
  for(const url of ['http://pbs.twimg.com/a','https://user:pass@pbs.twimg.com/a','https://pbs.twimg.com:8443/a','https://127.0.0.1/a']) assert.equal(httpsUrl(url,['pbs.twimg.com']),false);
});
test('errors redact keys and signed URLs', () => { const s=safeError(new Error('key secret-key https://host/path?token=a'),'secret-key'); assert.ok(!s.includes('secret-key')); assert.ok(!s.includes('token=a')); });
const context = vm.createContext({Date,URL}); vm.runInContext(fs.readFileSync('extension/parser.js','utf8'),context);
const parse=context.XSquareParser.parse;
const result = {rest_id:post.id,legacy:{full_text:'原文 https://t.co/link',created_at:new Date(now).toUTCString(),entities:{urls:[{url:'https://t.co/link',expanded_url:'https://example.com/a'}]}},core:{user_results:{result:{legacy:{screen_name:'example'}}}}};
const payload = r=>({data:{create_tweet:{tweet_results:{result:r}}}});
test('parser ignores timeline and unsuccessful responses', () => { assert.equal(parse({errors:[{}]}),null); assert.equal(parse({data:{user:{tweets:[result]}}}),null); });
test('successful CreateTweet extracts the authenticated author and exact submitted text', () => {
  const p=parse(payload(result),{tweet_text:'原文 #话题 $BNB'}); assert.equal(p.handle,'example'); assert.equal(p.text,'原文 #话题 $BNB');
});
test('server fallback expands t.co URLs',()=>{assert.equal(parse(payload(result)).text,'原文 https://example.com/a');});
test('long posts prefer full note text and wrapped result', () => {
  const r={...result,note_tweet:{note_tweet_results:{result:{text:'完整长文'}}}};
  assert.equal(parse({data:{notetweet_create:{tweet_results:{result:{tweet:r}}}}}).text,'完整长文');
});
test('modern X user core schema is supported', () => {
  const r={...result,core:{user_results:{result:{core:{screen_name:'modern'}}}}}; assert.equal(parse(payload(r)).handle,'modern');
});
test('parser chooses the best available MP4, not HLS', () => {
  const r=structuredClone(result); r.legacy.extended_entities={media:[{type:'video',media_url_https:'https://pbs.twimg.com/c.jpg',video_info:{duration_millis:12000,variants:[{content_type:'application/x-mpegURL',url:'hls'},{content_type:'video/mp4',url:'low',bitrate:100},{content_type:'video/mp4',url:'high',bitrate:900}]}}]};
  const p=parse(payload(r)); assert.equal(p.media[0].url,'high'); assert.equal(p.media[0].duration,12);
});
test('request media count protects against incomplete X responses', () => { const p=parse(payload(result),{tweet_text:'photo',media:{media_entities:[{media_id:'1'}]}}); assert.equal(p.expectedMedia,1); assert.throws(()=>validateMedia(p)); });
test('reposts produce attributed source links and require an actor', () => {
  const data={data:{create_retweet:{retweet_results:{result:{rest_id:post.id}}}}};
  const p=parse(data,{tweet_id:'1234567890123456789'},'example'); assert.equal(p.retweet,true); assert.ok(p.text.includes('https://x.com/i/status/1234567890123456789')); assert.equal(parse(data,{tweet_id:'123'}),null);
});
