export type Channel = 'public' | 'private';
export type Event = { id:string; channel:Channel; userId:string; handle:string; text:string; url:string; conversationId:string; timestamp:number; timestampReliable?:boolean; mediaUnavailable?:boolean };
export type Draft = { action:'reply'|'skip'; text:string; reason:string };
export type Config = { expectedHandle:string; mode:'draft'|'auto'; pollSeconds:number; maxAgeHours:number; maxPerRound:number; publicPerHour:number; privatePerHour:number; persona:string; dailyState:string; retentionDays:number; model:{provider:string;api:string;baseUrl:string;id:string;reasoning:boolean;reasoningLevel:string;vision:boolean;maxTokens:number;timeoutMs:number;source?:'panel'|'config';custom?:{contextWindow:number;reasoning:boolean}} };
export type Receipt = { status:'confirmed'|'unknown'|'rejected'; id?:string; url?:string; reason?:string };
export type Identity = { handle:string; userId?:string; loggedIn:boolean; needsHuman:boolean; reason?:string };
