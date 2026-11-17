import { describe,expect,it } from 'vitest';
import { CliffhangerType,GenreId,OpeningHookType,OutlineError } from '../src/outline/contracts.js';
import { captureRuleThresholds,CLIFFHANGER_LABELS,DEFAULT_RULE_THRESHOLDS,GENRE_PROFILES,getGenreProfile,OPENING_HOOK_LABELS } from '../src/outline/profiles.js';

describe('original genre guidance',()=>{
  it('provides exactly three immutable original, versioned and unvalidated profiles',()=>{
    expect(Object.keys(GENRE_PROFILES)).toEqual(GenreId.options);
    for(const id of GenreId.options){
      const profile=getGenreProfile(id);
      expect(profile).toBe(GENRE_PROFILES[id]);
      expect(profile).toMatchObject({id,version:1,source:'camery-original',guidanceStatus:'unvalidated'});
      expect(profile.name.length).toBeGreaterThan(0);
      for(const field of ['rhythm','rules','taboos','visualFingerprint'] as const){
        expect(profile[field].length).toBeGreaterThan(1);expect(Object.isFrozen(profile[field])).toBe(true);
        expect(profile[field].every(value=>value.trim().length>0)).toBe(true);
      }
      expect(Object.isFrozen(profile)).toBe(true);expect(profile).not.toHaveProperty('qualityScore');expect(profile).not.toHaveProperty('approved');
    }
    expect(Object.isFrozen(GENRE_PROFILES)).toBe(true);
    expect(new Set(GenreId.options.map(id=>getGenreProfile(id).rhythm.join('|'))).size).toBe(3);
  });
  it.each(['unknown','',null,undefined,{},['suspense'],0])('rejects unregistered genre %#',input=>{
    expect(()=>getGenreProfile(input)).toThrow(OutlineError);
  });
  it('labels every fixed hook and cliffhanger type with the documented Chinese category',()=>{
    expect(Object.keys(OPENING_HOOK_LABELS)).toEqual(OpeningHookType.options);
    expect(Object.values(OPENING_HOOK_LABELS)).toEqual(['冲突','悬念','危机','身份','反差']);
    expect(Object.keys(CLIFFHANGER_LABELS)).toEqual(CliffhangerType.options);
    expect(Object.values(CLIFFHANGER_LABELS)).toEqual(['生死悬念','信息揭一半','反击第一下','更大危机','身份逼近','选择题']);
    expect(Object.isFrozen(OPENING_HOOK_LABELS)).toBe(true);expect(Object.isFrozen(CLIFFHANGER_LABELS)).toBe(true);
  });
});

describe('explicit effective dramaturgy thresholds',()=>{
  const defaults={repeatedCliffhangerWindow:3,lowEmotionWindow:3,lowEmotionBelow:6,openingHookBySecond:3,stakesBySecond:10};
  it('uses frozen initial values only when no override is supplied',()=>{
    expect(DEFAULT_RULE_THRESHOLDS).toEqual(defaults);expect(captureRuleThresholds()).toEqual(defaults);
    expect(Object.isFrozen(DEFAULT_RULE_THRESHOLDS)).toBe(true);expect(Object.isFrozen(captureRuleThresholds())).toBe(true);
  });
  it('captures a complete override without retaining caller-owned mutable references',()=>{
    const input={...defaults,repeatedCliffhangerWindow:4,lowEmotionBelow:0,openingHookBySecond:1,stakesBySecond:120};
    const captured=captureRuleThresholds(input);expect(captured).toEqual(input);expect(captured).not.toBe(input);
    input.repeatedCliffhangerWindow=5;expect(captured.repeatedCliffhangerWindow).toBe(4);expect(Object.isFrozen(captured)).toBe(true);
    expect(captureRuleThresholds({...defaults,repeatedCliffhangerWindow:100,lowEmotionWindow:100,lowEmotionBelow:10,openingHookBySecond:60})).toMatchObject({repeatedCliffhangerWindow:100,lowEmotionBelow:10});
  });
  it.each([null,{},[],{...defaults,unknown:true},{...defaults,lowEmotionBelow:NaN},{...defaults,lowEmotionBelow:Infinity},
    {...defaults,lowEmotionBelow:-0.1},{...defaults,lowEmotionBelow:10.1},{...defaults,repeatedCliffhangerWindow:1},
    {...defaults,repeatedCliffhangerWindow:101},{...defaults,repeatedCliffhangerWindow:2.5},{...defaults,lowEmotionWindow:1},
    {...defaults,lowEmotionWindow:101},{...defaults,openingHookBySecond:0},{...defaults,openingHookBySecond:61},
    {...defaults,stakesBySecond:0},{...defaults,stakesBySecond:121},{...defaults,lowEmotionWindow:'3'},
  ])('rejects incomplete or invalid overrides %#',input=>{expect(()=>captureRuleThresholds(input)).toThrow(OutlineError);});
  it('does not execute accessors or leak hostile boundary exception messages',()=>{
    let called=false;
    const accessor=Object.defineProperty({...defaults},'stakesBySecond',{enumerable:true,get(){called=true;throw new Error('secret');}});
    expect(()=>captureRuleThresholds(accessor)).toThrow('INVALID_INPUT');expect(called).toBe(false);
    const proxy=new Proxy({},{ownKeys(){throw new Error('secret');}});
    expect(()=>captureRuleThresholds(proxy)).toThrow('INVALID_INPUT');expect(()=>captureRuleThresholds(proxy)).not.toThrow('secret');
    expect(()=>captureRuleThresholds({...defaults,extra:'a'.repeat(4096)})).toThrow('INPUT_LIMIT');
  });
});
