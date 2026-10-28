/** 仅描述适配器，不读取平台页面，也不提供能绕过样本门槛的外部开关。 */
export function collectionSources(){return {sources:[
 {id:'mentions',label:'通知提及',enabled:true,status:'implemented',reason:'既有提及来源；运行就绪及异常另见采集健康'},
 {id:'search',label:'公开搜索',enabled:true,status:'implemented',reason:'既有公开搜索来源；运行就绪及异常另见采集健康'},
 {id:'own-post-replies',label:'自己帖子下的回复',enabled:true,status:'implemented',reason:'既有主页来源，跳过已确认置顶并核对详情页'},
 {id:'all-notifications',label:'通知全部栏引用',enabled:false,status:'awaiting-samples',reason:'未启用（待真实样本确认）'},
 ]};}
