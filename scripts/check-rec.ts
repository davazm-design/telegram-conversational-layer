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
  async s(text:string){await this.h!({id:String(Math.random()),userId:'u',chatId:'u',text,timestamp:new Date().toISOString()});}
  last(){return this.sent[this.sent.length-1]?.text??'';} reset(){this.sent=[];}
}
const cfg:AppConfig={telegram:{botToken:'x',mode:'polling',webhookSecret:'',publicWebhookUrl:'',port:0},llm:{enabled:false,provider:'openai',openaiApiKey:''},storage:{provider:'memory',databaseUrl:''},logLevel:'error'};
(async()=>{
  const st=new MemoryStorageProvider(); await st.connect('x');
  const ad=new A(); const dm=new AdhdCoachDomainHandler(st.adhdCoachStore);
  const o=new Orchestrator(ad,dm,cfg,st.sessionStore); await o.start();
  const inputs=['/recordar mañana 9am llamar al doctor','/recordatorio mañana 9am llamar al doctor','/recordatorio para el 22 de mayo 9am vacuna VSR','recuérdame mañana 9am algo','/recordar 21 de mayo 9am algo','/recordatorios'];
  for (const i of inputs){ad.reset(); await ad.s(i); console.log(`\n>>> ${i}\n<<< ${ad.last().slice(0,180).replace(/\n/g,' | ')}`);}
  await o.stop(); await st.disconnect();
})();
