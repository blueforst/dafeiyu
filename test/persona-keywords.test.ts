import test from 'node:test';
import assert from 'node:assert/strict';
import {validatePersona,legacyPersona} from '../src/persona.js';
import {upgradePersona} from '../src/persona-upgrade.js';
const card={id:'x',title:'不给步骤',condition:'问教程',content:'只谈一点感受',enabled:true,order:0};
test('所有接口关键词字段均拒绝，显式旧semantic字段接受但不保存',()=>{
 const base=legacyPersona('测试人设');for(const extra of [{match:'keywords'},{keywords:[]},{keywords:['教程']},{match:'semantic',keywords:['教程']}])assert.throws(()=>validatePersona({...base,triggers:[{...card,...extra}]}),/关键词触发已取消/);
 assert.deepEqual(validatePersona({...base,triggers:[{...card,match:'semantic'}]}).triggers,[card]);
});
test('旧关键词自动说明转换为意思，手写条件和开关顺序保留',()=>{
 const base=legacyPersona('原文'),old={...base,triggers:[{...card,condition:'消息包含以下任一关键词：猫、喵',match:'keywords',keywords:['猫','喵']},{...card,id:'other',condition:'只有友好询问时',enabled:false,order:9,match:'keywords',keywords:['问']}]} as any;
 const result=upgradePersona(old).persona;assert.match(result.triggers[0].condition,/类似意思.*猫、喵/);assert.equal(result.triggers[1].condition,'只有友好询问时');assert.equal(result.triggers[1].enabled,false);assert.equal(result.triggers[1].order,9);assert.deepEqual(validatePersona(result),result);
});
test('卡片条件长度和总长仍校验，来源分区与卡片标识仍唯一',()=>{
 const base=legacyPersona('字'.repeat(19995));assert.throws(()=>validatePersona({...base,triggers:[card]}),/20,000/);assert.throws(()=>validatePersona({...legacyPersona('角色'),triggers:[{...card,condition:'字'.repeat(2001)}]}),/触发条件/);assert.throws(()=>validatePersona({...legacyPersona('角色'),triggers:[{...card,id:'role'}]}),/重复/);
});
