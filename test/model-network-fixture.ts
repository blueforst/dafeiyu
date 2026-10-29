import type {Server} from 'node:http';
/** 合成服务仅允许本次实际监听的地址与端口，使用与部署相同的显式策略。 */
export function allowTestModelServer(server:Server){
 const address=server.address();if(!address||typeof address==='string')throw new Error('合成服务尚未监听');
 const origin='http://127.0.0.1:'+address.port,previous=(process.env.MODEL_INTERNAL_TARGETS??'').split(',').filter(Boolean);process.env.MODEL_INTERNAL_TARGETS=[...new Set([...previous,origin])].join(',');
 server.once('close',()=>{const current=(process.env.MODEL_INTERNAL_TARGETS??'').split(',').filter(value=>value&&value!==origin);if(current.length)process.env.MODEL_INTERNAL_TARGETS=current.join(',');else delete process.env.MODEL_INTERNAL_TARGETS;});
}
