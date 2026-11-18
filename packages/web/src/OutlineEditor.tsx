import {useId,useState,type ReactNode} from 'react';
import type {OutlineOutput} from '@camery/script/outline/contracts';
import type {OutlineSourceView} from '@camery/script/outline/http';

interface Props {output:OutlineOutput;source:OutlineSourceView;onChange:(next:OutlineOutput)=>void;disabled:boolean}
type Path=readonly (string|number)[];
type Row=Record<string,unknown>;
type Choice={id:string;name:string};
type Spec={key:string;label:string;kind:'text'|'number'|'boolean'|'enum'|'references'|'reference'|'object'|'rows'|'id';max?:number;min?:number;step?:number|'any';choices?:readonly Choice[];group?:'sources'|'characters'|'beats'|'units'|'episodes'|'genres';fields?:readonly Spec[];create?:()=>unknown;nullable?:boolean;numeric?:boolean};
const choice=(pairs:readonly (readonly [string,string])[]):Choice[]=>pairs.map(([id,name])=>({id,name}));
const genres=choice([['rebirth-revenge','复仇重生'],['sweet-romance','甜宠爱情'],['suspense','悬疑']]);
const text=(key:string,label:string,max=1000):Spec=>({key,label,kind:'text',max});
const number=(key:string,label:string,min=1,max=100,step:number|'any'=1):Spec=>({key,label,kind:'number',min,max,step});
const select=(key:string,label:string,pairs:readonly (readonly [string,string])[]):Spec=>({key,label,kind:'enum',choices:choice(pairs)});
const reference=(key:string,label:string,group:NonNullable<Spec['group']>,nullable=false):Spec=>({key,label,group,kind:'reference',nullable});
const references=(key:string,label:string,group:NonNullable<Spec['group']>,max=500,numeric=false):Spec=>({key,label,group,max,numeric,kind:'references'});
const object=(key:string,label:string,fields:readonly Spec[]):Spec=>({key,label,fields,kind:'object'});
const rows=(key:string,label:string,fields:readonly Spec[],create:()=>unknown,max:number,min=0):Spec=>({key,label,fields,create,max,min,kind:'rows'});
const stableId:Spec={key:'id',label:'稳定标识',kind:'id'};
const fresh=(prefix:string)=>`${prefix}-${crypto.randomUUID()}`;
const origin=()=>({kind:'invented',sourceRefIds:[]});
const originSpec=object('origin','来源说明',[
  select('kind','来源性质',[['adapted','改编自来源'],['invented','新增创作']]),references('sourceRefIds','来源引用','sources',64),
]);
const beatReference=reference('beatId','关联节拍','beats');
const sections:readonly Spec[]=[
  object('adaptation','改编说明',[
    text('title','故事标题',120),text('logline','一句话故事'),text('audience','目标观众',500),text('promise','类型承诺'),text('centralConflict','中心冲突'),
    rows('decisions','改编取舍',[stableId,select('action','取舍动作',[['keep','保留'],['merge','合并'],['cut','删去'],['invent','新增']]),text('reason','取舍理由'),references('sourceRefIds','来源引用','sources',64)],()=>({id:fresh('decision'),action:'invent',reason:'',sourceRefIds:[]}),128,1),
  ]),
  object('recipe','题材配方',[
    {key:'mainGenre',label:'主题材',kind:'enum',choices:genres},references('auxiliaryGenres','辅助题材','genres',2),text('collision','题材碰撞'),
    rows('signatureScenes','标志场景',[stableId,text('description','场景描述'),references('beatIds','关联节拍','beats')],()=>({id:fresh('scene'),description:'',beatIds:[]}),32,1),
    rows('failureModes','失效模式',[text('value','应避免的失效模式',500)],()=>'',16,1),
    rows('ablations','抽离测试',[{key:'genre',label:'抽离题材',kind:'enum',choices:genres},references('affectedBeatIds','受影响节拍','beats'),text('removalEffect','抽离后的效果'),{key:'mainlineSurvives',label:'主线仍成立',kind:'boolean'},text('reason','判断理由')],()=>({genre:'suspense',affectedBeatIds:[],removalEffect:'',mainlineSurvives:false,reason:''}),2),
  ]),
  rows('characters','人物表',[stableId,text('name','人物姓名',120),select('function','人物职能',[['protagonist','主角'],['antagonist','对抗者'],['supporting','配角']]),text('desire','人物欲望',500),text('obstacle','人物阻力',500),text('arc','人物弧光'),originSpec],()=>({id:fresh('character'),name:'',function:'supporting',desire:'',obstacle:'',arc:'',origin:origin()}),64,1),
  rows('beats','节拍表',[stableId,number('episodeNumber','所属集号'),number('order','集内顺序',1,500),references('characterIds','涉及人物','characters'),text('goal','节拍目标',500),text('conflict','节拍冲突',500),text('turn','转折',500),text('consequence','后果',500),originSpec],()=>({id:fresh('beat'),episodeNumber:1,order:1,characterIds:[],goal:'',conflict:'',turn:'',consequence:'',origin:origin()}),500,1),
  rows('episodes','分集梗概',[
    number('number','集号'),text('title','分集标题',120),text('synopsis','分集梗概',2000),references('beatIds','本集节拍','beats'),
    object('openingHook','开场钩子',[select('type','钩子类型',[['conflict','冲突'],['mystery','谜团'],['danger','危险'],['identity','身份'],['contrast','反差']]),text('text','钩子内容',500),beatReference,number('estimatedSecond','预计秒数',0,3600)]),
    object('stakes','代价与赌注',[text('text','赌注内容',500),beatReference,number('estimatedSecond','预计秒数',0,3600)]),
    object('cliffhanger','集末悬念',[select('type','悬念类型',[['life_or_death','生死关头'],['partial_reveal','局部揭晓'],['first_counterattack','首次反击'],['escalation','局势升级'],['identity_near','身份将揭'],['choice','艰难抉择']]),text('text','悬念内容',500),beatReference]),
    number('emotionIntensity','情绪强度',0,10,'any'),{key:'paidBreakpoint',label:'付费卡点',kind:'boolean'},
  ],()=>({number:1,title:'',synopsis:'',beatIds:[],openingHook:{type:'conflict',text:'',beatId:'',estimatedSecond:0},stakes:{text:'',beatId:'',estimatedSecond:0},cliffhanger:{type:'choice',text:'',beatId:''},emotionIntensity:5,paidBreakpoint:false}),100,1),
  rows('assets','资产规划清单',[
    stableId,select('kind','资产类型',[['character','人物'],['location','场景'],['prop','道具'],['appearance','形象'],['sfx','音效'],['music','音乐'],['vfx','视效']]),text('name','资产名称',120),text('description','资产描述'),text('narrativeRole','叙事用途'),reference('characterId','关联人物','characters',true),references('beatIds','关联节拍','beats'),originSpec,
    rows('propStates','道具状态变化',[beatReference,text('before','变化前',500),text('after','变化后',500),text('reason','变化理由',500)],()=>({beatId:'',before:'',after:'',reason:''}),100),
  ],()=>({id:fresh('asset'),kind:'prop',name:'',description:'',narrativeRole:'',characterId:null,beatIds:[],origin:origin(),propStates:[]}),256,1),
  rows('plotUnits','PlotUnit',[stableId,references('episodeNumbers','涉及集号','episodes',100,true),references('beatIds','关联节拍','beats'),text('pressure','压力'),text('escalation','升级'),text('reversal','反转'),text('release','释放'),text('nextCrisis','下一危机')],()=>({id:fresh('unit'),episodeNumbers:[],beatIds:[],pressure:'',escalation:'',reversal:'',release:'',nextCrisis:''}),100,1),
  object('seasonEngine','季冲突引擎',[text('centralQuestion','核心问题'),text('protagonistGoal','主角目标'),text('opposition','对抗力量'),text('repeatablePressure','持续压力'),text('escalation','升级机制'),text('endState','季末状态'),references('characterIds','涉及人物','characters'),references('plotUnitIds','关联PlotUnit','units')]),
];

