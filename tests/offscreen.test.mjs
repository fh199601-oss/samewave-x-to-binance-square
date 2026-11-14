import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as core from '../extension/lib/core.js';
import {RetryableError, ApiRejectedError, PublishUncertainError} from '../extension/lib/square.js';
function harness({publishError, imageError, pause=false, lostAcks=0}={}){
  const messages=[],published=[],images=[],videos=[];
  class Client{
    sleep=async()=>{};
    async image(blob,name){if(imageError)throw imageError;images.push({blob,name});return 'https://static.bnbstatic.com/image.jpg';}
    async video(blob,name){videos.push({blob,name});return 'video-ticket';}
    async publish(body){published.push(body);if(publishError)throw publishError;return {id:'123'};}
  }
  const chrome={runtime:{id:'extension',onMessage:{addListener(){}},async sendMessage(m){messages.push(structuredClone(m));if(m.type==='PUBLISH_GATE'&&pause)return {ok:false,paused:true};if(m.type==='COMPLETE'&&lostAcks-->0)throw new Error('ack lost');return {ok:true};}}};
  const context=vm.createContext({chrome,...core,SquareClient:Client,RetryableError,ApiRejectedError,URL,Blob,Response,AbortSignal,Date,setInterval,clearInterval,setTimeout,clearTimeout,
    fetch:async url=>new Response('media',{headers:{'content-type':String(url).includes('video.twimg.com')?'video/mp4':'image/jpeg'}})});
  vm.runInContext(fs.readFileSync('extension/offscreen.js','utf8').replace(/^import .*;\n/gm,''),context);
  const job={id:'1999999999999999999',runId:'run-1',handle:'example',text:'hello',media:[],expectedMedia:0};
  return {messages,published,images,videos,run:overrides=>context.run({...job,...overrides},'test-key')};
}
test('text pipeline publishes once and includes the attempt token in every message',async()=>{
  const h=harness();await h.run();assert.equal(h.published.length,1);assert.equal(h.published[0].contentType,1);assert.equal(h.messages.at(-1).status,'sent');assert.ok(h.messages.every(m=>m.runId==='run-1'));
});
test('video pipeline uploads MP4 and cover before publication',async()=>{
  const h=harness();await h.run({expectedMedia:1,media:[{type:'video',url:'https://video.twimg.com/test.mp4',cover:'https://pbs.twimg.com/cover.jpg',duration:12}]});
  assert.equal(h.videos.length,1);assert.equal(h.images.length,1);assert.equal(h.published[0].contentType,3);assert.equal(h.published[0].fileTicket,'video-ticket');assert.equal(h.published[0].videoTimeSeconds,12);assert.equal(h.messages.at(-1).status,'sent');
});
test('pause at publication gate prevents posting and retains the queued job',async()=>{
  const h=harness({pause:true});await h.run();assert.equal(h.published.length,0);assert.equal(h.messages.at(-1).status,'paused');
});
test('transient media failure is retryable before publishing',async()=>{
  const h=harness({imageError:new RetryableError('network')});await h.run({expectedMedia:1,media:[{type:'photo',url:'https://pbs.twimg.com/media/test.jpg'}]});
  assert.equal(h.published.length,0);assert.equal(h.messages.at(-1).retryable,true);assert.equal(h.messages.at(-1).status,'failed');
});
test('uncertain publish is not repeated and requires review',async()=>{
  const h=harness({publishError:new PublishUncertainError('timeout')});await h.run();assert.equal(h.published.length,1);assert.equal(h.messages.at(-1).status,'review');assert.equal(h.messages.at(-1).retryable,false);
});
test('explicit publish rejection is failed without automatic retry',async()=>{
  const h=harness({publishError:new ApiRejectedError('not allowed')});await h.run();assert.equal(h.published.length,1);assert.equal(h.messages.at(-1).status,'failed');assert.equal(h.messages.at(-1).retryable,false);
});
test('lost result acknowledgements retry only the result message',async()=>{
  const h=harness({lostAcks:2});await h.run();assert.equal(h.published.length,1);const outcomes=h.messages.filter(m=>m.type==='COMPLETE');assert.equal(outcomes.length,3);assert.ok(outcomes.every(m=>m.status==='sent'));
});
