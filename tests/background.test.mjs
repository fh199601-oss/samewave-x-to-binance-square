import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import * as core from '../extension/lib/core.js';
import {SquareClient} from '../extension/lib/square.js';

function harness(initial = {}, prefix = '', overrides = {}) {
  const data = structuredClone(initial); const listeners = {}; const runs = []; let running = []; let access; let optionsOpened = 0; let exists = true; let probeFails = false;
  const event = name => ({addListener(fn) { listeners[name] = fn; }});
  const chrome = {
    runtime: {id:'test-extension', getURL:x=>`chrome-extension://test-extension/${x}`, getManifest:()=>({background:{service_worker:prefix+'background.js'}}), getContexts:async()=>exists ? [{contextType:'OFFSCREEN_DOCUMENT'}] : [],
      sendMessage:async message=>{
        if(message.type==='RUN'){runs.push(message);running.push({id:message.job.id,runId:message.job.runId});return {ok:true};}
        if(message.type==='STATUS'){if(probeFails)throw new Error('transient message failure');return {ok:true,running};}
      },onMessage:event('message'),onStartup:event('startup'),onInstalled:event('installed'),openOptionsPage:async()=>{optionsOpened++;}},
    storage:{local:{setAccessLevel:async value=>{access=value;},get:async()=>structuredClone(data),set:async value=>{Object.assign(data,structuredClone(value));}}},
    action:{setBadgeText:async()=>{},setBadgeBackgroundColor:async()=>{},onClicked:event('clicked')},
    alarms:{create:async()=>{},onAlarm:event('alarm')},offscreen:{createDocument:async()=>{exists=true;}}
  };
  const context=vm.createContext({chrome,...core,SquareClient:overrides.Client??SquareClient,crypto:webcrypto,URL,Date,setTimeout,clearTimeout});
  vm.runInContext(fs.readFileSync('extension/background.js','utf8').replace(/^import .*;\n/gm,''),context);
  const ui={id:'test-extension',url:chrome.runtime.getURL(prefix+'options.html')};
  const page={id:'test-extension',url:'https://x.com/home',frameId:0,tab:{url:'https://x.com/home',id:1}};
  const offscreen={id:'test-extension',url:chrome.runtime.getURL(prefix+'offscreen.html')};
  const popup={id:'test-extension',url:chrome.runtime.getURL(prefix+'popup.html')};
  const flush=async()=>{for(let n=0;n<6;n++)await new Promise(r=>setImmediate(r));};
  const message=(msg,sender=ui)=>new Promise(resolve=>{
    if(sender===offscreen && msg.runId===undefined)msg={...msg,runId:data.jobs?.find(j=>j.id===msg.id)?.runId};
    listeners.message(msg,sender,result=>{if(sender===offscreen && msg.type==='COMPLETE')running=running.filter(r=>r.runId!==msg.runId);resolve(result);});
  });
  return {data,runs,ui,popup,page,offscreen,message,flush,get access(){return access;},get optionsOpened(){return optionsOpened;},installed(reason){listeners.installed({reason});},tick(){listeners.alarm({name:'recover'});},failStatus(){probeFails=true;},interrupt(){running=[];exists=false;listeners.alarm({name:'recover'});}};
}
function configured(){return {settings:{...core.DEFAULT_SETTINGS,handle:'example',enabled:true,enabledAt:Date.now()-1000},apiKey:'test-api-key-private'};}
function post(id='1999999999999999999'){return {id,handle:'example',text:'测试正文',media:[],expectedMedia:0,createdAt:Date.now(),capturedAt:Date.now()};}
test('background protects storage and never returns API keys to settings or content scripts',async()=>{
  const h=harness(configured()); const view=await h.message({type:'GET_STATE'});
  assert.equal(h.access.accessLevel,'TRUSTED_CONTEXTS');assert.ok(!JSON.stringify(view).includes('test-api-key-private'));
  assert.equal((await h.message({type:'GET_STATE'},h.page)).ok,false);
  assert.equal((await h.message({type:'SAVE_SETTINGS',settings:configured().settings},h.page)).ok,false);
});
test('concurrent duplicate capture queues only one publish attempt',async()=>{
  const h=harness(configured());
  await Promise.all([h.message({type:'CAPTURE',post:post()},h.page),h.message({type:'CAPTURE',post:post()},h.page)]);await h.flush();
  assert.equal(h.data.jobs.length,1);assert.equal(h.runs.length,1);assert.equal(h.data.jobs[0].status,'preparing');
});
test('unexpected origin and iframe capture are rejected',async()=>{
  const h=harness(configured());
  for(const sender of [{...h.page,url:'https://evil.test'},{...h.page,frameId:1},{...h.page,id:'another-extension'}])assert.equal((await h.message({type:'CAPTURE',post:post()},sender)).ok,false);
  assert.equal(h.runs.length,0);
});
test('incomplete media is held without running the upload worker',async()=>{
  const h=harness(configured());await h.message({type:'CAPTURE',post:{...post(),expectedMedia:1}},h.page);await h.flush();
  assert.equal(h.data.jobs[0].status,'failed');assert.equal(h.runs.length,0);
});
test('paused sync refuses the durable publication gate',async()=>{
  const h=harness(configured());await h.message({type:'CAPTURE',post:post()},h.page);await h.flush();
  await h.message({type:'SAVE_SETTINGS',settings:{...configured().settings,enabled:false}});
  assert.equal((await h.message({type:'PUBLISH_GATE',id:post().id},h.offscreen)).ok,false);
  assert.equal(h.data.jobs[0].status,'preparing');
});
test('changing account or key cannot redirect an in-flight job',async()=>{
  const h=harness(configured());await h.message({type:'CAPTURE',post:post()},h.page);await h.flush();
  assert.equal((await h.message({type:'SAVE_SETTINGS',settings:{...configured().settings,handle:'someone'}})).ok,false);
  assert.equal((await h.message({type:'SAVE_SETTINGS',settings:configured().settings,apiKey:'replacement-secret-key'})).ok,false);
  assert.equal((await h.message({type:'REMOVE_KEY'})).ok,false);
});
test('browser interruption before publish requeues; after gate it requires review',async()=>{
  const before=harness(configured());await before.message({type:'CAPTURE',post:post()},before.page);await before.flush();
  before.interrupt();await before.flush();assert.equal(before.runs.length,2);
  const after=harness(configured());await after.message({type:'CAPTURE',post:post()},after.page);await after.flush();
  await after.message({type:'PUBLISH_GATE',id:post().id},after.offscreen);assert.equal(after.data.jobs[0].status,'publishing');
  after.interrupt();await after.flush();assert.equal(after.data.jobs[0].status,'review');assert.equal(after.runs.length,1);
  assert.equal((await after.message({type:'JOB_ACTION',id:post().id,action:'retry'})).ok,false);
});
test('success ledger survives worker restart and suppresses duplicate posts',async()=>{
  const h=harness(configured());await h.message({type:'CAPTURE',post:post()},h.page);await h.flush();
  await h.message({type:'PUBLISH_GATE',id:post().id},h.offscreen);
  await h.message({type:'COMPLETE',id:post().id,status:'sent',squareUrl:'https://www.binance.com/square/post/123'},h.offscreen);
  const restarted=harness(h.data);await restarted.message({type:'CAPTURE',post:post()},restarted.page);await restarted.flush();
  assert.equal(restarted.data.jobs.length,1);assert.equal(restarted.data.jobs[0].status,'sent');assert.equal(restarted.runs.length,0);
});
test('queue is serial and advances only after completion',async()=>{
  const h=harness(configured());await h.message({type:'CAPTURE',post:post()},h.page);
  await h.message({type:'CAPTURE',post:post('1999999999999999998')},h.page);await h.flush();assert.equal(h.runs.length,1);
  await h.message({type:'COMPLETE',id:post().id,status:'failed',error:'upload failed'},h.offscreen);await h.flush();
  assert.equal(h.runs.length,2);assert.equal(h.data.jobs[1].status,'preparing');
});
test('outer folder loading resolves options and offscreen messages to the nested source',async()=>{
  const h=harness(configured(),'extension/');
  assert.equal((await h.message({type:'GET_STATE'},{...h.ui,url:h.ui.url+'#accounts'})).ok,true);
  assert.equal((await h.message({type:'GET_STATE'},{...h.ui,url:'chrome-extension://test-extension/options.html'})).ok,false);
  await h.message({type:'CAPTURE',post:post()},h.page);await h.flush();
  assert.equal((await h.message({type:'PUBLISH_GATE',id:post().id},h.offscreen)).ok,true);
});
test('reload and updates do not open another settings tab',async()=>{
  const h=harness();h.installed('update');await h.flush();assert.equal(h.optionsOpened,0);
  h.installed('chrome_update');await h.flush();assert.equal(h.optionsOpened,0);
  h.installed('install');await h.flush();assert.equal(h.optionsOpened,1);
});
test('popup toggle changes only the enabled setting and never exposes credentials',async()=>{
  const h=harness(configured());const original=structuredClone(h.data.settings);
  const stopped=await h.message({type:'SET_ENABLED',enabled:false},h.popup);
  assert.equal(stopped.ok,true);assert.equal(h.data.settings.enabled,false);assert.equal(h.data.settings.handle,original.handle);
  assert.equal(h.data.settings.syncQuotes,original.syncQuotes);assert.ok(!JSON.stringify(stopped).includes(h.data.apiKey));
  assert.equal((await h.message({type:'SET_ENABLED',enabled:true},h.page)).ok,false);
  assert.equal((await h.message({type:'SAVE_SETTINGS',settings:original},h.popup)).ok,false);
  assert.equal((await h.message({type:'SET_ENABLED',enabled:true},h.popup)).ok,true);
});
test('popup cannot enable before an account and key are configured',async()=>{
  const h=harness();assert.equal((await h.message({type:'SET_ENABLED',enabled:true},h.popup)).ok,false);
});
test('pre-publication transient errors get bounded delayed retries',async()=>{
  const h=harness(configured());await h.message({type:'CAPTURE',post:post()},h.page);await h.flush();
  for(let i=1;i<=4;i++){
    await h.message({type:'COMPLETE',id:post().id,status:'failed',retryable:true,error:'network'},h.offscreen);await h.flush();
    if(i<4){assert.equal(h.data.jobs[0].status,'queued');assert.equal(h.data.jobs[0].autoRetries,i);assert.ok(h.data.jobs[0].nextAttemptAt>Date.now());assert.equal(h.runs.length,i);
      h.data.jobs[0].nextAttemptAt=0;h.tick();await h.flush();assert.equal(h.runs.length,i+1);
    }else assert.equal(h.data.jobs[0].status,'failed');
  }
});
test('publication failures never auto-retry even if marked retryable',async()=>{
  const h=harness(configured());await h.message({type:'CAPTURE',post:post()},h.page);await h.flush();await h.message({type:'PUBLISH_GATE',id:post().id},h.offscreen);
  await h.message({type:'COMPLETE',id:post().id,status:'review',retryable:true,error:'timeout'},h.offscreen);await h.flush();
  assert.equal(h.data.jobs[0].status,'review');assert.equal(h.runs.length,1);
});
test('old worker messages cannot overwrite a later attempt',async()=>{
  const h=harness(configured());await h.message({type:'CAPTURE',post:post()},h.page);await h.flush();const old=h.data.jobs[0].runId;
  await h.message({type:'COMPLETE',id:post().id,status:'failed'},h.offscreen);await h.message({type:'JOB_ACTION',id:post().id,action:'retry'});await h.flush();
  assert.notEqual(h.data.jobs[0].runId,old);assert.equal((await h.message({type:'COMPLETE',id:post().id,runId:old,status:'sent'},h.offscreen)).ok,false);assert.equal(h.data.jobs[0].status,'preparing');
});
test('completion acknowledgement is idempotent',async()=>{
  const h=harness(configured());await h.message({type:'CAPTURE',post:post()},h.page);await h.flush();await h.message({type:'PUBLISH_GATE',id:post().id},h.offscreen);
  const complete={type:'COMPLETE',id:post().id,status:'sent'};
  assert.equal((await h.message(complete,h.offscreen)).ok,true);assert.equal((await h.message(complete,h.offscreen)).ok,true);assert.equal(h.data.jobs[0].status,'sent');
});
test('temporary offscreen probe errors do not start duplicate workers',async()=>{
  const h=harness(configured());await h.message({type:'CAPTURE',post:post()},h.page);await h.flush();h.failStatus();h.tick();await h.flush();
  assert.equal(h.runs.length,1);assert.equal(h.data.jobs[0].status,'preparing');
});
test('changing account with a failed task is rejected until resolved',async()=>{
  const h=harness(configured());await h.message({type:'CAPTURE',post:{...post(),expectedMedia:1}},h.page);await h.flush();
  assert.equal((await h.message({type:'SAVE_SETTINGS',settings:{...configured().settings,handle:'another'}})).ok,false);
});
test('pausing before publish preserves the job for resuming',async()=>{
  const h=harness(configured());await h.message({type:'CAPTURE',post:post()},h.page);await h.flush();await h.message({type:'SET_ENABLED',enabled:false},h.popup);
  assert.equal((await h.message({type:'PUBLISH_GATE',id:post().id},h.offscreen)).paused,true);
  await h.message({type:'COMPLETE',id:post().id,status:'paused'},h.offscreen);await h.flush();assert.equal(h.data.jobs[0].status,'queued');assert.equal(h.runs.length,1);
  await h.message({type:'SET_ENABLED',enabled:true},h.popup);await h.flush();assert.equal(h.runs.length,2);
});
test('API connection checks do not block captures or overwrite newer queue state',async()=>{
  let resolve;class SlowClient{api(){return new Promise(r=>{resolve=r;});}}
  const h=harness(configured(),'',{Client:SlowClient});const checking=h.message({type:'CHECK_KEY'});await h.flush();
  await h.message({type:'CAPTURE',post:post()},h.page);await h.flush();assert.equal(h.runs.length,1);
  await h.message({type:'SET_ENABLED',enabled:false},h.popup);
  resolve({fileTicket:'ticket',presignedUrl:'https://bucket.s3.amazonaws.com/test'});assert.equal((await checking).ok,true);
  assert.equal(h.data.jobs.length,1);assert.equal(h.data.settings.enabled,false);assert.equal(h.data.connectionCheck.status,'success');
});
