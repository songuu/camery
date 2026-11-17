import type { z } from 'zod';
import { capture,deepFreeze } from './boundary.js';
import { CliffhangerType,GenreId,OpeningHookType,RuleThresholdsSchema } from './contracts.js';
import type { RuleThresholds } from './contracts.js';

export interface GenreProfile {
  readonly id:GenreId;
  readonly name:string;
  readonly version:1;
  readonly source:'camery-original';
  readonly guidanceStatus:'unvalidated';
  readonly rhythm:readonly string[];
  readonly rules:readonly string[];
  readonly taboos:readonly string[];
  readonly visualFingerprint:readonly string[];
}

// These are initial writing aids; version changes require new pins rather than rewriting an adopted plan.
export const GENRE_PROFILES=deepFreeze({
  'rebirth-revenge':{
    id:'rebirth-revenge',name:'重生复仇',version:1,source:'camery-original',guidanceStatus:'unvalidated',
    rhythm:['开篇展示一次可见的旧伤害，再用当前选择说明主角有了第二次机会。','每个情节单元让一次反击改变对手的手段，并带出主角必须支付的新代价。','接近单元终点时回收一条旧线索，留下下一次反击所缺的条件。'],
    rules:['把主角记得的旧事实与本次行动新获得的信息分别写清，信息不能随需要凭空出现。','让辅轴改变反击的条件、路径或代价，并在关联节拍中保留可检查的因果。','保留受害者自己的目标与选择，反击结果要改变具体关系或资源。'],
    taboos:['避免用旁白反复宣布复仇而没有可见行动。','避免对手为方便主角获胜而忽然放弃既定能力。','避免一切失误都由重生记忆修正，使选择不再有后果。'],
    visualFingerprint:['用同一地点或道具在旧伤害与当前反击之间建立可辨认的对照。','优先安排能改变物品归属、站位或公开信息的动作，少用抽象胜利宣言。'],
  },
  'sweet-romance':{
    id:'sweet-romance',name:'甜宠',version:1,source:'camery-original',guidanceStatus:'unvalidated',
    rhythm:['先给双方各自要完成的事，让第一次靠近发生在具体协作或选择中。','在一次靠近后显露真实顾虑，再让行动回应顾虑，推动关系状态变化。','单元末用双方承担的小代价回收承诺，同时提出下一步相处的问题。'],
    rules:['双方拥有独立目标、拒绝和改变决定的空间，关心要通过对方能理解的行为表达。','每次误会说明信息缺口及未能澄清的具体原因，修复时给出新增行动。','若加入悬疑或复仇辅轴，让其改变信任的建立方式，而不仅是装饰背景。'],
    taboos:['避免把持续侵犯边界直接写成关心的证明。','避免只靠巧合重复制造同一场误会而不改变关系。','避免配角仅为促成亲密而失去自己的动机。'],
    visualFingerprint:['通过可重复的小物件、共同动作或距离变化表达关系进展。','为靠近与退缩设置可拍的动作差别，让台词之外也能读出选择。'],
  },
  suspense:{
    id:'suspense',name:'悬疑',version:1,source:'camery-original',guidanceStatus:'unvalidated',
    rhythm:['开篇给出一个具体异常及追查理由，避免只提出没有对象的神秘感。','每次查证回答一个局部问题，同时让已有事实产生一个更窄的新问题。','单元反转回到此前出现的线索，说明新解释怎样改变下一步行动。'],
    rules:['为关键结论记录可追溯的证据与推理步骤，区分角色猜测和已证实事实。','人物可以隐瞒信息，但揭示时必须能说明隐瞒动机及此前行为。','将线索安排进可见行动；辅轴应改变调查风险、解释或取证条件。'],
    taboos:['避免结尾才引入从未出现的决定性规则或证人。','避免把未公开的作者知识当成角色已经掌握的信息。','避免每次结尾都只中断一句话，却不改变观众正在追问的问题。'],
    visualFingerprint:['用可复查的痕迹、时间差和空间关系承载线索。','让同一画面细节在获得新证据后可以被重新解释，不依赖无法拍出的内心结论。'],
  },
} satisfies Record<GenreId,GenreProfile>);

export const OPENING_HOOK_LABELS=deepFreeze({conflict:'冲突',mystery:'悬念',danger:'危机',identity:'身份',contrast:'反差'} satisfies Record<z.infer<typeof OpeningHookType>,string>);
export const CLIFFHANGER_LABELS=deepFreeze({life_or_death:'生死悬念',partial_reveal:'信息揭一半',first_counterattack:'反击第一下',escalation:'更大危机',identity_near:'身份逼近',choice:'选择题'} satisfies Record<z.infer<typeof CliffhangerType>,string>);
export const DEFAULT_RULE_THRESHOLDS=deepFreeze({repeatedCliffhangerWindow:3,lowEmotionWindow:3,lowEmotionBelow:6,openingHookBySecond:3,stakesBySecond:10} satisfies RuleThresholds);

export function getGenreProfile(id:unknown):GenreProfile {
  return GENRE_PROFILES[capture(GenreId,id,'genre profile',256)];
}

export function captureRuleThresholds(input?:unknown):RuleThresholds {
  return deepFreeze(capture(RuleThresholdsSchema,input===undefined?DEFAULT_RULE_THRESHOLDS:input,'rule thresholds',2048));
}
