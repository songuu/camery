import {z} from 'zod';
import {StableId,RevisionRef} from './legacy/v05-schema';

export const OUTLINE_SCHEMA_VERSION='0.7.0-draft' as const;
export const OUTLINE_FORMAL_BYTES=16777216;
const text=(max:number)=>z.string().min(1).max(max).refine(value=>value.trim().length>0&&value.isWellFormed()&&!value.includes('\0'));
const integer=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const identity={id:StableId,version:integer.min(1)};
const appId=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$(?![\s\S])/);
const localId=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$(?![\s\S])/);
const hash=z.string().regex(/^[a-f0-9]{64}$(?![\s\S])/);
const episodeNumber=integer.min(1).max(100);
const refs=(max:number)=>z.array(RevisionRef).min(1).max(max);
const child={...identity,adaptation_plan:RevisionRef};

export const OutlineGenre=z.enum(['rebirth-revenge','sweet-romance','suspense']);
export type OutlineGenre=z.infer<typeof OutlineGenre>;
export const OutlineRuleThresholds=z.strictObject({
  repeated_cliffhanger_window:integer.min(2).max(100),low_emotion_window:integer.min(2).max(100),
  low_emotion_below:z.number().min(0).max(10),opening_hook_by_second:integer.min(1).max(60),stakes_by_second:integer.min(1).max(120),
});
export type OutlineRuleThresholds=z.infer<typeof OutlineRuleThresholds>;
export const OutlineOrigin=z.strictObject({kind:z.enum(['adapted','invented']),source_ref_ids:z.array(appId).max(64)});
export type OutlineOrigin=z.infer<typeof OutlineOrigin>;
export const OutlineCraftReport=z.strictObject({
  version:z.literal(1),kind:z.literal('craft_review'),rule_version:z.literal('outline-craft-v1'),thresholds:OutlineRuleThresholds,
  emotion_curve:z.array(z.strictObject({episode_number:episodeNumber,intensity:z.number().min(0).max(10)})).max(100),
  issues:z.array(z.strictObject({id:text(300),code:z.enum(['REPEATED_CLIFFHANGER','LOW_EMOTION','LATE_OPENING_HOOK','LATE_STAKES','ABLATION_REVIEW']),
    path:text(300),episode_numbers:z.array(episodeNumber).max(100),detail:text(2000)})).max(400),
});
export type OutlineCraftReport=z.infer<typeof OutlineCraftReport>;

const upstream=z.discriminatedUnion('kind',[
  z.strictObject({kind:z.literal('development'),run_id:appId,run_digest:hash,brief_digest:hash,foundation_review_digest:hash,episodes_review_digest:hash}),
  z.strictObject({kind:z.literal('bible'),run_id:appId,run_digest:hash,document_id:appId,revision:integer.min(1),source_digest:hash,review_digest:hash}),
]);

