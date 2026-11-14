import test from 'node:test';
import assert from 'node:assert/strict';
import {SquareClient,PublishUncertainError} from '../extension/lib/square.js';
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
test('native fetch is called with the browser global receiver',async()=>{
  let calls=0;
  function browserFetch(){if(this!==globalThis)throw new TypeError('Illegal invocation');calls++;return Promise.resolve(json({code:'000000',data:{fileTicket:'t'}}));}
  const client=new SquareClient('test',{fetcher:browserFetch});
  await client.api('/image/presignedUrl',{imageName:'test.png'});assert.equal(calls,1);
});
test('network errors, timeout and gateway responses are distinguished',async()=>{
  await assert.rejects(new SquareClient('k',{fetcher:async()=>{throw new TypeError('Failed to fetch');}}).api('/check',{}),/网络、代理及插件的网站访问权限/);
  await assert.rejects(new SquareClient('k',{fetcher:async()=>{throw new DOMException('timeout','TimeoutError');}}).api('/check',{}),/超时/);
  await assert.rejects(new SquareClient('k',{fetcher:async()=>new Response('<html>denied</html>',{status:403})}).api('/check',{}),/HTTP 403/);
});
test('publish uses official v1 endpoint and key only in the auth header',async()=>{
  const requests=[]; const c=new SquareClient('test-key',{fetcher:async(url,init)=>{requests.push({url,init});return json({code:'000000',data:{id:'123'}});}});
  assert.equal((await c.publish({contentType:1,bodyTextOnly:'hello'})).id,'123');
  assert.equal(requests.length,1);assert.ok(requests[0].url.includes('/v1/public/pgc/openApi/content/add'));
  assert.equal(requests[0].init.headers['X-Square-OpenAPI-Key'],'test-key'); assert.equal(requests[0].init.credentials,'omit');assert.equal(requests[0].init.redirect,'error');
});
for(const status of [500,502,503,504])test(`HTTP ${status} publish stays uncertain and never retries`,async()=>{
  let calls=0;const c=new SquareClient('test-key',{fetcher:async()=>{calls++;return new Response('',{status});}});
  await assert.rejects(c.publish({}),PublishUncertainError);assert.equal(calls,1);
});
test('network failure and malformed publish responses require reconciliation',async()=>{
  for(const fetcher of [async()=>{throw new Error('network');},async()=>new Response('unexpected'),async()=>json({})]) await assert.rejects(new SquareClient('k',{fetcher}).publish({}),PublishUncertainError);
});
test('explicit API rejection reports its code',async()=>{await assert.rejects(new SquareClient('k',{fetcher:async()=>json({code:'220004',message:'expired'})}).publish({}),/220004/);});
test('image upload follows presign, PUT, processing and returns processed URL',async()=>{
  const calls=[];let poll=0;const c=new SquareClient('test-key',{sleep:async()=>{},fetcher:async(url,init)=>{
    calls.push({url,init});
    if(url.endsWith('/image/presignedUrl'))return json({code:'000000',data:{presignedUrl:'https://bucket.s3.amazonaws.com/object',fileTicket:'ticket'}});
    if(init.method==='PUT')return new Response('',{status:200});
    if(url.endsWith('/image/imageStatus'))return json({code:'000000',data:++poll===1?{status:0}:{status:1,imageUrl:'https://static.bnbstatic.com/ready.jpg'}});
    throw new Error('unexpected');
  }});
  assert.equal(await c.image(new Blob(['abc'],{type:'image/jpeg'}),'a.jpg'),'https://static.bnbstatic.com/ready.jpg');
  assert.equal(calls[1].init.headers['X-Square-OpenAPI-Key'],undefined);assert.equal(calls[1].init.headers['Content-Type'],'image/jpeg');assert.equal(poll,2);
});
test('video upload sends file size and returns fileTicket',async()=>{
  let body;const c=new SquareClient('k',{fetcher:async(url,init)=>{
    if(url.endsWith('/video/preSign')){body=JSON.parse(init.body);return json({code:'000000',data:{presignedUrl:'https://bucket.s3.amazonaws.com/object',fileTicket:'video-ticket'}});}
    if(init.method==='PUT')return new Response('',{status:200});
    return json({code:'000000',data:{status:1}});
  }});assert.equal(await c.video(new Blob(['abcd']),'a.mp4'),'video-ticket');assert.deepEqual(body,{fileName:'a.mp4',size:4});
});
test('media upload cannot send blobs or keys to arbitrary hosts',async()=>{
  let calls=0;const c=new SquareClient('key',{fetcher:async()=>{calls++;}});
  for(const url of ['https://evil.test/file','http://bucket.s3.amazonaws.com/file','https://bucket.s3.amazonaws.com.evil.test/file','https://localhost/file'])await assert.rejects(c.upload(url,new Blob(['a']),'video/mp4'));
  assert.equal(calls,0);
});
