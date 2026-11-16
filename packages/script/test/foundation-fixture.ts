import type { FoundationOutput } from '../src/contracts.js';

/** Original local story data; every call returns an independent mutable test input. */
export function foundationFixture():FoundationOutput {
  return {title:'潮钟停在退潮前',world:{setting:'雾潮港的码头每天只在退潮时开放，修钟铺守着最后一只报潮钟。',era:'架空的手工作坊时代',
    rules:[{id:'tide',text:'潮门只在报潮钟响后开放，错过时刻的信件必须等待下一次退潮。'},{id:'clock',text:'报潮钟的刻度可以人工校准，但每次改动都会在铜盘上留下痕迹。'}]},
  characters:[
    {id:'lin',name:'林舟',function:'protagonist',desire:'赶在潮门关闭前送出师父留下的最后一封信。',obstacle:'他必须先修好停摆的报潮钟，又不愿相信师父动过钟盘。',arc:'从只相信熟悉的人，走向用证据承担自己的判断。'},
    {id:'older-lin',name:'林舟',function:'antagonist',desire:'保住自己多年依赖的码头时刻表。',obstacle:'钟盘上的旧刻痕即将暴露他曾隐瞒的停航。',arc:'从掩盖旧事走向在众人面前承认责任。'},
    {id:'mei',name:'梅笙',function:'supporting',desire:'让滞留在港内的信件真正到达收信人手中。',obstacle:'她没有更改潮门安排的权力。',arc:'从独自绕路送信，转而组织等信的人共同核对时刻。'},
  ],relationships:[{id:'delivery',from:'lin',to:'mei',text:'修钟学徒与送信人因同一封旧信结伴。'},{id:'rivalry',from:'lin',to:'older-lin',text:'两个同名者争执钟盘刻痕的含义，身份始终独立。'}],
  mainline:{premise:'学徒发现停摆的钟和一封旧信记录了不同的退潮时刻。',centralConflict:'公开钟盘真相会让潮门停运，隐瞒则会让错误的时刻继续支配港城。',stakes:'旧信能否送达，以及港人能否重新决定自己的航期。',
    progression:'先查停钟，再核对两位同名者留下的修理记录，最后让等信的人共同见证一次校准。',resolution:'钟盘被公开校准，旧信在下一次退潮时送达，学徒保留了所有旧刻痕。',characterIds:['lin','older-lin','mei'],ruleIds:['tide','clock']},
  openQuestions:[{id:'letter',text:'旧信的收信人是否愿意出席公开校准？'}]};
}