/** A reviewed narrative plan remains distinct from scenes, rendered media and their actual-use records. */
export const AdaptationPlan=z.strictObject({
  ...identity,
  brief:z.strictObject({notes:text(2000),episode_count:episodeNumber,target_seconds:integer.min(1).max(3600),paid_episode_numbers:z.array(episodeNumber).max(100),
    main_genre:OutlineGenre,auxiliary_genres:z.array(OutlineGenre).max(2),thresholds:OutlineRuleThresholds,
    profiles:z.array(z.strictObject({id:OutlineGenre,version:z.literal(1),digest:hash})).min(1).max(3)}),
  source:z.strictObject({tenant_key:appId,project_key:appId,run_id:appId,run_digest:hash,brief_id:appId,brief_revision:integer.min(1),brief_digest:hash,
    candidate_digest:hash,review_digest:hash,source_digest:hash,reviewer_id:StableId,reviewer_key:appId,reviewed_at:z.iso.datetime({precision:3}),
    upstream,references:z.array(z.strictObject({id:appId,path:text(256)})).min(1).max(2048)}),
  method:z.strictObject({id:z.string().regex(/^[a-z][a-z0-9.-]{0,79}$(?![\s\S])/),version:z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$(?![\s\S])/),digest:hash}),
  adaptation:z.strictObject({title:text(120),logline:text(1000),audience:text(500),promise:text(1000),central_conflict:text(1000)}),
  recipe:z.strictObject({main_genre:OutlineGenre,auxiliary_genres:z.array(OutlineGenre).max(2),collision:text(1000),
    signature_scenes:z.array(z.strictObject({key:localId,description:text(1000),beats:refs(500)})).min(1).max(32),
    failure_modes:z.array(text(500)).min(1).max(16),
    ablations:z.array(z.strictObject({genre:OutlineGenre,affected_beats:refs(500),removal_effect:text(1000),mainline_survives:z.boolean(),reason:text(1000)})).max(2)}),
  characters:z.array(z.strictObject({character:RevisionRef,origin:OutlineOrigin})).min(1).max(64),
  decisions:refs(128),beats:refs(500),episodes:refs(100),assets:refs(256),plot_units:refs(100),
  season_engine:z.strictObject({central_question:text(1000),protagonist_goal:text(1000),opposition:text(1000),repeatable_pressure:text(1000),
    escalation:text(1000),end_state:text(1000),characters:refs(500),plot_units:refs(500)}),
  review:z.strictObject({report:OutlineCraftReport,
    ablations:z.array(z.strictObject({genre:OutlineGenre,judgment:z.enum(['participates','label_only']),reason:text(1000)})).max(2),
    waivers:z.array(z.strictObject({issue_id:text(300),reason:text(1000)})).max(400)}),
});
export type AdaptationPlan=z.infer<typeof AdaptationPlan>;

export const OutlineBeat=z.strictObject({...child,episode_number:episodeNumber,order:integer.min(1).max(500),characters:refs(500),
  goal:text(500),conflict:text(500),turn:text(500),consequence:text(500),origin:OutlineOrigin,
});
export type OutlineBeat=z.infer<typeof OutlineBeat>;

export const OutlineEpisodePlan=z.strictObject({...child,episode_id:StableId,number:episodeNumber,title:text(120),synopsis:text(2000),beats:refs(500),
  opening_hook:z.strictObject({type:z.enum(['conflict','mystery','danger','identity','contrast']),text:text(500),beat:RevisionRef,estimated_second:integer.max(3600)}),
  stakes:z.strictObject({text:text(500),beat:RevisionRef,estimated_second:integer.max(3600)}),
  cliffhanger:z.strictObject({type:z.enum(['life_or_death','partial_reveal','first_counterattack','escalation','identity_near','choice']),text:text(500),beat:RevisionRef}),
  emotion_intensity:z.number().min(0).max(10),paid_breakpoint:z.boolean(),
});
export type OutlineEpisodePlan=z.infer<typeof OutlineEpisodePlan>;

/** These rows express planned narrative resources; no readiness, URI or materialization fields are accepted. */
export const AssetPlan=z.strictObject({...child,kind:z.enum(['character','location','prop','appearance','sfx','music','vfx']),
  name:text(120),description:text(1000),narrative_role:text(1000),character:RevisionRef.nullable(),beats:refs(500),origin:OutlineOrigin,
  prop_states:z.array(z.strictObject({beat:RevisionRef,before:text(500),after:text(500),reason:text(500)})).max(100),
});
export type AssetPlan=z.infer<typeof AssetPlan>;

export const OutlinePlotUnit=z.strictObject({...child,episodes:refs(100),beats:refs(500),pressure:text(1000),escalation:text(1000),
  reversal:text(1000),release:text(1000),next_crisis:text(1000),
});
export type OutlinePlotUnit=z.infer<typeof OutlinePlotUnit>;

export const OutlineAdaptationDecision=z.strictObject({...child,action:z.enum(['keep','merge','cut','invent']),reason:text(1000),source_ref_ids:z.array(appId).max(64)});
export type OutlineAdaptationDecision=z.infer<typeof OutlineAdaptationDecision>;
