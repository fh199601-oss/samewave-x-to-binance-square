import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
function bridge(send){
  let handler,warnings=0;const window={addEventListener(name,fn){if(name==='message')handler=fn;}};
  const element=()=>({style:{},attachShadow(){return {append(){}};},setAttribute(){},append(){},remove(){}});
  const document={body:{append(){warnings++;}},getElementById(){return warnings?{}:null;},createElement:element};
  vm.runInNewContext(fs.readFileSync('extension/bridge.js','utf8'),{window,document,location:{origin:'https://x.com'},chrome:{runtime:{sendMessage:send}},setTimeout:fn=>{queueMicrotask(fn);return 1;}});
  const emit=()=>handler({source:window,origin:'https://x.com',data:{channel:'x-square-created-v1',post:{id:'123',text:'hello'}}});
  const flush=async()=>{for(let i=0;i<6;i++)await new Promise(r=>setImmediate(r));};
  return {emit,flush,get warnings(){return warnings;}};
}
test('content bridge retries transient delivery failure and suppresses simultaneous duplicates',async()=>{
  let calls=0;const b=bridge(async()=>{if(++calls===1)throw new Error('worker restarting');return {ok:true};});b.emit();b.emit();await b.flush();assert.equal(calls,2);assert.equal(b.warnings,0);
});
test('stale extension contexts show a warning instead of silently losing captures',async()=>{
  let calls=0;const b=bridge(async()=>{calls++;throw new Error('Extension context invalidated');});b.emit();await b.flush();assert.equal(calls,1);assert.equal(b.warnings,1);
});
