import {randomUUID} from 'node:crypto';
import {locations, validateDetails} from './core.js';
import {catalogServices, selectBookingService, locationCodes, displayDate} from './alohaq-api.js';
import {hstDay, releaseWindow, scanRange} from './shared.js';

export {releaseWindow} from './shared.js';
export class ReleaseBooking {
  constructor({bookings,api,now=Date.now,schedule=setTimeout,unschedule=clearTimeout}) {
    Object.assign(this,{bookings,api,now,schedule,unschedule});
    this.state={status:'idle',message:'Not armed.'};this.generation=0;
  }
  active(){return ['preparing','waiting','searching','submitting'].includes(this.state.status);}
  async arm({releaseDay,releaseTime='16:14',targetDay,locationId,serviceKey},details) {
    if(this.active())throw Error('A release booking is already armed. Stop it first.');
    if(releaseDay!==hstDay(this.now()))throw Error('Release must start today in Hawaii. Reopen the review dialog.');
    scanRange(targetDay,targetDay);
    if(targetDay<releaseDay)throw Error('Choose today or a future appointment date.');
    const window={...releaseWindow(releaseDay,releaseTime),day:targetDay}, location=locations.find(l=>l.id===locationId);
    if(!location)throw Error('Unknown location.');
    if(this.now()>=window.end)throw Error('This release window has ended. Choose a later time today.');
    const person=validateDetails(details), generation=++this.generation;
    this.state={status:'preparing',message:'Preparing service lookup…',releaseDay,releaseTime,locationId,location:location.name,...window,attempts:0};
    try {
      const catalog=await this.api.catalog();
      if(generation!==this.generation)return this.state;
      const service=selectBookingService(catalog,locationCodes[locationId],serviceKey);
      this.state.service=service.name;
      this.selection={locationId,location:location.name,day:window.day,date:displayDate(window.day),serviceKey:service.key,service:service.name};
      this.person=person;this.state.status='waiting';this.state.message=`Armed for ${releaseTime} HST.`;
      this.queue(generation,Math.max(0,window.start-this.now()));
    } catch(e){if(generation===this.generation){this.state.status='failed';this.state.message=e.message;}}
    return this.state;
  }
  queue(generation,delay){this.timer=this.schedule(()=>this.tick(generation),Math.min(delay,2147483647));}
  async tick(generation=this.generation) {
    if(generation!==this.generation || !this.active())return;
    if(this.now()<this.state.start){this.queue(generation,this.state.start-this.now());return;}
    if(this.now()>=this.state.end){this.state.status='expired';this.state.message='Release window ended without a booking.';return;}
    this.state.status='searching';this.state.message='Checking the selected appointment date…';this.state.attempts++;
    try {
      const times=await this.api.times(locationCodes[this.selection.locationId],this.selection.serviceKey,this.selection.day);
      if(generation!==this.generation)return;
      if(this.now()>=this.state.end){this.state.status='expired';this.state.message='Release window ended without a booking.';return;}
      const earliest=times.filter(t=>t.epoch>this.now() && hstDay(t.epoch)===this.selection.day).sort((a,b)=>a.epoch-b.epoch)[0];
      if(earliest) {
        this.state.status='submitting';this.state.message='Booking the earliest opening…';
        const result=await this.bookings.book({...this.selection,...earliest,id:randomUUID(),observedAt:this.now()},this.person,randomUUID());
        this.state.status=result.status;this.state.message=result.status==='booked'?`Booked: ${result.slot?.date || this.selection.date} · ${result.slot?.time || earliest.time}. Confirmation: ${result.confirmation || ''}. Visit AlohaQ to view ticket details.`:result.message;this.state.bookingId=result.id;
        return; // Never automatically retry a submitted booking, including an uncertain response.
      }
      this.state.message='No openings yet. Checking again in 500 ms…';
    } catch(e) {
      if(generation!==this.generation)return;
      // Only an explicitly stale slot is safe to retry. Other errors stop the run.
      if(e.message!=='This time is no longer available. Scan again.'){
        this.state.status='failed';this.state.message=e.message;return;
      }
      this.state.status='searching';this.state.message='Opening was taken. Checking again…';
    }
    this.queue(generation,500);
  }
  stop() {
    if(this.state.status==='submitting')throw Error('A booking request is already in progress. Wait for its result.');
    this.unschedule(this.timer);this.generation++;
    if(this.active()){this.state.status='stopped';this.state.message='Release booking stopped.';}
    return this.state;
  }
}
