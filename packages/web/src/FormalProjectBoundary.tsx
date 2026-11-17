import {Component,type ReactNode} from 'react';

export function FormalProjectLoadError({onClose}:{onClose:()=>void}){
  return <aside className="development-warning" role="alert"><p>正式内容界面暂时无法加载。可关闭后继续处理当前内容，重新加载页面后再尝试打开。</p><button type="button" onClick={onClose}>关闭正式内容</button></aside>;
}
/** A failed deferred reader must never discard the surrounding drafts or authenticated session. */
export class FormalProjectBoundary extends Component<{children:ReactNode;onClose:()=>void},{failed:boolean}>{
  override state={failed:false};
  static getDerivedStateFromError(){return {failed:true};}
  override render(){return this.state.failed?<FormalProjectLoadError onClose={this.props.onClose}/>:this.props.children;}
}
