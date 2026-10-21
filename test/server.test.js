import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {request} from 'node:http';
import {once} from 'node:events';

test('hosted server isolates sessions and validates HTTPS origins',async(t)=>{
 const child=spawn(process.execPath,['src/server.js'],{env:{...process.env,PORT:'4329',APP_ORIGIN:'https://sniper.example'},stdio:['ignore','pipe','pipe']});
 t.after(async()=>{child.kill('SIGTERM');await once(child,'exit');});
 await Promise.race([once(child.stdout,'data'),once(child,'exit').then(()=>{throw Error('Server exited before startup');})]);
 const call=(path,{cookie,origin,body,host='sniper.example'}={})=>new Promise((resolve,reject)=>{
   const req=request({hostname:'127.0.0.1',port:4329,path,method:body?'POST':'GET',headers:{host,...(cookie?{cookie}:{}),...(origin?{origin}:{}),'Content-Type':'application/json'}},res=>{
    let text='';res.on('data',d=>text+=d);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,text,json:()=>JSON.parse(text)}));
   });req.on('error',reject);req.end(body?JSON.stringify(body):undefined);
 });
 const a=await call('/api/state'),b=await call('/api/state');assert.equal(a.status,200);
 const ac=a.headers['set-cookie'][0].split(';')[0],bc=b.headers['set-cookie'][0].split(';')[0];
 assert.notEqual(ac,bc);assert.match(a.headers['set-cookie'][0],/Secure/);
 const original=a.json(),next={...original.settings,enabled:[original.locations[1].id]};
 assert.equal((await call('/api/settings',{cookie:ac,origin:'https://sniper.example',body:next})).status,200);
 assert.deepEqual((await call('/api/state',{cookie:ac})).json().settings.enabled,next.enabled);
 assert.deepEqual((await call('/api/state',{cookie:bc})).json().settings.enabled,original.settings.enabled);
 assert.equal((await call('/api/release-stop',{cookie:ac,origin:'https://evil.example',body:{}})).status,403);
 assert.equal((await call('/api/state',{host:'evil.example'})).status,403);
 assert.equal((await call('/health',{host:'healthcheck.railway.app'})).status,200);
 for(const path of ['/','/express','/assets/favicon.png'])assert.equal((await call(path)).status,200);
});
