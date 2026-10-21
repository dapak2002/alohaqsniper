import {hstDay, sortAppointments, scanRange, releaseWindow} from '/shared.js';
const $=id=>document.getElementById(id);
const isExpress=document.body.dataset.page==='express';
const confirmationNotice='This external tool does not send text confirmations. Please verify your appointment on the official AlohaQ site using the ticket-details link below.';
const headerMenus=[...document.querySelectorAll('.header-menu')];
for(const menu of headerMenus)menu.addEventListener('toggle',()=>{if(menu.open)for(const other of headerMenus)if(other!==menu)other.open=false;});
document.addEventListener('click',e=>{for(const menu of headerMenus)if(!menu.contains(e.target))menu.open=false;});
document.addEventListener('keydown',e=>{if(e.key==='Escape')for(const menu of headerMenus)if(menu.open){menu.open=false;menu.querySelector('summary').focus();}});

const escape=text=>String(text).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const serviceName=name=>name.replace(/\*+/g,'').replace(/\s+/g,' ').trim();
function serviceLabel(name){
  const clean=serviceName(name);
  if(/MOTOR VEHICLES.*Other Services/i.test(clean))return 'Motor vehicles & other services';
  if(/U\.S\. PASSPORT/i.test(clean))return 'U.S. passport — new applications';
  if(/DISABILITY PARKING/i.test(clean))return /HOLO/i.test(clean)?'Disability parking permits & HOLO':'Disability parking permits';
  return clean;
}
function locationServiceSummary(services){
  const labels=new Set();
  for(const service of services.filter(s=>!s.disabled)){
    const name=service.name;
    if(/MOTOR VEHICLES/i.test(name))labels.add('Motor vehicles');
    if(/PASSPORT/i.test(name))labels.add('Passports');
    if(/DISABILITY PARKING/i.test(name))labels.add('Disability parking');
    if(/HOLO/i.test(name))labels.add('HOLO');
    if(/Commercial Driver|CDL/i.test(name))labels.add('CDL');
    else if(/Driver.?s? License|Hawaii License|Provisional|Out Of State/i.test(name))labels.add('Driver license');
    if(/State (ID|Identification)/i.test(name))labels.add('State ID');
    if(/Instruction Permit/i.test(name))labels.add('Instruction permits');
    if(/Written Test/i.test(name))labels.add('Written tests');
  }
  return labels.size?[...labels].join(' · '):services.some(s=>!s.disabled)?'Other services':'No online appointments';
}
$('location-info').onclick=()=>{
  const loaded=Object.keys(servicesByLocation).length>0;
  $('location-guide-content').innerHTML=loaded?`<div class="guide-scroll"><table class="services-table"><thead><tr><th scope="col">Location</th><th scope="col">Available services</th></tr></thead><tbody>${state.locations.map(l=>{
    const services=(servicesByLocation[l.id]||[]).filter(s=>!s.disabled);
    return `<tr class="${l.id===$('express-location').value?'current-location':''}"><th scope="row">${escape(l.name)}${l.id===$('express-location').value?'<small>Selected location</small>':''}</th><td><div class="service-tags">${locationServiceSummary(services).split(' · ').map(label=>`<span>${escape(label)}</span>`).join('')}</div>${services.length?`<details><summary>View ${services.length} service${services.length===1?'':'s'}</summary><ul>${services.map(s=>`<li>${escape(serviceName(s.name))}</li>`).join('')}</ul></details>`:''}</td></tr>`;
  }).join('')}</tbody></table></div>`:'<p class="empty">Services are still loading. Close and reopen this guide in a moment.</p>';
  if(!$('location-guide').open)$('location-guide').showModal();
};
const dateLabel=day=>new Date(`${day}T12:00:00-10:00`).toLocaleDateString('en-US',{timeZone:'Pacific/Honolulu',month:'short',day:'numeric',year:'numeric'});
let state,settings,bookingId,bookingRequestId,reviewedDetails,expressSelection,pageSize=30,searchSelection=null,lastSignature='',toastTimer;
async function api(path,body){
  const response=await fetch(`/api/${path}`,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const data=await response.json();if(!response.ok)throw Error(data.error||'Request failed.');return data;
}
function toast(text){$('toast').textContent=text;$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').hidden=true,6000);}
function clearResults(){if(isExpress)return;searchSelection=null;renderResults();}
$('start-date').onchange=()=>{if(isExpress)return;if($('end-date').value<$('start-date').value)$('end-date').value=$('start-date').value;clearResults();};
if($('end-date'))$('end-date').onchange=clearResults;
if($('one-day'))$('one-day').onclick=()=>{$('end-date').value=$('start-date').value;clearResults();};
if($('scan'))$('scan').onclick=async()=>{
  try{
    const startDate=$('start-date').value,endDate=$('end-date').value,service=selectedService();
    scanRange(startDate,endDate);if(!service || service.disabled)throw Error('Choose an available service.');
    $('scan').disabled=true;
    const selection={locationId:$('express-location').value,serviceKey:service.key,startDate,endDate};
    await api('scan',selection);searchSelection=selection;pageSize=30;await refresh();
  }catch(e){toast(e.message);$('scan').disabled=state.scan.status==='running';}
};
if($('stop'))$('stop').onclick=async()=>{try{await api('stop',{});await refresh();}catch(e){toast(e.message);}};
function filtered(){
  if(!searchSelection)return [];
  return sortAppointments(state.scan.slots.filter(s=>s.locationId===searchSelection.locationId && s.serviceKey===searchSelection.serviceKey && s.day>=searchSelection.startDate && s.day<=searchSelection.endDate && s.epoch>Date.now()),settings.order);
}
function renderResults(){
  const slots=filtered();$('results-heading').textContent=searchSelection?`${slots.length} available times`:'Available times';
  $('more').hidden=slots.length<=pageSize;
  $('results').innerHTML=slots.length?slots.slice(0,pageSize).map(s=>`<article class="slot"><div><strong>${escape(dateLabel(s.day))}</strong><p>${escape(s.time)}</p></div><button class="secondary" data-book="${s.id}">${s.directBooking?'Book':'View'}</button></article>`).join(''):`<p class="empty">${!searchSelection?'Select a location, service, and dates to find an appointment.':state.scan.status==='running'?'Checking availability…':'No openings found. Try another date.'}</p>`;
  const days=new Map();for(const s of slots)days.set(s.day,(days.get(s.day)||0)+1);
  $('calendar').innerHTML=[...days].map(([day,count])=>`<div class="calendar-day"><strong>${escape(dateLabel(day))}</strong><span>${count} times</span></div>`).join('')||'<p class="empty">No available dates yet.</p>';
}
if($('more'))$('more').onclick=()=>{pageSize+=30;renderResults();};
if($('results'))$('results').onclick=e=>{
  const b=e.target.closest('[data-book]');if(!b)return;
  expressSelection=null;$('confirm-book').textContent='Confirm & book appointment';
  bookingId=b.dataset.book;bookingRequestId=crypto.randomUUID();
  const s=state.scan.slots.find(s=>s.id===bookingId);if(!s)return;
  const supported=s.directBooking===true;
  reviewedDetails=null;$('appointment-details').reset();$('appointment-details').hidden=!supported;
  $('booking-summary').innerHTML=`<strong>${escape(s.date)} · ${escape(s.time)}</strong><p>${escape(s.location)}</p><p>${escape(serviceName(s.service))}</p>`;
  $('booking-summary').innerHTML+=contactSummary(reviewedDetails);
  $('book-status').textContent=supported?'':'Complete this service’s eligibility and document steps on the AlohaQ appointment site.';
  $('confirm-book').disabled=!supported;$('book-dialog').showModal();
};
if($('express-book'))$('express-book').onclick=()=>{
  const service=selectedService();if(!service?.directBooking || service.disabled){toast('Choose a service available for direct booking, or continue on AlohaQ.');return;}
  const day=$('start-date').value, locationId=$('express-location').value, serviceKey=service.key;
  try{scanRange(day,day);if(day<hstDay(Date.now()))throw Error('Choose today or a future date.');}catch(e){toast(e.message);return;}
  reviewedDetails=bookingDetails('appointment-details');if(!reviewedDetails)return;
  expressSelection={day,locationId,serviceKey};bookingRequestId=crypto.randomUUID();
  const location=state.locations.find(l=>l.id===locationId);
  $('booking-summary').innerHTML=`<strong>${escape(dateLabel(day))} · Earliest available time (HST)</strong><p>${escape(location.name)}</p><p>${escape(serviceName(service.name))}</p><p>The exact time is selected from live availability when you confirm. If this day is full, nothing is booked.</p>`;
  $('booking-summary').innerHTML+=contactSummary(reviewedDetails);
  $('book-status').textContent='';$('confirm-book').textContent='Confirm & book earliest';$('confirm-book').disabled=false;$('book-dialog').showModal();
};
function allowBookingRetry() {
  bookingRequestId=crypto.randomUUID();
  $('confirm-book').textContent='Try again';
  $('confirm-book').disabled=false;
}
function bookingDetails(id){
  const form=$(id);if(!form.reportValidity())return null;
  const data=Object.fromEntries(new FormData(form));
  data.firstName=data.firstName.trim();data.lastName=data.lastName.trim();
  let phone=data.phone.replace(/\D/g,'');if(phone.length===11 && phone.startsWith('1'))phone=phone.slice(1);
  if(!data.firstName || !data.lastName || !/^\d{10}$/.test(phone)){toast('Enter your first name, last name, and a 10-digit US phone number.');return null;}
  return {...data,phone};
}
$('appointment-details').onsubmit=e=>e.preventDefault();
function contactSummary(person){return person?`<p class="review-contact">${escape(person.firstName)} ${escape(person.lastName)} · ${escape(person.phone)}</p>`:'';}
$('confirm-book').onclick=async()=>{
  if(!isExpress){reviewedDetails=bookingDetails('appointment-details');if(!reviewedDetails)return;}
  $('confirm-book').disabled=true;$('book-status').textContent='Rechecking availability and submitting your appointment…';
  try {
    const result=await api(expressSelection?'book-express':'book',{...(expressSelection||{id:bookingId}),requestId:bookingRequestId,reviewedDetails});
    $('book-status').textContent=result.status==='booked'?`Booked! ${result.slot.date} · ${result.slot.time} · ${result.slot.location}. Confirmation: ${result.confirmation}. ${confirmationNotice}`:result.message;
    if(result.status==='failed')allowBookingRetry();
    await refresh().catch(()=>{});
  } catch(e){
    const noOpening=e.message==='No appointments available on this day at this location.' || e.message==='This time is no longer available. Scan again.';
    $('book-status').textContent=noOpening?e.message+' Press Try again to check live availability again.':e.message+' Check AlohaQ before trying again.';
    if(noOpening)allowBookingRetry();
    await refresh().catch(()=>{});
  }
};

let releaseSelection, releaseDetails, servicesByLocation={};
function selectedService(){return (servicesByLocation[$('express-location').value]||[]).find(s=>s.key===$('express-service').value);}
function renderServiceOptions(){
  const services=servicesByLocation[$('express-location').value]||[];
  $('express-service').innerHTML=services.some(s=>!s.disabled)?services.filter(s=>!s.disabled).map(s=>`<option value="${s.key}">${escape(serviceLabel(s.name))}</option>`).join(''):'<option value="">No services loaded</option>';
  const preferred=services.find(s=>!s.disabled && /MOTOR VEHICLES.*Other Services/i.test(s.name)) || services.find(s=>!s.disabled);
  if(preferred)$('express-service').value=preferred.key;
  updateServiceChoice();
}
function updateServiceChoice(){
  const service=selectedService(), direct=service && !service.disabled && service.directBooking;
  if($('express-book'))$('express-book').disabled=!direct;
  $('official-service').hidden=!service || direct;
  $('express-service-note').textContent=!service?'Service catalog unavailable. Reload to try again.':service.disabled?'This service is not bookable online.':direct?'':'Search availability here; complete eligibility and booking on AlohaQ.';
  if($('scan'))$('scan').disabled=state.scan.status==='running' || !service || service.disabled;
  renderRelease();
}
$('express-location').onchange=()=>{renderServiceOptions();clearResults();};
$('express-service').onchange=()=>{updateServiceChoice();clearResults();};

if($('express-mode'))$('express-mode').onchange=()=>{
  const scheduled=$('express-mode').value==='release';
  $('express-now-controls').hidden=scheduled;$('express-release-controls').hidden=!scheduled;
};
function renderRelease() {
  const r=state.release||{status:'idle',message:'Not armed.'};
  const active=['preparing','waiting','searching','submitting'].includes(r.status);
  $('release-banner').hidden=r.status==='idle';
  if($('release-review'))$('release-review').disabled=active || !selectedService()?.directBooking || selectedService()?.disabled;$('release-stop').hidden=!active;$('release-stop').disabled=r.status==='submitting';
  const remaining=Math.max(0,Math.ceil((r.start-Date.now())/1000));
  const countdown=r.status==='waiting'?` Starts in ${Math.floor(remaining/3600)}h ${Math.floor(remaining%3600/60)}m ${remaining%60}s.`:'';
  $('release-status').textContent=`${r.message}${r.status==='booked'?' '+confirmationNotice:''}${countdown}${r.location?` ${r.location}${r.service?' · '+serviceName(r.service):''} · appointment ${r.day} · ${r.attempts} checks`:''}`;
}
if($('release-review'))$('release-review').onclick=()=>{
  const service=selectedService();if(!service?.directBooking || service.disabled){toast('This service must be completed on AlohaQ.');return;}
  const releaseDay=hstDay(Date.now()), targetDay=$('start-date').value, releaseTime=$('release-time').value, locationId=$('express-location').value;
  let window;
  try{scanRange(targetDay,targetDay);if(targetDay<releaseDay)throw Error('Choose today or a future appointment date.');window=releaseWindow(releaseDay,releaseTime);}catch(e){toast(e.message);return;}
  releaseDetails=bookingDetails('appointment-details');if(!releaseDetails)return;
  releaseSelection={releaseDay,releaseTime,targetDay,locationId,serviceKey:service.key};
  const target=targetDay;
  const label=epoch=>new Date(epoch).toLocaleString('en-US',{timeZone:'Pacific/Honolulu',month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit'});
  $('release-summary').innerHTML=`<strong>Release: ${escape(label(window.start))} – ${escape(label(window.end))} HST</strong><p>First check: 500 ms after the selected start time.</p><p>Appointment: ${escape(target)} · earliest available time</p><p>${escape(state.locations.find(l=>l.id===locationId).name)}</p><p>${escape(serviceName(service.name))}</p>`;
  $('release-summary').innerHTML+=contactSummary(releaseDetails);
  $('confirm-release').disabled=false;$('release-review-status').textContent='';$('release-dialog').showModal();
};
if($('confirm-release'))$('confirm-release').onclick=async()=>{
  $('confirm-release').disabled=true;$('release-review-status').textContent='Preparing…';
  try{const r=await api('release-arm',{...releaseSelection,reviewedDetails:releaseDetails});$('release-review-status').textContent=r.message;await refresh();}
  catch(e){$('release-review-status').textContent=e.message;await refresh().catch(()=>{});}
};
if($('release-stop'))$('release-stop').onclick=async()=>{try{await api('release-stop',{});await refresh();}catch(e){toast(e.message);}};


function renderScan(){
  const s=state.scan,running=s.status==='running';$('scan').disabled=running || !selectedService() || selectedService().disabled;$('stop').hidden=!running;
  $('scan').textContent=running?'Searching…':'Find appointments';
  $('scan-status').textContent=!searchSelection?'':running?'Checking available times…':s.status==='complete'?`Search complete · ${filtered().length} available times`:s.status==='cancelled'?'Search stopped.':'Some availability could not be checked.';
  $('notices').hidden=!s.errors.length;$('notices').textContent=s.errors.map(e=>e.message).join(' ');
  renderResults();
}
async function refresh(){
  state=await api('state');renderRelease();
  if(isExpress)return;
  const signature=JSON.stringify([state.scan.status,state.scan.message,state.scan.slots.length]);
  if(signature!==lastSignature){lastSignature=signature;renderScan();}
}
try{
  state=await api('state');settings=state.settings;
  const today=hstDay(Date.now());$('start-date').value=settings.startDate<today?today:settings.startDate;if(!isExpress)$('end-date').value=settings.endDate<$('start-date').value?$('start-date').value:settings.endDate;
  $('start-date').min=today;if(!isExpress)$('end-date').min=today;
  $('express-location').innerHTML=state.locations.map(l=>`<option value="${l.id}">${escape(l.name)}</option>`).join('');$('express-location').value=settings.enabled[0]||'ala-moana';
  const catalog=await api('services');servicesByLocation=Object.fromEntries(catalog.locations.map(l=>[l.id,l.services]));renderServiceOptions();if($('location-guide').open)$('location-info').onclick();if(!isExpress)renderScan();
  async function poll(){try{await refresh();}catch{$(isExpress?'connection-status':'scan-status').textContent='Connection lost. Reconnecting…';}setTimeout(poll,500);}
  setTimeout(poll,500);
}catch(e){toast(e.message);if($('scan'))$('scan').disabled=true;}
