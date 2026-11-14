import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
function popup({configured=true,failToggle=false}={}){
  const state={settings:{handle:'example',enabled:true,syncQuotes:false},hasKey:configured,jobs:[{status:'sent'}]};
  const elements=new Map();const el=id=>{if(!elements.has(id))elements.set(id,{});return elements.get(id);};
  const calls=[];let onChanged;
  const chrome={runtime:{id:'test',openOptionsPage(){},async sendMessage(m){calls.push(m);if(m.type==='SET_ENABLED'){if(failToggle)return {ok:false,error:'storage failed'};state.settings.enabled=m.enabled;}return {ok:true,state:structuredClone(state)};}},storage:{onChanged:{addListener(fn){onChanged=fn;}}}};
  vm.runInNewContext(fs.readFileSync('extension/popup.js','utf8'),{chrome,document:{getElementById:el},window:{close(){}}});
  const flush=async()=>{for(let i=0;i<3;i++)await new Promise(r=>setImmediate(r));};
  return {el,calls,state,flush,change(){onChanged();}};
}
test('popup toggle pauses and resumes with no settings-page navigation',async()=>{
  const p=popup();await p.flush();assert.equal(p.el('enabled').checked,true);p.el('enabled').checked=false;await p.el('enabled').onchange();
  assert.equal(p.state.settings.enabled,false);assert.equal(p.el('status').textContent,'已暂停');assert.equal(p.state.settings.syncQuotes,false);
  p.el('enabled').checked=true;await p.el('enabled').onchange();assert.equal(p.el('status').textContent,'同步已开启');assert.equal(p.el('enabled').disabled,false);
});
test('popup reverts the switch if saving fails',async()=>{
  const p=popup({failToggle:true});await p.flush();p.el('enabled').checked=false;await p.el('enabled').onchange();assert.equal(p.el('enabled').checked,true);assert.equal(p.el('feedback').textContent,'storage failed');
});
test('popup reacts to settings changed from the workbench',async()=>{
  const p=popup();await p.flush();p.state.settings.enabled=false;p.change();await p.flush();assert.equal(p.el('enabled').checked,false);assert.equal(p.el('sent').textContent,1);
});
test('unconfigured popup disables the sync switch',async()=>{
  const p=popup({configured:false});await p.flush();assert.equal(p.el('enabled').disabled,true);assert.ok(p.el('toggleHint').textContent.includes('配置'));
});
