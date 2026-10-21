import {randomUUID} from 'node:crypto';
import {AlohaQApi, locationCodes, catalogServices, displayDate, selectBookingService} from './alohaq-api.js';
import {validateDetails, locations} from './core.js';
import {scanRange, hstDay} from './shared.js';

// Mutations deliberately have no automatic retry: a timed-out POST may have succeeded.
export async function appointmentRequest(path,params,method='POST') {
  const url=new URL(path,'https://alohaq.honolulu.gov/'), body=new URLSearchParams(params);
  if(method==='GET')url.search=body.toString();
  const response=await fetch(url,{method,signal:AbortSignal.timeout(25000),headers:{Accept:'application/json',...(method==='POST'?{'Content-Type':'application/x-www-form-urlencoded'}:{})},...(method==='POST'?{body:body.toString()}:{})});
  if(!response.ok)throw new Error(`AlohaQ returned HTTP ${response.status}.`);
  return response.json();
}
export class Bookings {
  constructor({records=[],save=async()=>{},request=appointmentRequest,availability=new AlohaQApi()}={}) {
    this.records=records;this.save=save;this.request=request;this.availability=availability;this.busy=false;
    // Preserve uncertain outcomes after restart; the same request ID is never resubmitted.
    for(const r of records)if(r.status==='submitting')r.status='unknown';
  }
  async bookExpress({locationId,day,serviceKey},details,requestId) {
    scanRange(day,day);
    if(day<hstDay(Date.now()))throw new Error('Choose today or a future date.');
    const location=locations.find(l=>l.id===locationId);
    if(!location)throw new Error('Unknown location.');
    return this.book({locationId,serviceKey,location:location.name,day,date:displayDate(day)},details,requestId,true);
  }
  async book(slot,details,requestId,express=false) {
    if(typeof requestId!=='string' || !/^[\w-]{16,80}$/.test(requestId))throw new Error('Invalid booking request. Reopen the review dialog.');
    const prior=this.records.find(r=>r.requestId===requestId);
    if(prior)return prior;
    if(this.busy)throw new Error('Another booking or cancellation is in progress.');
    if(!slot || (!express && slot.epoch<=Date.now()))throw new Error('This opening has expired. Scan again.');
    const person=validateDetails(details), code=locationCodes[slot.locationId];
    if(!code)throw new Error('Unknown location.');
    this.busy=true;
    try {
      if(express) {
        const catalog=await this.availability.catalog();
        const service=selectBookingService(catalog,code,slot.serviceKey);
        slot={...slot,serviceKey:service.key,service:service.name};
        const dates=await this.availability.dates(code,slot.serviceKey,slot.day,slot.day);
        if(!dates.includes(slot.day))throw new Error('No appointments available on this day at this location.');
      }
      if(!express){
        const service=selectBookingService(await this.availability.catalog(),code,slot.serviceKey);
        slot={...slot,service:service.name};
      }
      const times=await this.availability.times(code,slot.serviceKey,slot.day);
      if(express) {
        const earliest=times.filter(t=>t.epoch>Date.now() && hstDay(t.epoch)===slot.day).sort((a,b)=>a.epoch-b.epoch)[0];
        if(!earliest)throw new Error('No appointments available on this day at this location.');
        slot={...slot,...earliest,id:randomUUID(),observedAt:Date.now()};
      }
      if(!times.some(t=>t.epoch===slot.epoch))throw new Error('This time is no longer available. Scan again.');
      const record={id:randomUUID(),requestId,status:'submitting',createdAt:Date.now(),slot:structuredClone(slot),details:person};
      this.records.push(record);
      try{await this.save(this.records);}catch(e){this.records.pop();throw e;}
      try {
        const datetime=new Date(slot.epoch-10*3600000).toISOString().slice(0,19).replace('T',' ');
        const result=await this.request('wrk_book_appointment.php',{c:'1',l:code,s:slot.serviceKey,a:datetime,fn:person.firstName,ln:person.lastName,m:person.phone,v:'0',k:'0',d:'false',ver:'3',ex:''});
        if(Number(result.success)===1 && result.confirmation) {
          record.status='booked';record.confirmation=String(result.confirmation);record.message='Appointment booked successfully.';
        } else if(Number(result.success)===2) {
          record.status='failed';record.message='AlohaQ says you already have an appointment booked. Cancel it on AlohaQ before trying again.';
        } else if(Number(result.success)===0) {
          record.status='failed';record.message=String(result.message || 'AlohaQ declined this appointment.');
        } else {
          record.status='unknown';record.message='Unexpected response. Check your ticket on AlohaQ before attempting another booking.';
        }
      } catch(e) {
        record.status='unknown';record.message='The booking response could not be confirmed. Check your ticket on AlohaQ before trying again; this request will not be retried.';
      }
      record.updatedAt=Date.now();
      await this.save(this.records);
      return record;
    } finally {this.busy=false;}
  }
  async cancel(id) {
    const record=this.records.find(r=>r.id===id);
    if(!record)throw new Error('Booking not found.');
    if(record.status==='cancelled' || record.status==='inactive')return record;
    if(record.status!=='booked' || !record.confirmation)throw new Error('Check this booking’s status before attempting cancellation.');
    if(this.busy)throw new Error('Another booking or cancellation is in progress.');
    this.busy=true;
    try {
      record.status='cancel_unknown';await this.save(this.records);
      try {
        const result=await this.request('wrk_cancel_appointment.php',{ln:record.details.lastName,q:record.confirmation},'GET');
        if(Number(result.success)===1){record.status='cancelled';record.message='Cancellation confirmed by AlohaQ.';}
        else {record.status='booked';record.message=String(result.message || 'Cancellation was not confirmed.');}
      } catch {record.message='Cancellation response was not confirmed. Use Check status before taking further action.';}
      record.updatedAt=Date.now();await this.save(this.records);return record;
    } finally {this.busy=false;}
  }
  async verify(id) {
    const record=this.records.find(r=>r.id===id);
    if(!record?.confirmation)throw new Error('No confirmation code was returned. Use View or Cancel My Ticket on AlohaQ with your phone number.');
    if(this.busy)throw new Error('Another booking or cancellation is in progress.');
    this.busy=true;
    try {
      const result=await this.request('wrk_get_ticket.php',{ln:record.details.lastName,q:record.confirmation,m:''},'GET');
      if(Number(result.success)===1){record.status='booked';record.message='AlohaQ confirms this ticket is active.';}
      else if(Number(result.success)===0 && result.message==='Ticket expired or not found'){
        record.status=record.status==='cancelled'?'cancelled':'inactive';record.message='AlohaQ reports: Ticket expired or not found.';
      } else throw new Error('Could not verify ticket status. Check AlohaQ directly.');
      record.updatedAt=Date.now();await this.save(this.records);return record;
    } finally {this.busy=false;}
  }
}
