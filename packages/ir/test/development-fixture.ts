import {upgradeV05Package} from '../src/index';
import {fixtureId,makePackage} from './fixtures';
const id=fixtureId;
export function makeDevelopmentPackage(){
  const p=upgradeV05Package(makePackage());const character=p.characters[0]!;const episode=p.episodes[0]!;character.development={function:'protagonist',desire:'公开核对来信。',obstacle:'同伴不信任未来的信息。',arc:'从独自校准到共同核实。'};
  const source={tenant_key:'tenant',project_key:'project',run_id:'development-run',run_digest:'e'.repeat(64),brief_id:'idea',brief_revision:1,brief_digest:'a'.repeat(64),candidate_digest:'b'.repeat(64),review_digest:'c'.repeat(64),reviewer_id:id('user_review'),reviewer_key:'reviewer',reviewed_at:'2026-11-17T04:00:00.000Z'};
  p.worlds.push({id:id('world'),version:1,setting:'港城',era:'近未来',rules:[{key:'tide',text:'潮汐时刻可重复核对。'}]});
  p.development_plans.push({id:id('development'),version:1,title:'潮汐来信',brief:{idea:'修钟学徒收到未来的潮汐来信。',episode_count:2,target_seconds:120},world:{id:id('world'),version:1},characters:[{id:character.id,version:character.version}],relationships:[],mainline:{premise:'来信记下明日的潮汐。',central_conflict:'是否公开未经证实的消息。',stakes:'港口可能停摆。',progression:'先核对再公开。',resolution:'共同建立核验机制。',character_ids:[character.id],rule_refs:[{world_id:id('world'),key:'tide'}]},open_questions:[{key:'sender',text:'谁寄出了来信？'}],source:{...source,stage:'foundation'}});
  p.episode_plans.push({id:id('episode-plan'),version:1,episode_id:episode.id,number:1,development_plan:{id:id('development'),version:1},summary:'学徒发现来信与潮汐表一致。',goal:'验证来信。',conflict:'需要说服港口值守。',turn:'出现反向证据。',ending:'决定公开核对过程。',characters:[{id:character.id,version:character.version}],rule_refs:[{world_id:id('world'),key:'tide'}],source:{...source,stage:'episodes'}});
  return p;
}
