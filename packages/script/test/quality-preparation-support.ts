import {qualityDigest} from '../src/quality/node/data.js';
import type {QualitySource} from '../src/quality/node/source.js';
import {qualityScreenplaySourceFixture} from './quality-screenplay-source-support.js';

/** Pure protocol fixture: a real scene participant outside the adopted character plan can retain an unknown legacy role. */
export function addPreparationUnknownRole(f:Awaited<ReturnType<typeof qualityScreenplaySourceFixture>>,suffix='one'){
  const character={...structuredClone(f.state.head.characters[0]!),id:f.id('quality-unknown-role-'+suffix),name:'未定职责'+suffix,role:'主角的朋友，但职责尚未确认。'};delete character.development;
  f.state.head.characters.push(character);f.state.progress.preparation.candidate=structuredClone(f.state.progress.preparation.candidate);f.state.progress.preparation.candidate.draft.scenes[0]!.characterIds.push(character.id);f.rebuild();return character;
}
/** Rehashing proves only local integrity. These helpers cannot replace the actual historical source readers. */
export function rehashPreparationRecord<T extends {digest:string}>(input:T):T{const {digest:_digest,...body}=input;return {...input,digest:qualityDigest(body)};}
export function preparationSourceCopy(input:QualitySource){return structuredClone(input);}
