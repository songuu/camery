import {useEffect,useRef,useSyncExternalStore} from 'react';
import type {ApiClient} from './api.js';
import {FormalOutlineController} from './FormalOutlineState.js';
import {FormalOutlineView} from './FormalOutlineView.js';
import './formal-outline.css';

export interface FormalOutlinePaneProps{client:ApiClient;generation:number;projectId:string;onFailure:(error:unknown)=>void;onClose:()=>void;revision?:number}
/** Identity and project changes create the new read lifetime before a prior result can be rendered under them. */
export function FormalOutlinePane(props:FormalOutlinePaneProps){
  const context=useRef({client:props.client,generation:props.generation,projectId:props.projectId,revision:props.revision,key:0}),old=context.current;
  if(old.client!==props.client||old.generation!==props.generation||old.projectId!==props.projectId||old.revision!==props.revision)context.current={client:props.client,generation:props.generation,projectId:props.projectId,revision:props.revision,key:old.key+1};
  return <FormalOutlineSession key={context.current.key} {...props}/>;
}
function FormalOutlineSession({client,projectId,onFailure,onClose,revision}:FormalOutlinePaneProps){
  const reference=useRef<FormalOutlineController|null>(null);reference.current??=new FormalOutlineController(client,projectId,onFailure);const controller=reference.current,state=useSyncExternalStore(controller.subscribe,controller.snapshot,controller.snapshot);
  useEffect(()=>{controller.activate();void controller.load(revision);return()=>controller.close();},[controller,revision]);
  return <FormalOutlineView state={state} onRefresh={()=>{void controller.load(state.meta?.snapshotRevision);}} onCurrent={()=>{void controller.load();}} onCollection={collection=>{void controller.filter(collection);}} onMore={()=>{void controller.more();}} onOpen={ref=>{void controller.open(ref);}} onSection={section=>{void controller.section(section);}} onReference={target=>{void controller.reference(target);}} onClose={onClose}/>;
}
