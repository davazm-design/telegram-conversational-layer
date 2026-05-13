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
  // Sembrar 5 recordatorios como en el screenshot
  await ad.s('/recordar mañana 10:30 ir a desayunar');
  await ad.s('/recordar mañana 9:45 cumpleaños mia');
  await ad.s('/recordar mañana 9am vacuna vsr');
  await ad.s('/recordar mañana 10:45 cumpleaños mia');
  await ad.s('/recordar mañana 9am cita ginecologa');
  const log=(t:string)=>{console.log(`\n>>> ${t}\n<<< ${ad.last().slice(0,300).replace(/\n/g,' | ')}`);};
  ad.reset(); await ad.s('/recordatorios'); log('/recordatorios');
  ad.reset(); await ad.s('Borra 1, 2 y 4'); log('"Borra 1, 2 y 4" (multi sin "recordatorio" — debería ir a microtasks o fallback)');
  ad.reset(); await ad.s('cancela los recordatorios 1, 2 y 4'); log('"cancela los recordatorios 1, 2 y 4"');
  ad.reset(); await ad.s('/recordatorios'); log('/recordatorios después');
  ad.reset(); await ad.s('Cancelar _ recordatorio 1'); log('"Cancelar _ recordatorio 1" (con espacios alrededor del _)');
  ad.reset(); await ad.s('/recordatorios'); log('/recordatorios final');
  await o.stop(); await st.disconnect();
})();
