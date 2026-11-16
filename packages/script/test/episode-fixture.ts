import type { EpisodeOutput } from '../src/contracts.js';
import { captureBrief } from '../src/brief.js';
import { foundationFixture } from './foundation-fixture.js';

/** Original protocol fixture; these outlines are not evidence of model quality or adopted scripts. */
export function episodeFixture(episodeCount=10) {
  const brief=captureBrief({tenantId:'tenant',projectId:'project',briefId:'tide-letters',revision:1,
    idea:'送信人收到二十年后的自己寄来的潮汐时刻表，必须在港城停摆前决定是否相信它。',episodeCount,targetSeconds:120});
  const foundation=foundationFixture();
  const output:EpisodeOutput={episodes:Array.from({length:episodeCount},(_,index)=>({number:index+1,title:`潮汐来信 ${index+1}`,
    summary:`林舟核对第${index+1}封信中的潮汐记录，并发现时刻表与港城钟声相互矛盾。`,goal:'在退潮前送达信件。',
    conflict:'未来的林舟要求他绕开修钟人梅。',turn:'林舟发现修钟人的批注早于信件。',ending:index===episodeCount-1?'林舟选择公开时刻表，港城共同决定下一次钟声。':'下一封信的落款变成了梅。',
    characterIds:['lin','mei'],ruleIds:['tide','clock']}))};
  return {brief,foundation,output};
}
