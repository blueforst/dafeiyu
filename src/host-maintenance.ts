import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type HostTask = 'backup'|'health';
export type HostRequest = {id:string; task:HostTask; action:'run'|'configure'; enabled?:boolean; time?:string};
export type HostResult = {id?:string; task?:HostTask; ok?:boolean; status?:string; at?:number; error?:string; [key:string]:unknown};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** 应用只有 requests 写权限；results 由独立宿主 helper 写入。 */
export class HostMaintenance {
 constructor(public root=process.env.MAINTENANCE_DIR||'/maintenance'){}
 available(){return existsSync(join(this.root,'requests'))&&existsSync(join(this.root,'results'));}
 request(task:HostTask,action:'run'|'configure',options:{enabled?:boolean;time?:string}={}):HostRequest {
  if(!['backup','health'].includes(task)||!['run','configure'].includes(action))throw new Error('不支持的宿主维护请求');
  if(options.enabled!==undefined&&typeof options.enabled!=='boolean')throw new Error('任务开关无效');
  if(options.time!==undefined&&!/^([01]\d|2[0-3]):[0-5]\d$/.test(options.time))throw new Error('任务时间无效');
  if(!this.available())throw new Error('宿主维护桥接尚未安装');
  const request:HostRequest={id:randomUUID(),task,action,...options};
  const directory=join(this.root,'requests');
  if(lstatSync(directory).isSymbolicLink())throw new Error('维护请求目录不能是符号链接');
  const temporary=join(directory,request.id+'.tmp');
  writeFileSync(temporary,JSON.stringify(request),{mode:0o600,flag:'wx'});
  renameSync(temporary,join(directory,request.id+'.json'));
  return request;
 }
 result(id:string):HostResult|null {
  if(!UUID.test(id))throw new Error('维护请求标识无效');
  return this.readResult(id+'.json');
 }
 latest(task:HostTask):HostResult|null {return this.readResult(task+'-latest.json');}
 plans():Record<string,unknown>|null {return this.readResult('plans.json');}
 private readResult(name:string):HostResult|null {
  const file=join(this.root,'results',name);
  try{
   const stat=lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>128*1024)return null;
   const parsed=JSON.parse(readFileSync(file,'utf8'));
   return parsed&&typeof parsed==='object'&&!Array.isArray(parsed)?parsed:null;
  }catch{return null;}
 }
}
