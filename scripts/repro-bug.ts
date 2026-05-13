import { Orchestrator } from '../src/index';
import { AdhdCoachDomainHandler } from '../src/examples/adhd-coach.domain';
import { MemoryStorageProvider } from '../src/core/storage/memory.storage';
import { GenericMessage, GenericResponse, IMessageAdapter } from '../src/core/types';
import { AppConfig } from '../src/core/config';
import { setLogLevel } from '../src/core/logger';
setLogLevel('error');
class A implements IMessageAdapter {
  sent: GenericResponse[] = []; h: ((m:GenericMessage)=>Promise<void>)|null=null;
  async start(h:any){this.h=h;} async sendResponse(r:GenericResponse){this.sent.push(r);} async stop(){this.h=null;}
  async s(t:string){await this.h!({id:String(Math.random()),userId:'u',chatId:'u',text:t,timestamp:new Date().toISOString()});}
  last(){return this.sent[this.sent.length-1]?.text??'';} reset(){this.sent=[];}
}
const cfg:AppConfig={telegram:{botToken:'x',mode:'polling',webhookSecret:'',publicWebhookUrl:'',port:0},llm:{enabled:false,provider:'openai',openaiApiKey:''},storage:{provider:'memory',databaseUrl:''},logLevel:'error'};
(async()=>{
  const st=new MemoryStorageProvider(); await st.connect('x');
  const ad=new A(); const dm=new AdhdCoachDomainHandler(st.adhdCoachStore);
  const o=new Orchestrator(ad,dm,cfg,st.sessionStore); await o.start();
  await ad.s('/agenda comprar base para televisión\nComprar bote antismalte, para quitar color de puerta\nQuitar molduras de puerta\nIr a carpintería');
  console.log('\n>>> CLASIFICACIÓN:\n' + ad.last());
  ad.reset();
  await ad.s('Agrega las 5 como mantenimiento');
  console.log('\n>>> "Agrega las 5...":\n' + ad.last());
  await o.stop(); await st.disconnect();
})();
