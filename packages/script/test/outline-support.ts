import type { OutlineContext,OutlineOutput } from '../src/outline/contracts.js';
export function outlineFixture(){
  const context:OutlineContext={episodeCount:3,targetSeconds:90,paidEpisodeNumbers:[3],mainGenre:'rebirth-revenge',auxiliaryGenres:['suspense'],sourceRefIds:['source:protagonist','source:clock']};
  const output:OutlineOutput={
    adaptation:{title:'停钟之夜',logline:'重来一次的修钟师用三次敲钟阻止港城失忆。',audience:'悬疑短剧观众',promise:'每次反击揭开一条钟声规则。',centralConflict:'修钟师与掌握钟塔的人争夺公开时刻表。',decisions:[{id:'d1',action:'keep',reason:'保留共同记忆的主轴。',sourceRefIds:['source:clock']}]},
    recipe:{mainGenre:'rebirth-revenge',auxiliaryGenres:['suspense'],collision:'知道旧结局的修钟师仍须找出谁调换了钟。',signatureScenes:[{id:'signature',description:'敲钟前公开假时刻表。',beatIds:['b3']}],failureModes:['避免主角凭空知道谜底。'],ablations:[{genre:'suspense',affectedBeatIds:['b2'],removalEffect:'调包者直接公开，反击不再依靠查证。',mainlineSurvives:false,reason:'第二集查证推动第三集反击。'}]},
    characters:[{id:'hero',name:'阿澄',function:'protagonist',desire:'保住共同记忆',obstacle:'钟塔只开三次门',arc:'从独自报复到公开证据',origin:{kind:'adapted',sourceRefIds:['source:protagonist']}}],
    beats:[1,2,3].map(number=>({id:`b${number}`,episodeNumber:number,order:1,characterIds:['hero'],goal:'进入钟塔',conflict:'守门人索要旧钥匙',turn:'发现钥匙刻错了日期',consequence:'必须当众验证时刻表',origin:{kind:'adapted' as const,sourceRefIds:['source:clock']}})),
    episodes:[1,2,3].map(number=>({number,title:`第${number}次敲钟`,synopsis:'阿澄拿着旧钥匙进入钟塔，在错误日期上找到线索。',beatIds:[`b${number}`],openingHook:{type:'conflict' as const,text:'守门人折断旧钥匙。',beatId:`b${number}`,estimatedSecond:2},stakes:{text:'再迟一分钟全城将忘记昨天。',beatId:`b${number}`,estimatedSecond:8},cliffhanger:{type:(['partial_reveal','identity_near','choice'] as const)[number-1]!,text:'她握住最后一把钥匙。',beatId:`b${number}`},emotionIntensity:7,paidBreakpoint:number===3})),
    assets:[{id:'clock',kind:'prop',name:'旧钥匙',description:'刻有错日期的铜钥匙',narrativeRole:'揭露调包行为的证据',characterId:null,beatIds:['b1','b2','b3'],origin:{kind:'adapted',sourceRefIds:['source:clock']},propStates:[{beatId:'b1',before:'完整',after:'折断',reason:'守门人阻止主角进入。'}]}],
    plotUnits:[{id:'u1',episodeNumbers:[1,2,3],beatIds:['b1','b2','b3'],pressure:'记忆逐步消失',escalation:'钥匙被折断',reversal:'日期暴露调包者',release:'公开时刻表',nextCrisis:'第三次钟声即将响起'}],
    seasonEngine:{centralQuestion:'谁有权保存港城的昨天？',protagonistGoal:'公开时刻表',opposition:'钟塔控制者',repeatablePressure:'每次钟声删除一段记忆',escalation:'从一人扩展到全城',endState:'居民共同决定敲钟时间',characterIds:['hero'],plotUnitIds:['u1']},
  };
  return {context,output};
}