function valueAt(value:unknown,path:Path):unknown{return path.reduce<unknown>((current,key)=>(current as Row)[key],value);}
function replacing(value:unknown,path:Path,next:unknown):unknown{
  if(!path.length)return next;
  const [key,...rest]=path;
  if(Array.isArray(value))return value.map((item,index)=>index===key?replacing(item,rest,next):item);
  const row=value as Row;return {...row,[key!]:replacing(row[key!],rest,next)};
}
interface Context {output:OutlineOutput;source:OutlineSourceView;disabled:boolean;change:(path:Path,next:unknown)=>void}
function ownValue(value:unknown,key:string):unknown{
  if(value===null||typeof value!=='object')return undefined;
  const descriptor=Object.getOwnPropertyDescriptor(value,key);return descriptor&&'value' in descriptor?descriptor.value:undefined;
}
function frozenSourceLabel(material:unknown,path:string,index:number):string{
  let value=material;
  // JSON pointer resolution must not read a prototype or execute an accessor, even for an unavailable citation.
  if(path.startsWith('/')&&!/~(?![01])/.test(path))for(const part of path.slice(1).split('/'))value=ownValue(value,part.replace(/~1/g,'/').replace(/~0/g,'~'));
  else value=undefined;
  const prose=typeof value==='string'?value:['name','title','text','description'].map(key=>ownValue(value,key)).find(item=>typeof item==='string'&&item.trim());
  const text=typeof prose==='string'?prose.trim().replace(/\s+/g,' '):path;const characters=Array.from(text);
  return `来源 ${index+1} · ${characters.slice(0,60).join('')}${characters.length>60?'…':''}`;
}
function choicesFor(spec:Spec,ctx:Context):readonly Choice[]{
  switch(spec.group){
    case 'sources':return ctx.source.references.map((row,index)=>({id:row.id,name:frozenSourceLabel(ctx.source.material,row.path,index)}));
    case 'characters':return ctx.output.characters.map(row=>({id:row.id,name:`${row.name||'未命名人物'} · ${row.id}`}));
    case 'beats':return ctx.output.beats.map(row=>({id:row.id,name:`第 ${row.episodeNumber} 集 · ${row.goal||'未填写目标'} · ${row.id}`}));
    case 'units':return ctx.output.plotUnits.map(row=>({id:row.id,name:`${row.pressure||'未填写压力'} · ${row.id}`}));
    case 'episodes':return ctx.output.episodes.map(row=>({id:String(row.number),name:`第 ${row.number} 集 · ${row.title}`}));
    case 'genres':return genres;
    default:return spec.choices??[];
  }
}
function InputField({spec,value,path,ctx}:{spec:Spec;value:unknown;path:Path;ctx:Context}){
  const inputId=useId();const labelId=`${inputId}-label`;const options=choicesFor(spec,ctx);
  const change=(next:unknown)=>ctx.change(path,next);
  if(spec.kind==='references')return <ReferenceChoices spec={spec} value={value as readonly (string|number)[]} options={options} disabled={ctx.disabled} onChange={change}/>;
  let input:ReactNode;
  if(spec.kind==='id')input=<output id={inputId} className="outline-id">{String(value)}</output>;
  else if(spec.kind==='text')input=<textarea id={inputId} aria-labelledby={labelId} value={String(value)} maxLength={spec.max} rows={spec.max&&spec.max<=120?2:3} disabled={ctx.disabled} onChange={event=>change(event.target.value)}/>;
  else if(spec.kind==='number')input=<input id={inputId} aria-labelledby={labelId} type="number" value={value as number} min={spec.min} max={spec.max} step={spec.step} disabled={ctx.disabled} onChange={event=>change(Number(event.target.value))}/>;
  else if(spec.kind==='boolean')input=<input id={inputId} aria-labelledby={labelId} type="checkbox" checked={Boolean(value)} disabled={ctx.disabled} onChange={event=>change(event.target.checked)}/>;
  else{
    const selected=value===null?'':value as string;const missing=selected!==''&&!options.some(option=>option.id===selected);
    input=<select id={inputId} aria-labelledby={labelId} value={selected} disabled={ctx.disabled} onChange={event=>change(spec.nullable&&event.target.value===''?null:event.target.value)}>
      <option value="">{spec.nullable?'不关联人物':'请选择'}</option>{missing&&<option value={selected}>已失效：{selected}</option>}{options.map((option,index)=><option key={`${option.id}:${index}`} value={option.id}>{option.name}</option>)}
    </select>;
  }
  return <label className={`outline-field${spec.kind==='boolean'?' outline-checkbox':''}`} htmlFor={inputId}><span id={labelId}>{spec.label}</span>{input}</label>;
}
function ReferenceChoices({spec,value,options,disabled,onChange}:{spec:Spec;value:readonly (string|number)[];options:readonly Choice[];disabled:boolean;onChange:(next:unknown)=>void}){
  const [search,setSearch]=useState('');const [requested,setPage]=useState(0);
  const selected=value.map(String);const filtered=options.filter(option=>option.name.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  const pages=Math.max(1,Math.ceil(filtered.length/20));const page=Math.min(requested,pages-1);
  const remove=(id:string)=>onChange(value.filter(item=>String(item)!==id));
  return <fieldset className="outline-references" disabled={disabled}><legend>{spec.label}</legend>
    <label className="outline-field"><span>查找{spec.label}</span><input value={search} disabled={disabled} onChange={event=>{setSearch(event.target.value);setPage(0);}}/></label>
    <div className="outline-selected">{value.map((item,index)=>{const found=options.find(option=>option.id===String(item));return <span className={found?'':'outline-missing'} key={`${item}:${index}`}>{found?found.name:`已失效：${item}`} <button type="button" disabled={disabled} onClick={()=>remove(String(item))}>移除引用</button></span>;})}</div>
    {filtered.slice(page*20,page*20+20).map((option,index)=><label key={`${option.id}:${index}`}><input type="checkbox" value={option.id} disabled={disabled||!selected.includes(option.id)&&value.length>=(spec.max??500)} checked={selected.includes(option.id)} onChange={event=>event.target.checked?onChange([...value,spec.numeric?Number(option.id):option.id]):remove(option.id)}/>{option.name}</label>)}
    {!filtered.length&&<p className="outline-hint">暂无匹配条目</p>}
    {pages>1&&<nav className="outline-pagination" aria-label={`${spec.label}选项分页`}><button type="button" disabled={page===0} onClick={()=>setPage(page-1)}>上一页</button><span>{page+1} / {pages}</span><button type="button" disabled={page===pages-1} onClick={()=>setPage(page+1)}>下一页</button></nav>}
  </fieldset>;
}
function Fields({specs,path,ctx}:{specs:readonly Spec[];path:Path;ctx:Context}){
  return <>{specs.map(spec=><FieldNode key={spec.key} spec={spec} path={[...path,spec.key]} ctx={ctx}/>)}</>;
}
function FieldNode({spec,path,ctx}:{spec:Spec;path:Path;ctx:Context}){
  const value=valueAt(ctx.output,path);
  if(spec.kind==='object')return <fieldset className="outline-section"><legend>{spec.label}</legend><Fields specs={spec.fields!} path={path} ctx={ctx}/></fieldset>;
  if(spec.kind==='rows')return <Rows spec={spec} path={path} ctx={ctx} items={value as readonly unknown[]}/>;
  return <InputField spec={spec} path={path} ctx={ctx} value={value}/>;
}
function Rows({spec,path,ctx,items}:{spec:Spec;path:Path;ctx:Context;items:readonly unknown[]}){
  const [requested,setPage]=useState(0);const total=Math.max(1,Math.ceil(items.length/5));const page=Math.min(requested,total-1);
  const add=()=>{ctx.change(path,[...items,spec.create!()]);setPage(Math.floor(items.length/5));};
  const move=(from:number,to:number)=>{const next=[...items];[next[from],next[to]]=[next[to],next[from]];ctx.change(path,next);setPage(Math.floor(to/5));};
  return <section className="outline-section"><div className="outline-section-heading"><h3>{spec.label}</h3><span>共 {items.length} 项</span><button type="button" disabled={ctx.disabled||items.length>=spec.max!} onClick={add}>添加{spec.label}</button></div>
    {items.slice(page*5,page*5+5).map((item,offset)=>{const index=page*5+offset;const rowPath=[...path,index];const stable=typeof item==='object'&&item!==null?'id' in item?String(item.id):index:index;
      return <div className="outline-row" key={stable}><div className="outline-section-heading"><h4>{spec.label} {index+1}</h4><div className="outline-actions"><button type="button" disabled={ctx.disabled||index===0} onClick={()=>move(index,index-1)}>上移{spec.label}</button><button type="button" disabled={ctx.disabled||index===items.length-1} onClick={()=>move(index,index+1)}>下移{spec.label}</button><button type="button" disabled={ctx.disabled||items.length<=(spec.min??0)} onClick={()=>ctx.change(path,items.filter((_,i)=>i!==index))}>删除{spec.label}</button></div></div>
        {typeof item==='string'?<InputField spec={spec.fields![0]!} value={item} path={rowPath} ctx={ctx}/>:<Fields specs={spec.fields!} path={rowPath} ctx={ctx}/>}</div>;
    })}
    {!items.length&&<p className="outline-hint">暂无条目，可按创作需要添加。</p>}
    {total>1&&<nav className="outline-pagination" aria-label={`${spec.label}分页`}><button type="button" disabled={page===0} onClick={()=>setPage(page-1)}>上一页</button><span>{page+1} / {total}</span><button type="button" disabled={page===total-1} onClick={()=>setPage(page+1)}>下一页</button></nav>}
  </section>;
}
/** Controlled prose and reference edits preserve fields outside the active page; the parent owns validation and human submission. */
export function OutlineEditor({output,source,onChange,disabled}:Props){
  const ctx:Context={output,source,disabled,change:(path,next)=>onChange(replacing(output,path,next) as OutlineOutput)};
  return <div className="outline-editor">{sections.map((spec,index)=><details className="outline-editor-piece" key={spec.key} open={index===0}><summary>{String(index+1).padStart(2,'0')} · {spec.label}</summary><FieldNode spec={spec} path={[spec.key]} ctx={ctx}/></details>)}</div>;
}
