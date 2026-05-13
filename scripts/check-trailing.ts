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
  const inputs=[
    'Recuérdame cita con doctora Soto en 16 minutos',
    'recuérdame llamar al doctor mañana 9am',
    '/recordar comprar pan en 2 horas',
    '/recordar reunión con jefe el viernes 10am',
    'recuérdame tomar pastilla a las 8am',
    '/recordar mañana 9am llamar (orden canónica sigue OK)',
    'recuérdame en 1h tomar agua (sigue funcionando)',
  ];
  for (const i of inputs){ad.reset(); await ad.s(i); console.log(`\n>>> ${i}\n<<< ${ad.last().slice(0,200).replace(/\n/g,' | ')}`);}
  await o.stop(); await st.disconnect();
})();
