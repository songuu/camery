import {upgradeV06Package} from '../src/schema';
import type {AdaptationPlan,StoryboardPackageV07} from '../src/schema';
import {makeDevelopmentPackage} from './development-fixture';
import {fixtureId as id} from './fixtures';
export const outlineRef=(name:string)=>({id:id(name),version:1});
export function makeOutlinePackage():StoryboardPackageV07{
  const p=upgradeV06Package(makeDevelopmentPackage()),character=p.characters[0]!,episode=p.episodes[0]!,ref=outlineRef;
  const thresholds={repeated_cliffhanger_window:3,low_emotion_window:3,low_emotion_below:4,opening_hook_by_second:5,stakes_by_second:15};
  const plan:AdaptationPlan={...ref('outline-plan'),brief:{notes:'核对后公开钟塔来信。',episode_count:1,target_seconds:90,paid_episode_numbers:[1],main_genre:'rebirth-revenge',auxiliary_genres:[],thresholds,profiles:[{id:'rebirth-revenge',version:1,digest:'a'.repeat(64)}]},
    source:{tenant_key:'tenant',project_key:'project',run_id:'outline-run',run_digest:'a'.repeat(64),brief_id:'outline-brief',brief_revision:1,brief_digest:'b'.repeat(64),candidate_digest:'c'.repeat(64),review_digest:'d'.repeat(64),source_digest:'e'.repeat(64),reviewer_id:id('user_review'),reviewer_key:'reviewer',reviewed_at:'2026-11-18T03:00:00.000Z',upstream:{kind:'development',run_id:'old-development',run_digest:'f'.repeat(64),brief_digest:'a'.repeat(64),foundation_review_digest:'b'.repeat(64),episodes_review_digest:'c'.repeat(64)},references:[{id:'source:clock',path:'/foundation/world'}]},
    method:{id:'original-outline',version:'1.0.0',digest:'a'.repeat(64)},adaptation:{title:'停钟之夜',logline:'校钟者公开来信。',audience:'短剧观众',promise:'核对改变选择。',central_conflict:'谁能公开时刻表。'},
    recipe:{main_genre:'rebirth-revenge',auxiliary_genres:[],collision:'旧结局与新选择碰撞。',signature_scenes:[{key:'signature',description:'公开时刻表。',beats:[ref('outline-beat')]}],failure_modes:['避免凭空得知答案。'],ablations:[]},
    characters:[{character:{id:character.id,version:character.version},origin:{kind:'adapted',source_ref_ids:['source:clock']}}],decisions:[ref('outline-decision')],beats:[ref('outline-beat')],episodes:[ref('outline-episode')],assets:[ref('outline-asset')],plot_units:[ref('outline-unit')],
    season_engine:{central_question:'谁有权保存记忆？',protagonist_goal:'公开来信。',opposition:'钟塔管理者。',repeatable_pressure:'记忆逐步消失。',escalation:'最后一次敲钟。',end_state:'共同核验。',characters:[{id:character.id,version:character.version}],plot_units:[ref('outline-unit')]},
    review:{report:{version:1,kind:'craft_review',rule_version:'outline-craft-v1',thresholds,emotion_curve:[{episode_number:1,intensity:7}],issues:[]},ablations:[],waivers:[]}};
  p.adaptation_plans.push(plan);const adaptation_plan=ref('outline-plan'),origin={kind:'adapted' as const,source_ref_ids:['source:clock']};
  p.outline_beats.push({...ref('outline-beat'),adaptation_plan,episode_number:1,order:1,characters:[{id:character.id,version:character.version}],goal:'进入钟塔。',conflict:'钥匙被折断。',turn:'日期暴露调包。',consequence:'公开核对时刻表。',origin});
  p.outline_episode_plans.push({...ref('outline-episode'),adaptation_plan,episode_id:episode.id,number:1,title:'第一次敲钟',synopsis:'校钟者找出钥匙上的日期。',beats:[ref('outline-beat')],opening_hook:{type:'conflict',text:'守门人折断钥匙。',beat:ref('outline-beat'),estimated_second:2},stakes:{text:'记忆即将消失。',beat:ref('outline-beat'),estimated_second:8},cliffhanger:{type:'choice',text:'是否公开来信？',beat:ref('outline-beat')},emotion_intensity:7,paid_breakpoint:true});
  p.asset_plans.push({...ref('outline-asset'),adaptation_plan,kind:'prop',name:'旧钥匙',description:'铜制钥匙。',narrative_role:'公开核对的证据。',character:null,beats:[ref('outline-beat')],origin,prop_states:[{beat:ref('outline-beat'),before:'完整',after:'折断',reason:'阻止进入。'}]});
  p.outline_plot_units.push({...ref('outline-unit'),adaptation_plan,episodes:[ref('outline-episode')],beats:[ref('outline-beat')],pressure:'记忆消失。',escalation:'钥匙折断。',reversal:'日期反证。',release:'公开来信。',next_crisis:'钟声将至。'});
  p.outline_adaptation_decisions.push({...ref('outline-decision'),adaptation_plan,action:'keep',reason:'保留共同记忆主线。',source_ref_ids:['source:clock']});return p;
}
