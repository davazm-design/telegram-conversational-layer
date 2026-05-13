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
  const log=(t:string)=>{console.log(`\n>>> ${t}\n<<< ${ad.last().slice(0,300).replace(/\n/g,' | ')}`);};
  await ad.s('/agenda comprar pan, llamar al doctor, enviar reporte, reorganizar carpetas');
  ad.reset(); await ad.s('todos'); log('/agenda + todos');
  ad.reset(); await ad.s('/focus'); log('/focus (sin priorities)');
  ad.reset(); await ad.s('/prioriza'); log('/prioriza inicio');
  ad.reset(); await ad.s('A'); log('1ª tarea: A (urgente → quick)');
  ad.reset(); await ad.s('C'); log('2ª tarea: C (ambas → now)');
  ad.reset(); await ad.s('B'); log('3ª tarea: B (importante → plan)');
  ad.reset(); await ad.s('D'); log('4ª tarea: D (puede esperar → later)');
  ad.reset(); await ad.s('/siguiente'); log('/siguiente');
  ad.reset(); await ad.s('/focus'); log('/focus con priorities');
  ad.reset(); await ad.s('qué tengo que hacer ahora'); log('NL "qué tengo que hacer ahora"');
  await o.stop(); await st.disconnect();
})();
