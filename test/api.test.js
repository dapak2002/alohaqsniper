import test from 'node:test';
import assert from 'node:assert/strict';
import {AlohaQApi,parseDay,timeSlot,calendarLimit,catalogServices} from '../src/alohaq-api.js';
import {Scanner} from '../src/scanner.js';
import {hstDay} from '../src/shared.js';
const response=(data,status=200,headers={})=>new Response(JSON.stringify(data),{status,headers});
const service={service_id:'146',service_name:'**MOTOR VEHICLES & Other Services**',enable:'1',appt_enabled:'1',service_appt_available:1};
const catalog={ALAM:{location_id:'ALAM',appt_available:1,max_appt_date:'2027-02-15',services:{146:service}}};

test('API sends exact availability parameters and converts 24h slots to HST',async()=>{
  const calls=[];
  const api=new AlohaQApi({spacing:0,fetchImpl:async(url,options)=>{calls.push([url,options]);return response(calls.length===1?{msg:'success',data:['11/2/2026','11/2/2026','11/4/2026']}:['14:45:00','15:00:00']);}});
  assert.deepEqual(await api.dates('ALAM','146','2026-10-19','2026-11-02'),['2026-11-02']);
  assert.equal(calls[0][0].pathname,'/wrk_availability.php');
  assert.deepEqual(Object.fromEntries(calls[0][0].searchParams),{l:'ALAM',s:'146',d:'2026-10-19',m:'2026-11-02',t:'all'});
  const times=await api.times('ALAM','146','2026-11-02');
  assert.equal(times[0].time,'2:45 PM HST');
  assert.equal(times[0].epoch,Date.parse('2026-11-03T00:45:00Z'));
  assert.equal(calls[1][0].pathname,'/wrk_get_availability.php');
});
test('catalog POST is read-only and excludes disabled/alternative services',async()=>{
  const api=new AlohaQApi({fetchImpl:async(url,options)=>{assert.equal(url.pathname,'/wrk_est_time_1.php');assert.equal(options.method,'POST');assert.equal(options.body,'category=1&kiosk=false&locations=');return response(catalog);}});
  const data=await api.catalog();
  data.ALAM.services[165]={...service,service_id:'165',service_appt_available:0.5};
  assert.deepEqual(catalogServices(data,'ALAM').map(s=>s.disabled),[false,true]);
});
test('invalid API data is rejected, not presented as no appointments',async()=>{
  for(const data of [{msg:'error',data:[]},{msg:'success',data:['02/30/2026']},'<html>']) {
    const api=new AlohaQApi({fetchImpl:async()=>response(data)});
    await assert.rejects(api.dates('ALAM','146','2026-01-01','2026-12-31'));
  }
  assert.throws(()=>parseDay('2026-11-02'));
  assert.throws(()=>timeSlot('2026-11-02','25:00:00'));
});
test('documented live empty-range response is a successful empty scan',async()=>{
  const api=new AlohaQApi({fetchImpl:async()=>response({msg:'none',data:[]})});
  assert.deepEqual(await api.dates('ALAM','146','2026-10-19','2026-10-23'),[]);
});
test('holiday/weekend limit matches the client extension algorithm',()=>{
  assert.equal(calendarLimit('2026-10-19','2026-10-26',new Set()),'2026-10-28');
  assert.equal(calendarLimit('2026-10-19','2026-10-26',new Set(['2026-10-27'])),'2026-10-29');
});
test('one bounded retry honors Retry-After and cancellation',async()=>{
  let calls=0;const delays=[];
  const api=new AlohaQApi({spacing:0,pause:async ms=>delays.push(ms),fetchImpl:async()=>++calls===1?response({},429,{'retry-after':'2'}):response({msg:'success',data:[]})});
  await api.dates('ALAM','146','2026-10-19','2026-11-02');
  assert.equal(calls,2);assert.ok(delays.includes(2000));
  const controller=new AbortController();controller.abort();
  await assert.rejects(new AlohaQApi({signal:controller.signal,fetchImpl:async()=>{throw new Error('must not fetch');}}).catalog(),{name:'AbortError'});
});
test('scanner collects every API time and preserves partial results on failure',async()=>{
  const day=hstDay(Date.now()+86400000), next=hstDay(Date.now()+2*86400000);
  const fixture=structuredClone(catalog);fixture.ALAM.max_appt_date=next;
  const scanner=new Scanner(()=>{},()=>({requests:4,catalog:async()=>fixture,holidays:async()=>new Set(),dates:async()=>[day,next],times:async(code,key,d)=>{if(d===next)throw new Error('Test timeout');return [timeSlot(day,'09:00:00'),timeSlot(day,'10:00:00')];}}));
  scanner.start({order:['ala-moana'],enabled:['ala-moana'],scope:'motor',startDate:hstDay(Date.now()),endDate:hstDay(Date.now()+29*86400000)});await scanner.task;
  assert.equal(scanner.state.status,'partial');assert.equal(scanner.state.slots.length,2);assert.equal(scanner.state.errors.length,1);assert.equal(scanner.state.services[0].status,'partial');
});
test('stopping an API scan cancels in-flight requests without losing collected data',async()=>{
  let entered;const waiting=new Promise(r=>entered=r);
  const scanner=new Scanner(()=>{},({signal})=>({requests:1,catalog:()=>new Promise((resolve,reject)=>{entered();signal.addEventListener('abort',()=>reject(signal.reason),{once:true});})}));
  scanner.start({order:['ala-moana'],enabled:['ala-moana'],scope:'motor',startDate:hstDay(Date.now()),endDate:hstDay(Date.now()+29*86400000)});await waiting;await scanner.stop();await scanner.task;
  assert.equal(scanner.state.status,'cancelled');assert.equal(scanner.state.errors.length,0);
});

test('scanner sends chosen start/end dates and excludes out-of-range days',async()=>{
  const today=hstDay(Date.now()), start=hstDay(Date.now()+5*86400000), end=hstDay(Date.now()+7*86400000), later=hstDay(Date.now()+8*86400000);
  const fixture=structuredClone(catalog);fixture.ALAM.max_appt_date=later;
  const checked=[];
  const scanner=new Scanner(()=>{},()=>({requests:3,catalog:async()=>fixture,holidays:async()=>new Set(),dates:async(code,key,a,b)=>{assert.equal(a,start);assert.equal(b,end);return [today,start,end,later];},times:async(code,key,day)=>{checked.push(day);return [timeSlot(day,'09:00:00')];}}));
  scanner.start({order:['ala-moana'],enabled:['ala-moana'],scope:'motor',startDate:start,endDate:end});await scanner.task;
  assert.equal(scanner.state.status,'complete');assert.deepEqual(checked,[start,end]);assert.equal(scanner.state.slots.length,2);
});

test('single-service search queries only the selected service',async()=>{
  const day=hstDay(Date.now()+86400000),fixture=structuredClone(catalog),calls=[];
  fixture.ALAM.max_appt_date=day;
  fixture.ALAM.services[235]={...service,service_id:'235',service_name:'Disability Parking Permits',service_type:'MV'};
  const scanner=new Scanner(()=>{},()=>({requests:0,catalog:async()=>fixture,holidays:async()=>new Set(),dates:async(code,key)=>{calls.push(key);return [day];},times:async()=>[timeSlot(day,'09:00:00')]}));
  scanner.start({order:['ala-moana'],enabled:['ala-moana'],scope:'all',serviceKey:'235',startDate:day,endDate:day});await scanner.task;
  assert.deepEqual(calls,['235']);assert.equal(scanner.state.slots[0].serviceKey,'235');
});
