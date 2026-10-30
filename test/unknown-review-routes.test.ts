import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {registerUnknownReviewRoutes} from '../src/unknown-review-routes.js';
import type {UnknownReviews} from '../src/unknown-reviews.js';

test('审核接口只接受指定的显式确认动作，未知字段不得变成状态重置',async()=>{
 const app=Fastify();const calls:any[]=[];
 const reviews={list:()=>({items:[]}),preview:(id:string)=>({outboxId:id}),approve:(id:string,input:any)=>{calls.push({id,input});return {reviewed:true};},revoke:()=>({reviewed:false})} as unknown as UnknownReviews;
 registerUnknownReviewRoutes(app,reviews);
 try{
  for(const payload of [{revision:'r',confirmed:false,action:'allow-other-public-items'},{revision:'r',confirmed:true,action:'mark-sent'},{revision:'r',confirmed:true,action:'allow-other-public-items',status:'confirmed'}]){
   const response=await app.inject({method:'POST',url:'/api/outbox/old/unknown-review',payload});assert.equal(response.statusCode,400);
  }
  assert.equal(calls.length,0);
  const payload={revision:'r',confirmed:true,action:'allow-other-public-items'},response=await app.inject({method:'POST',url:'/api/outbox/old/unknown-review',payload});assert.equal(response.statusCode,200);assert.deepEqual(calls,[{id:'old',input:payload}]);
  const wrongRevoke=await app.inject({method:'POST',url:'/api/outbox/old/unknown-review/revoke',payload});assert.equal(wrongRevoke.statusCode,400);
 }finally{await app.close();}
});

test('审核接口保留快照竞态与账号隔离的错误状态',async()=>{
 const app=Fastify(),reviews={preview:()=>{throw Object.assign(new Error('出站记录不存在'),{statusCode:404});},approve:()=>{throw Object.assign(new Error('记录已变化，请重新读取后审核'),{statusCode:409});}} as unknown as UnknownReviews;
 registerUnknownReviewRoutes(app,reviews);
 try{
  assert.equal((await app.inject({method:'GET',url:'/api/outbox/other/unknown-review'})).statusCode,404);
  const response=await app.inject({method:'POST',url:'/api/outbox/old/unknown-review',payload:{revision:'r',confirmed:true,action:'allow-other-public-items'}});assert.equal(response.statusCode,409);
 }finally{await app.close();}
});
