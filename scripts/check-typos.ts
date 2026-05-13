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
  // Estado del screenshot: 4 recordatorios, sin microtasks.
  await ad.s('/recordar mañana 9:45 cumpleaños mia');
  await ad.s('/recordar mañana 9am vacuna vsr');
  await ad.s('/recordar mañana 10:45 cumpleaños mia');
  await ad.s('/recordar mañana 9am cita ginecologa');
  const log=(t:string)=>{console.log(`\n>>> ${t}\n<<< ${ad.last().slice(0,260).replace(/\n/g,' | ')}`);};
  // Reproducir casos del screenshot:
  ad.reset(); await ad.s('Cancela 1'); log('"Cancela 1" (sin "recordatorio", contexto = solo recordatorios)');
  ad.reset(); await ad.s('/borra 1'); log('"/borra 1" (typo: falta R)');
  ad.reset(); await ad.s('/cancela 1'); log('"/cancela 1" (typo: falta R)');
  // Reset state para los siguientes (rec sin hora)
  ad.reset(); await ad.s('/recordar cita doctora Soto 14:25'); log('"/recordar cita doctora Soto 14:25" (HH:MM trailing)');
  ad.reset(); await ad.s('/recordatorio cita con doctora Soto'); log('"/recordatorio cita con doctora Soto" (sin hora)');
  ad.reset(); await ad.s('el viernes 10am'); log('Respuesta al prompt "¿cuándo?": "el viernes 10am"');
  ad.reset(); await ad.s('/recordatorios'); log('/recordatorios final');
  await o.stop(); await st.disconnect();
})();
