import type {Assessment,Batch,Corpus,ModelOutput,Policy,Segment} from '../src/contracts.js';

/** Explicit synthetic categories and prose, never actual legal criteria or human quality evidence. */
export function classificationFixture(segmentCount=2,categoryCount=2){
  const policy:Policy={version:1,id:'fixture-policy',revision:1,label:'Synthetic precheck fixture',authority:'unverified_configuration',categories:Array.from({length:categoryCount},(_,index)=>({id:'fixture-category-'+index,label:'Fixture category '+index,description:'仅用于分类协议回归，不代表适用法律。',risk:index===0?'high':'low'})),rules:[]};
  const segments:Segment[]=Array.from({length:segmentCount},(_,index)=>({id:'segment-'+index,path:'/segments/'+index+'/text',field:'beat',sceneId:'scene',beatId:'beat-'+index,lineId:null,voice:null,speakerId:null,text:'甲😀乙风险句。'}));
  const corpus:Corpus={version:1,episodeId:'01ARZ3NDEKTSV4RRFFQ69G5FAV',segments};
  const batch:Batch={version:1,index:0,segments:segments.slice(0,Math.min(32,Math.floor(256/categoryCount)))};
  const output:ModelOutput={version:1,assessments:batch.segments.flatMap(segment=>policy.categories.map(category=>({segmentId:segment.id,categoryId:category.id,verdict:'not_flagged' as const,start:0,end:0,quote:null,reason:'合成协议样例中未标记；不代表合法。'})))};
  const positive=(verdict:'flag'|'uncertain'='flag'):Assessment=>({...output.assessments[0]!,verdict,start:4,end:6,quote:'风险',reason:'此处仅为合成分类风险示例，须人工核对。'});
  return {policy,corpus,batch,output,positive};
}
