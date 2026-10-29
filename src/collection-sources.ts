/** 仅描述适配器，不读取平台页面，也不提供能绕过样本门槛的外部开关。 */
export function collectionSources(){return {sources:[
 {id:'mentions',label:'通知提及',enabled:true,status:'implemented',reason:'既有提及来源；运行就绪及异常另见采集健康'},
 {id:'search',label:'公开搜索',enabled:true,status:'implemented',reason:'既有公开搜索来源；运行就绪及异常另见采集健康'},
 {id:'own-post-replies',label:'自己帖子下的回复',enabled:true,status:'implemented',reason:'既有主页来源，跳过已确认置顶并核对详情页'},
 {id:'all-notifications',label:'通知全部栏引用',enabled:false,status:'awaiting-samples',reason:'未启用（待真实样本确认）'},
 {id:'private-inbox',label:'私信收件箱',enabled:true,status:'implemented',reason:'核对账号、一对一文本、机器时间与平台序号；异常另见采集健康'},
 {id:'private-requests',label:'私信请求',enabled:true,status:'implemented',reason:'按现有过滤和运行限制接受；结果不明确时只回查'},
 {id:'private-other',label:'其他私信请求',enabled:true,status:'implemented',reason:'主收件箱或普通请求为空时仍检查；不因位于 Other 就直接过滤'},
 ]};}
