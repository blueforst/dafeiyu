import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {matchNativePrivateReceipt,type NativeSubmitEvidence} from '../src/xchat-actions.js';
import {TransportJournal} from '../src/browser.js';
import type {ChatObservedMessage} from '../src/chat-dom.js';
const id='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222',now=Date.now();
const evidence:NativeSubmitEvidence={contract:'xchat-native-v2',selfUserId:'222',targetUuid:other,browserSession:other,baselineIds:[other],localPendingId:id,pendingCreatedAt:now};
const row={id,text:'合成回复',direction:'out',senderId:'222',contract:'xchat-native-v2',timestamp:now,timestampReliable:true,nativeSequence:'123',blockedCodes:[],media:false} as ChatObservedMessage;
test('只认持久绑定的本地Pending UUID及平台序号，不认其他客户端同文',()=>{
 assert.equal(matchNativePrivateReceipt([row],row.text,evidence,now).status,'confirmed');for(const patch of [{id:other},{senderId:'111'},{timestamp:now-3000},{timestampReliable:false},{nativeSequence:''},{nativeSequence:'0'},{blockedCodes:['x']},{direction:'in'}])assert.equal(matchNativePrivateReceipt([{...row,...patch} as any],row.text,evidence,now).status,'unknown');
 assert.equal(matchNativePrivateReceipt([row,row],row.text,evidence,now).status,'unknown');assert.equal(matchNativePrivateReceipt([row],row.text,{...evidence,localPendingId:undefined},now).status,'unknown');assert.equal(matchNativePrivateReceipt([row],row.text,{...evidence,ambiguous:true},now).status,'unknown');
});
test('原生发送意图重启保持Pending绑定，冲突及伪造confirmed不能改成成功',()=>{
 const dir=mkdtempSync(tmpdir()+'/native-receipt-');try{const path=dir+'/journal.json',j=new TransportJournal(path);const {localPendingId,pendingCreatedAt,...base}=evidence;j.intent('outbox-1','dm','worker','111-222',row.text,base);j.bindNativePending('outbox-1',{id,createdAt:now});const restarted=new TransportJournal(path);assert.equal(restarted.get('outbox-1')?.native?.localPendingId,id);assert.equal(restarted.settle('outbox-1',{status:'confirmed',id:other,nativeSequence:'123'}).status,'unknown');assert.equal(restarted.settle('outbox-1',{status:'confirmed',id,nativeSequence:'123'}).status,'confirmed');
  const raw=JSON.parse(JSON.stringify(restarted.entries));raw['outbox-1'].receipt.id=other;writeFileSync(path,JSON.stringify(raw));assert.throws(()=>new TransportJournal(path),/日志损坏/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
