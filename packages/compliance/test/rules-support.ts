import type {Corpus,Field,Policy,Segment} from '../src/contracts.js';

/** Explicit synthetic configuration, not a rule of law, approved policy or real legal assessment. */
export function literalRulesFixture(){
  const policy:Policy={version:1,id:'fixture-precheck',revision:1,label:'合成字面规则测试',authority:'unverified_configuration',categories:[{id:'fixture-risk',label:'合成类别',description:'仅用于机械规则和定位回归，不代表法律判断。',risk:'high'}],rules:[{id:'fixture-literal',categoryId:'fixture-risk',label:'合成字面命中',literal:'aba',mode:'exact',fields:['beat','line'],references:[]}]};
  const corpus:Corpus={version:1,episodeId:'01ARZ3NDEKTSV4RRFFQ69G5FAV',segments:[literalSegment('first','ababa'),literalSegment('second','仅有普通说明。')]};
  return {policy,corpus};
}
export function literalSegment(id:string,text:string,field:Field='beat'):Segment{
  const spoken=field==='line'||field==='delivery',name=field==='speaker_name';
  return {id,path:'/fixture/'+id,field,sceneId:name?null:'scene',beatId:name?null:'beat-'+id,lineId:spoken?'line-'+id:null,voice:spoken?'on_screen':null,speakerId:spoken||name?'01ARZ3NDEKTSV4RRFFQ69G5FAW':null,text};
}
