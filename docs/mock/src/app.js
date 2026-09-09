/* meeshogi visual prototype. No external libraries, network calls or engine. */
'use strict';
const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const iconPaths = {
  book:'<path d="M4 3h13a2 2 0 0 1 2 2v16H6a3 3 0 0 1-3-3V5a2 2 0 0 1 1-2Z"/><path d="M3 17h16M7 3v14M11 7h4M11 11h4"/>',
  stats:'<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  settings:'<path d="m9 3-1 3-3 1 1 3-2 2 2 2-1 3 3 1 1 3h4l1-3 3-1-1-3 2-2-2-2 1-3-3-1-1-3Z"/><circle cx="11" cy="12" r="3"/>',
  search:'<circle cx="10" cy="10" r="6.5"/><path d="m15 15 5 5"/>',
  paste:'<rect x="5" y="5" width="14" height="16" rx="2"/><path d="M9 3h6v4H9zM9 12h6M9 16h5"/>',
  plus:'<path d="M12 5v14M5 12h14"/>',
  right:'<path d="m9 5 7 7-7 7"/>',
  left:'<path d="m15 5-7 7 7 7"/>',
  down:'<path d="m6 9 6 6 6-6"/>',
  close:'<path d="m6 6 12 12M6 18 18 6"/>',
  check:'<path d="m5 12 4 4L19 6"/>',
  filter:'<path d="M3 7h10M17 7h4M3 17h4M11 17h10"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
  more:'<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  sun:'<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5 19 19M5 19l1.5-1.5M17.5 6.5 19 5"/>',
  moon:'<path d="M20 14a8 8 0 0 1-10-10A8.5 8.5 0 1 0 20 14Z"/>',
  info:'<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/>',
  shield:'<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6Z"/><path d="m8 12 3 3 5-6"/>',
  user:'<circle cx="12" cy="8" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/>',
  phone:'<rect x="6" y="2" width="12" height="20" rx="3"/><path d="M10 18h4M10 5h4"/>',
  flip:'<path d="M4 9a8 8 0 0 1 14-4l2 3M20 3v5h-5M20 15a8 8 0 0 1-14 4l-2-3M4 21v-5h5"/>',
  play:'<path d="m8 4 12 8-12 8Z" fill="currentColor" stroke-width="1"/>',
  pause:'<path d="M8 5v14M16 5v14" stroke-width="3"/>',
  first:'<path d="M5 5v14M18 5l-8 7 8 7"/>',
  last:'<path d="M19 5v14M6 5l8 7-8 7"/>',
  branch:'<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="5" r="2"/><path d="M6 7v10M6 14c8 0 12-1 12-7"/>',
  download:'<path d="M12 3v12m-5-5 5 5 5-5M4 17v4h16v-4"/>',
  edit:'<path d="m14 4 6 6M4 20l1-6L16 3a2 2 0 0 1 3 0l2 2a2 2 0 0 1 0 3L10 19Z"/>',
  clock:'<circle cx="12" cy="12" r="9"/><path d="M12 6v6l4 2"/>',
  folder:'<path d="M3 6a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
  board:'<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18M15 3v18M3 9h18M3 15h18"/>',
  arrow:'<path d="M4 12h16m-6-6 6 6-6 6"/>'
};
const icon = name => `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${iconPaths[name] || iconPaths.info}</svg>`;
const iconButton = (name, label, action, attrs = '') => `<button class="icon-button" aria-label="${esc(label)}" data-action="${action}" ${attrs}>${icon(name)}</button>`;
const mascot = className => `<img class="mascot ${className || ''}" src="${state.theme==='dark'?DEMO.mascotDark:DEMO.mascot}" alt="王将の駒を持ったミーアキャット" draggable="false">`;
const pieceText = {P:'歩',L:'香',N:'桂',S:'銀',G:'金',B:'角',R:'飛',K:'玉','+P':'と','+L':'杏','+N':'圭','+S':'全','+B':'馬','+R':'龍'};
const STORAGE_KEY = 'meeshogi.design-preview.v1';
let persisted = {};
let storageAvailable = true;
try { persisted = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') || {}; } catch { storageAvailable = false; }
// Saved user text is always escaped; only allow known record IDs and scalar preferences.
const params = new URLSearchParams(location.search);
const state = {
  screen:'library', selected:'g1', move:32, branch:null, branchStep:0, flip:false, analysisTab:'candidates',
  query:'', resultFilter:'all', serviceFilter:'all', strategyFilter:'all', filterDraft:null,
  period:'month', month:9, strategyView:'self', importSource:'journal', importText:'', importSelf:'0',
  demoEmpty:params.get('empty') === '1', playing:null, analysing:null, libraryScroll:0,
  theme:params.get('theme') === 'dark' || persisted.theme === 'dark' ? 'dark' : 'light',
  platform:params.get('platform') === 'android' ? 'android' : 'ios',
  names:{wars:typeof persisted.names?.wars === 'string' ? persisted.names.wars.slice(0,500) : '',journal:typeof persisted.names?.journal === 'string' ? persisted.names.journal.slice(0,500) : ''},
  imported:Array.isArray(persisted.imported) ? persisted.imported.filter(x => x && ['import-wars','import-journal'].includes(x.id) && ['0','1','none'].includes(x.self)).filter((x,i,a)=>a.findIndex(y=>y.id===x.id)===i) : [],
  strategies:persisted.strategies && typeof persisted.strategies === 'object' && !Array.isArray(persisted.strategies) ? persisted.strategies : {},
  notes:persisted.notes && typeof persisted.notes === 'object' && !Array.isArray(persisted.notes) ? persisted.notes : {},
  progress:{g3:36}, paused:true
};
const baseRecords = [
  {id:'g1',kind:'journal',opponent:'sora_27',date:'2026/09/09',time:'19:42',self:0},
  {id:'g2',kind:'wars',opponent:'ao_ki',date:'2026/09/08',time:'20:16',self:1},
  {id:'g3',kind:'journal',opponent:'komadori',date:'2026/09/08',time:'12:30',self:1},
  {id:'g4',kind:'wars',opponent:'yama_to',date:'2026/09/07',time:'21:08',self:0},
  {id:'g5',kind:'journal',opponent:'haru_88',date:'2026/09/05',time:'18:54',self:0},
  {id:'g6',kind:'wars',opponent:'tsumugi',date:'2026/09/04',time:'22:10',self:1},
  {id:'g7',kind:'wars',opponent:'nagi_03',date:'2026/09/02',time:'19:32',self:0},
  {id:'g8',kind:'journal',opponent:'shiro_kuma',date:'2026/09/01',time:'20:05',self:0},
  {id:'g9',kind:'wars',opponent:'koma_neko',date:'2026/08/29',time:'18:20',self:1},
  {id:'g10',kind:'journal',opponent:'mugi_17',date:'2026/08/25',time:'21:35',self:0},
  {id:'g11',kind:'wars',opponent:'hinata',date:'2026/08/17',time:'20:12',self:0},
  {id:'g12',kind:'journal',opponent:'yuunagi',date:'2026/08/09',time:'11:03',self:0}
];
const serviceName = kind => kind === 'wars' ? '将棋ウォーズ' : '棋桜';
const countMoves = record => DEMO.games[record.kind].frames.length - 1;
const resultOf = record => record.self === null ? 'other' : record.self === (record.kind === 'wars' ? 1 : 0) ? 'win' : 'loss';
const rawStrategy = (record, which = 'self') => (which === 'self' ? record.self : 1-record.self) === 0 ? '居飛車' : record.kind === 'wars' ? '四間飛車' : '中飛車';
const knownStrategies = ['居飛車','四間飛車','中飛車','三間飛車','未分類'];
const strategyOf = (record, which = 'self') => knownStrategies.includes(state.strategies[`${record.id}-${which}`]) ? state.strategies[`${record.id}-${which}`] : record.self === null ? '未分類' : rawStrategy(record,which);
function records() {
  if(state.demoEmpty)return [];
  const imported = state.imported.map(x => ({id:x.id,kind:x.id.replace('import-',''),opponent:x.id==='import-wars'?'sample_ao':'sample_sora',date:'2026/09/09',time:x.id==='import-wars'?'21:03':'21:00',self:x.self==='none'?null:Number(x.self)}));
  return [...imported,...baseRecords].sort((a,b)=>(b.date+b.time).localeCompare(a.date+a.time));
}
const selectedRecord = () => records().find(x=>x.id===state.selected) || baseRecords[0];
function save() {
  try {
    localStorage.setItem(STORAGE_KEY,JSON.stringify({theme:state.theme,names:state.names,imported:state.imported,strategies:state.strategies,notes:state.notes}));
    storageAvailable = true;
    return true;
  } catch { storageAvailable=false; return false; }
}
function summary(list) {
  const wins=list.filter(r=>resultOf(r)==='win').length;
  const losses=list.filter(r=>resultOf(r)==='loss').length;
  return {wins,losses,total:wins+losses,rate:wins+losses?(wins/(wins+losses)*100).toFixed(1):'—'};
}
function setTheme(value, persist = true) {
  state.theme=value==='dark'?'dark':'light';
  document.documentElement.dataset.theme=state.theme;
  $$('.mascot').forEach(img=>img.src=state.theme==='dark'?DEMO.mascotDark:DEMO.mascot);
  $('meta[name="theme-color"]').content=state.theme==='dark'?'#28231e':'#fbf7ef';
  $$('[data-action="theme"]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.value===state.theme)));
  if(persist && !save()) toast('外観は切り替わりました。ブラウザへの保存は利用できません。');
}
function setPlatform(value) {
  state.platform=value==='android'?'android':'ios';
  $('#device').dataset.platform=state.platform;
  $$('[data-action="platform"]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.value===state.platform)));
}
let toastTimer;
function toast(message) {
  const el=$('#toast'); el.textContent=message;el.classList.add('visible');
  clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.classList.remove('visible'),4200);
}
function nav() {
  return `<nav class="nav-bar" aria-label="アプリのメインメニュー">${[['library','book','棋譜'],['stats','stats','戦績'],['settings','settings','設定']].map(([screen,name,label])=>`<button data-action="go" data-screen="${screen}" ${state.screen===screen?'aria-current="page"':''}>${icon(name)}<span>${label}</span></button>`).join('')}</nav>`;
}
function appBar() {
  return `<header class="app-bar"><a class="app-logo" href="#library">meeshogi<span>.</span></a><button class="sample-button" data-action="about">サンプル${icon('info')}</button></header>`;
}
function go(screen, changeHash = true) {
  if(!['library','analysis','stats','settings'].includes(screen)) screen='library';
  clearTimeout(toastTimer);$('#toast').classList.remove('visible');
  if(state.screen==='library') state.libraryScroll=$('.scroll-area')?.scrollTop||0;
  stopPlaying();
  if(state.screen==='analysis' && screen!=='analysis') state.branch=null;
  state.screen=screen;
  if(changeHash && location.hash!==`#${screen}`) history.pushState({screen},'',`#${screen}`);
  render();
  if(screen==='analysis')updateStepDisabled();
}
function render() {
  $('#app').innerHTML=state.screen==='library'?library():state.screen==='analysis'?analysis():state.screen==='stats'?statistics():settings();
  $$('[data-icon]').forEach(e=>e.innerHTML=icon(e.dataset.icon));
  $$('.chapter').forEach(e=>e.classList.toggle('active',e.dataset.screen===state.screen));
  setTheme(state.theme,false);
  if(state.screen==='library') $('.scroll-area').scrollTop=state.libraryScroll;
}
function filteredRecords() {
  const q=state.query.trim().toLocaleLowerCase();
  return records().filter(r=>(!q||`${r.opponent} ${serviceName(r.kind)} ${strategyOf(r)} ${r.date}`.toLocaleLowerCase().includes(q))&&(state.resultFilter==='all'||resultOf(r)===state.resultFilter)&&(state.serviceFilter==='all'||r.kind===state.serviceFilter)&&(state.strategyFilter==='all'||strategyOf(r)===state.strategyFilter));
}
function library() {
  const list=records(), month=summary(list.filter(r=>r.date.startsWith('2026/09')));
  return `<section class="screen ${list.length?'':'root-empty'}" aria-label="棋譜一覧">${appBar()}<div class="scroll-area"><div class="hero"><div class="hero-copy"><div class="eyebrow">YOUR SHOGI JOURNAL</div><h2>わたしの棋譜</h2><p>一局ずつ、強くなる。<br>今日の将棋を、ここに残そう。</p></div>${mascot()}</div>${list.length?`<div class="inset"><button class="month-summary" data-action="go" data-screen="stats" aria-label="9月の戦績を開く"><span class="summary-label">9月のあゆみ<br>2026</span><span class="summary-numbers"><span><b>${month.total}</b><small>局</small></span><span><b>${month.wins}</b><small>勝</small></span><span class="rate"><b>${month.rate}</b><small>%</small></span></span>${icon('right')}</button></div>`:''}<div class="import-cta"><button class="primary-button" data-action="import">${icon('paste')}棋譜を貼り付け</button></div>${list.length?`<div class="library-tools"><label class="search-field">${icon('search')}<input id="game-search" type="search" aria-label="棋譜を検索" placeholder="対局相手・戦型で検索" value="${esc(state.query)}" autocomplete="off"><button data-action="clear-search" aria-label="検索をクリア" ${state.query?'':'hidden'}>${icon('close')}</button></label><div class="filter-row" aria-label="勝敗で絞り込み">${[['all','すべて'],['win','勝ち'],['loss','負け']].map(([v,t])=>`<button class="filter-chip" data-action="result-filter" data-value="${v}" aria-pressed="${state.resultFilter===v}">${t}</button>`).join('')}<button class="filter-chip filter-more" data-action="filters" aria-label="サービスと戦型で絞り込み">${icon('filter')}絞り込み${state.serviceFilter!=='all'||state.strategyFilter!=='all'?'・':''}</button></div><div class="list-meta"><span id="record-count">${filteredRecords().length}局の棋譜</span><span>新しい順</span></div></div><div class="game-list" id="game-list">${gameList()}</div>`:`<div class="inset"><div class="empty-state">${mascot()}<h3>はじめの一局を、ここに。</h3><p>将棋ウォーズ・棋桜でコピーした棋譜を<br>貼り付けて、振り返りをはじめましょう。</p><div class="empty-rule"></div><p>登録なしで、あなたのペースで。</p><button class="text-button" data-action="restore-demo">サンプルの棋譜を見る ${icon('arrow')}</button></div></div>`}</div>${nav()}</section>`;
}
function gameList() {
  const list=filteredRecords();
  if(!list.length) return `<div class="empty-state">${mascot()}<h3>棋譜が見つかりませんでした</h3><p>検索する名前や、絞り込みの条件を<br>変えてみてください。</p><button class="text-button" data-action="reset-filters">検索と絞り込みをクリア</button></div>`;
  let lastDate='';
  return list.map(r=>{
    let heading='';
    if(r.date!==lastDate){lastDate=r.date;heading=`<h3 class="date-heading"><b>${r.date==='2026/09/09'?'今日':r.date==='2026/09/08'?'昨日':r.date.slice(5).replace('/','月')+'日'}</b><span>${r.date==='2026/09/09'?'9月9日 水曜日':r.date==='2026/09/08'?'9月8日 火曜日':''}</span></h3>`;}
    const result=resultOf(r),n=countMoves(r),progress=state.progress[r.id]??n;
    return `${heading}<button class="game-row" data-action="open-game" data-id="${r.id}" aria-label="${esc(r.opponent)}との棋譜を開く"><span class="result-mark ${result}">${result==='win'?'勝':result==='loss'?'負':'観'}</span><span class="game-body"><span class="game-title"><small class="vs">vs.</small><span>${esc(r.opponent)}</span></span><span class="game-detail"><span>${r.self===null?'観戦':r.self===0?'先手':'後手'}</span><span class="separator-dot">·</span><span>${n}手</span><span class="separator-dot">·</span><span>${esc(strategyOf(r))}</span></span><span class="game-bottom"><span>${serviceName(r.kind)} <span class="separator-dot">·</span> ${r.time}</span><span class="analysis-status ${progress<n?'pending':''}">${icon(progress<n?'clock':'check')}${progress<n?'解析途中のサンプル':'解析済みサンプル'}</span></span></span>${icon('right')}</button>`;
  }).join('');
}
function updateList() {
  const list=$('#game-list');if(!list)return;
  list.innerHTML=gameList();$('#record-count').textContent=`${filteredRecords().length}局の棋譜`;
  const clear=$('[data-action="clear-search"]');if(clear)clear.hidden=!state.query;
}
function openGame(id) {
  state.selected=id;state.branch=null;state.move=32;state.analysisTab='candidates';state.flip=false;go('analysis');
}
function currentFrame() {
  return state.branch?state.branch[state.branchStep]:DEMO.games[selectedRecord().kind].frames[state.move];
}
function boardMarkup() {
  const r=selectedRecord(), frame=currentFrame(), flipped=(r.self===1)!==state.flip;
  const indices=Array.from({length:81},(_,i)=>flipped?80-i:i);
  const ranks=flipped?'九八七六五四三二一':'一二三四五六七八九';
  const files=flipped?'１２３４５６７８９':'９８７６５４３２１';
  return `<div class="board-coordinates" aria-hidden="true">${[...files].map(x=>`<span>${x}</span>`).join('')}</div><div class="board-and-ranks"><div class="shogi-board" role="img" aria-label="${state.branch?'分岐検討':state.move+'手目'}の将棋盤。${flipped?'後手':'先手'}が手前。">${indices.map(i=>{
    const p=frame.board[i],upper=p.toUpperCase(),opponent=p&&((p.slice(-1)===p.slice(-1).toLowerCase())!==flipped);
    const highlighted=i===frame.to?'last-move':i===frame.from?'previous-move':'';
    return `<div class="square ${highlighted}">${p?`<span class="shogi-piece ${opponent?'opponent':''} ${p.startsWith('+')?'promoted':''}">${pieceText[upper]}</span>`:''}</div>`;
  }).join('')}</div><div class="board-ranks" aria-hidden="true">${[...ranks].map(x=>`<span>${x}</span>`).join('')}</div></div>`;
}
function player(side) {
  const r=selectedRecord(),frame=currentFrame(),you=side===r.self;
  const name=you?'あなた':r.self===null?(side===0?'sample_player':r.opponent):r.opponent;
  const hand=Object.entries(frame.hands[side]).filter(([,n])=>n>0).sort((a,b)=>'RBGSNLP'.indexOf(a[0])-'RBGSNLP'.indexOf(b[0]));
  return `<div class="player-row"><span class="player-side">${side===0?'▲':'△'}</span><span class="player-name">${esc(name)}</span>${you?'<span class="tag">サンプル</span>':''}<span class="hand-pieces" aria-label="${side===0?'先手':'後手'}の持駒">${hand.length?hand.map(([p,n])=>`<span><strong>${pieceText[p]}</strong>${n>1?`<small>${n}</small>`:''}</span>`).join(''):'持駒なし'}</span></div>`;
}
// Deliberately fixed illustrative centipawn-like numbers, always labelled sample.
function evaluationAt(n, kind) {
  const anchors=kind==='journal'?[[0,0],[12,60],[24,210],[32,128],[38,-420],[44,-115],[50,-600],[56,-940],[60,330],[64,1060],[70,650],[77,1550]]:[[0,0],[14,110],[25,220],[32,-290],[39,-700],[44,-1450],[50,-780],[60,-1250],[70,-1750],[80,-1900]];
  const next=anchors.findIndex(([m])=>m>=n);
  if(next<=0)return anchors[0][1];
  const [a,av]=anchors[next-1],[b,bv]=anchors[next];
  const t=(n-a)/(b-a);return Math.round(av+(bv-av)*t+Math.sin(n*1.7)*22*Math.sin(t*Math.PI));
}
function graphMarkup() {
  const r=selectedRecord(),max=countMoves(r),analysed=state.progress[r.id]??max;
  const y=n=>42-Math.max(-1900,Math.min(1900,evaluationAt(n,r.kind)))/1900*29;
  const points=Array.from({length:analysed+1},(_,n)=>`${(n/max*304).toFixed(2)},${y(n).toFixed(2)}`);
  const cursor=state.move/max*304;
  const score=state.branch?null:state.move<=analysed?evaluationAt(state.move,r.kind):null;
  return `<div class="evaluation-heading"><div class="evaluation-score"><strong>${score===null?'—':(score>0?'+':'')+score.toLocaleString('ja-JP')}</strong><small>${score===null?(state.branch?'分岐の解析は未接続':'この局面は未解析'):'先手視点'}</small></div><span class="tag">${state.branch?'本譜の評価値サンプル':'評価値サンプル'}</span></div><div class="graph"><svg viewBox="0 0 340 89" preserveAspectRatio="none" aria-hidden="true"><path class="graph-grid" d="M0 13H304M0 71H304"/><path class="graph-zero" d="M0 42H304"/>${analysed<max?`<rect x="${analysed/max*304}" y="7" width="${304-analysed/max*304}" height="66" fill="var(--surface)"/><text x="${(analysed/max*304+304)/2}" y="40" text-anchor="middle">未解析</text>`:''}<path class="graph-fill" d="M0 42L${points.join('L')}L${analysed/max*304} 42Z"/><polyline class="graph-line" points="${points.join(' ')}"/><path class="graph-cursor" d="M${cursor} 5V74"/>${state.move<=analysed?`<circle cx="${cursor}" cy="${y(state.move)}" r="3.3" fill="var(--bg)" stroke="var(--accent)" stroke-width="1.6"/>`:''}<text x="0" y="86">0</text><text x="152" y="86" text-anchor="middle">${Math.round(max/2)}</text><text x="304" y="86" text-anchor="end">${max}手</text><text x="311" y="16">+2k</text><text x="311" y="45">0</text><text x="311" y="74">−2k</text></svg><input class="graph-range" id="graph-range" type="range" min="0" max="${max}" value="${state.move}" aria-label="評価値グラフから局面を選択" aria-valuetext="${state.move}手目" ${state.branch?'disabled':''}></div>`;
}
function analysis() {
  const r=selectedRecord(),max=countMoves(r),frame=currentFrame(),bottom=(r.self===1)!==state.flip?1:0,progress=state.progress[r.id]??max;
  return `<section class="screen" aria-label="棋譜の解析・検討"><header class="app-bar detail-bar"><button class="back-label" data-action="go" data-screen="library">${icon('left')}棋譜</button><div class="detail-title"><h2>vs. ${esc(r.opponent)}</h2><p>${r.date} <span class="separator-dot">·</span> ${serviceName(r.kind)}</p></div>${iconButton('more','棋譜のメニュー','game-menu')}</header>${state.branch?`<div class="branch-banner">${icon('branch')}分岐検討 <span>· 保存しません</span><button data-action="leave-branch">本譜に戻る</button></div>`:''}<div class="scroll-area"><div class="board-section"><div id="opponent-player">${player(1-bottom)}</div><div id="board-container">${boardMarkup()}</div><div class="board-foot"><div id="self-player" style="flex:1;min-width:0">${player(bottom)}</div>${iconButton('flip','盤面を反転','flip')}</div></div><div class="evaluation" id="evaluation">${graphMarkup()}</div>${progress<max?`<div class="loading-strip"><span>解析表示のデモ ${progress} / ${max}手</span><div class="loading-progress"><span style="width:${progress/max*100}%"></span></div><button class="text-button" data-action="analysis-progress">${state.analysing?'停止':'再開'}</button></div>`:''}<div class="analysis-tabs" role="tablist" aria-label="局面の詳細">${[['candidates','候補手'],['moves','指し手'],['info','対局情報']].map(([v,t])=>`<button role="tab" data-action="analysis-tab" data-value="${v}" aria-selected="${state.analysisTab===v}" aria-controls="analysis-panel">${t}</button>`).join('')}</div><div class="candidate-list" id="analysis-panel" role="tabpanel">${analysisPanel()}</div></div><div class="replay-controls"><div class="replay-label"><strong id="move-label">${state.branch?`分岐 ${state.branchStep}手目`:`${state.move} / ${max}手`} <span class="separator-dot">·</span> ${esc(frame.label)}</strong><span id="turn-label">${(state.branch?32+state.branchStep:state.move)%2===0?'先手番':'後手番'}</span></div><div class="replay-buttons">${iconButton('first','最初の局面','step','data-value="first"')}${iconButton('left','1手戻る','step','data-value="prev"')}<button class="icon-button play-button" data-action="play" aria-label="${state.playing?'自動再生を停止':'棋譜を自動再生'}">${icon(state.playing?'pause':'play')}</button>${iconButton('right','1手進む','step','data-value="next"')}${iconButton('last','最後の局面','step','data-value="last"')}</div></div></section>`;
}
function analysisPanel() {
  const r=selectedRecord(),max=countMoves(r);
  if(state.analysisTab==='moves')return `<div class="move-list">${DEMO.games[r.kind].labels.map((label,n)=>`<button data-action="seek" data-value="${n}" class="${n===state.move?'active':''}" ${state.branch?'disabled':''}><small>${n}</small>${esc(label)}</button>`).join('')}</div>`;
  if(state.analysisTab==='info')return `<dl class="game-info-list"><div class="info-row"><dt>対局結果</dt><dd>${resultOf(r)==='win'?'あなたの勝ち':resultOf(r)==='loss'?'あなたの負け':'観戦の棋譜'}・投了</dd></div><div class="info-row"><dt>時間設定</dt><dd>${r.kind==='wars'?'10秒将棋':'10分 ＋ 30秒'}</dd></div><div class="info-row"><dt>自分の戦型</dt><dd>${esc(strategyOf(r))}</dd></div><div class="info-row"><dt>相手の戦型</dt><dd>${esc(strategyOf(r,'opponent'))}</dd></div></dl><div class="inline-actions"><button class="text-button" data-action="edit-strategy">${icon('edit')}戦型を修正</button><button class="text-button" data-action="export">${icon('download')}KIFを書き出し</button></div><label class="field-label" for="game-note">この一局のメモ</label><textarea class="review-note-field" id="game-note" maxlength="2000" placeholder="気づいたことを、ひとこと。">${esc(typeof state.notes[r.id]==='string'?state.notes[r.id]:'')}</textarea><button class="text-button" data-action="save-note">メモを保存</button>`;
  if(state.branch)return `<p class="candidate-caption">３六銀から始まる、３手の分岐サンプルです。下の手送りで確認できます。本譜と戦績には反映されません。</p><button class="text-button" data-action="leave-branch">${icon('branch')}32手目の本譜に戻る</button>`;
  if(state.move===max)return `<p class="candidate-caption">${max}手で終局しました。グラフや手送りで、気になる局面に戻れます。</p>`;
  if(r.kind==='journal'&&state.move===32)return `<button class="candidate-row" data-action="step" data-value="next"><span class="candidate-number">01</span><b>▲４五桂</b><span class="tag">本譜の次の手</span>${icon('right')}</button><button class="candidate-row" data-action="branch"><span class="candidate-number">02</span><b>▲３六銀</b><span class="tag">分岐のサンプル</span>${icon('branch')}</button><p class="candidate-caption">候補をタップして、盤上で一手ずつ確認。</p>`;
  return `<button class="candidate-row" data-action="step" data-value="next"><span class="candidate-number">01</span><b>${esc(DEMO.games[r.kind].labels[state.move+1])}</b><span class="tag">本譜の次の手</span>${icon('right')}</button><button class="text-button" data-action="branch-demo">${icon('branch')}分岐検討のサンプルを見る</button><p class="candidate-caption">実エンジンの候補手は未接続です。詰み判定は表示していません。</p>`;
}
function updateAnalysis() {
  if(state.screen!=='analysis')return;
  const scroll=$('.scroll-area')?.scrollTop||0;
  const rangeWasFocused=document.activeElement?.id==='graph-range';
  $('#app').innerHTML=analysis();
  $('.scroll-area').scrollTop=scroll;
  updateStepDisabled();
  if(rangeWasFocused)$('#graph-range')?.focus({preventScroll:true});
}
function updateStepDisabled() {
  const step=state.branch?state.branchStep:state.move,max=state.branch?state.branch.length-1:countMoves(selectedRecord());
  ['first','prev'].forEach(v=>{const b=$(`[data-action="step"][data-value="${v}"]`);if(b)b.disabled=step===0;});
  ['last','next'].forEach(v=>{$$(`[data-action="step"][data-value="${v}"]`).forEach(b=>b.disabled=step===max);});
}
function step(value, automatic=false) {
  if(!automatic)stopPlaying();
  const max=state.branch?state.branch.length-1:countMoves(selectedRecord()),n=state.branch?state.branchStep:state.move;
  const next=value==='first'?0:value==='last'?max:value==='prev'?Math.max(0,n-1):Math.min(max,n+1);
  if(state.branch)state.branchStep=next;else state.move=next;
  if(next===max)stopPlaying();
  updateAnalysis();
}
function stopPlaying(){if(state.playing)clearInterval(state.playing);state.playing=null;}
function play() {
  if(state.playing){stopPlaying();updateAnalysis();return;}
  const max=state.branch?state.branch.length-1:countMoves(selectedRecord());
  if((state.branch?state.branchStep:state.move)>=max){if(state.branch)state.branchStep=0;else state.move=0;}
  state.playing=setInterval(()=>step('next',true),950);updateAnalysis();
}
function startBranch() {
  stopPlaying();state.move=32;state.branch=DEMO.branch;state.branchStep=1;state.analysisTab='candidates';
  updateAnalysis();
}
function statistics() {
  const all=records().filter(r=>r.self!==null),list=all.filter(r=>state.period==='all'||r.date.startsWith(`2026/${String(state.month).padStart(2,'0')}`)),sum=summary(list);
  const circumference=2*Math.PI*49;
  const grouped=new Map();
  list.forEach(r=>{const name=strategyOf(r,state.strategyView);if(!grouped.has(name))grouped.set(name,[]);grouped.get(name).push(r);});
  const categories=[...grouped].sort((a,b)=>b[1].length-a[1].length);
  const chartGroups=state.period==='month'?(state.month===9?Array.from({length:9},(_,i)=>({label:(i+1)+'',list:list.filter(r=>Number(r.date.slice(-2))===i+1)})):Array.from({length:6},(_,i)=>({label:`${i*5+1}–${i===5?31:i*5+5}`,list:list.filter(r=>{const day=Number(r.date.slice(-2));return day>=i*5+1&&day<=(i===5?31:i*5+5);})}))):Array.from({length:6},(_,i)=>({label:(i+4)+'月',list:all.filter(r=>Number(r.date.slice(5,7))===i+4)}));
  const chartMax=Math.max(1,...chartGroups.map(g=>Math.max(summary(g.list).wins,summary(g.list).losses)));
  return `<section class="screen" aria-label="戦績">${appBar()}<div class="scroll-area"><div class="page-heading"><h2>わたしのあゆみ</h2><p>積み重ねた一局が、力になる。</p></div><div class="stats-period"><div class="segmented"><button data-action="period" data-value="month" aria-pressed="${state.period==='month'}">月ごと</button><button data-action="period" data-value="all" aria-pressed="${state.period==='all'}">通算</button></div><div class="period-selector">${iconButton('left','前の月の戦績','month','data-value="prev" '+(state.period==='all'||state.month===1?'disabled':''))}<strong>${state.period==='all'?'すべての対局':`2026年 ${state.month}月`}</strong>${iconButton('right','次の月の戦績','month','data-value="next" '+(state.period==='all'||state.month===9?'disabled':''))}</div><div class="rate-summary"><div class="big-rate"><small>勝率</small><div><strong>${sum.rate}</strong>${sum.total?'<span>%</span>':''}</div><p>${sum.total?'一局ずつ、自分のペースで。':'この期間の対局はまだありません。'}</p></div><div class="win-donut" role="img" aria-label="${sum.total}局中${sum.wins}勝、勝率${sum.rate}${sum.total?'パーセント':''}"><svg viewBox="0 0 118 118"><circle class="donut-track" cx="59" cy="59" r="49"/><circle class="donut-value" cx="59" cy="59" r="49" style="opacity:${sum.wins?1:0}" stroke-dasharray="${sum.total?circumference*Number(sum.rate)/100:0} ${circumference}"/></svg><div class="donut-center"><b>${sum.total}</b><small>対局</small></div></div></div><div class="stat-three"><div><strong class="winning">${sum.wins}</strong><p>勝ち</p></div><div><strong>${sum.losses}</strong><p>負け</p></div><div><strong>0</strong><p>引き分け</p></div></div></div>${sum.total?`<div class="stats-section"><div class="section-heading"><h3>戦型から見る</h3><small>勝率</small></div><div class="segmented"><button data-action="strategy-view" data-value="self" aria-pressed="${state.strategyView==='self'}">自分の戦型</button><button data-action="strategy-view" data-value="opponent" aria-pressed="${state.strategyView==='opponent'}">相手の戦型</button></div>${categories.map(([name,items])=>{const s=summary(items);return `<div class="strategy-row"><div class="strategy-label">${esc(name)}<small>${s.wins}勝 ${s.losses}敗 <span class="separator-dot">·</span> ${s.total}局</small></div><div class="strategy-progress"><span style="width:${s.rate}%"></span></div><b>${s.rate}<small>%</small></b></div>`;}).join('')}</div><div class="stats-section"><div class="section-heading"><h3>${state.period==='all'?'月ごとの対局':'今月の対局'}</h3><div class="legend"><span><i></i>勝ち</span><span><i class="loss-key"></i>負け</span></div></div><div class="bar-chart" role="img" aria-label="${chartGroups.map(g=>g.label+'：'+summary(g.list).wins+'勝'+summary(g.list).losses+'敗').join('、')}">${chartGroups.map(g=>{const s=summary(g.list);return `<div class="bar-column"><span class="bar-win" style="height:${s.wins/chartMax*75}%"></span><span class="bar-loss" style="height:${s.losses/chartMax*75}%"></span></div>`;}).join('')}</div><div class="chart-months">${chartGroups.map(g=>`<span>${g.label}${state.period==='month'?'日':''}</span>`).join('')}</div></div><div class="stats-section"><div class="section-heading"><h3>先手・後手</h3></div><div class="split-stats">${[0,1].map(side=>{const s=summary(list.filter(r=>r.self===side));return `<div class="split-stat"><h4>${side===0?'▲ 先手':'△ 後手'}</h4><b>${s.rate}</b><small>${s.total?'%':''} <span class="separator-dot">·</span> ${s.wins}勝${s.losses}敗</small></div>`;}).join('')}</div></div><div class="stats-section"><div class="section-heading"><h3>サービス別</h3></div>${['wars','journal'].map(kind=>{const s=summary(list.filter(r=>r.kind===kind));return `<div class="info-row"><span>${serviceName(kind)}</span><span>${s.wins}勝 ${s.losses}敗 <span class="separator-dot">·</span> ${s.rate}${s.total?'%':''}</span></div>`;}).join('')}<p class="stats-footnote">勝率は 勝ち ÷（勝ち ＋ 負け）で計算。<br>観戦の棋譜は戦績に含みません。表示はサンプルです。</p></div>`:`<div class="empty-state">${mascot()}<h3>あゆみは、ここから。</h3><p>対局を記録すると、<br>勝敗や得意な戦型が見えてきます。</p><button class="text-button" data-action="go" data-screen="library">棋譜を開く ${icon('arrow')}</button></div>`}</div>${nav()}</section>`;
}
function settings() {
  return `<section class="screen" aria-label="設定">${appBar()}<div class="scroll-area"><div class="page-heading"><h2>設定</h2><p>あなたに、ちょうどいい将棋時間。</p></div><div class="settings-hero">${mascot()}<div><h3>いつも、となりに。</h3><p>指した一手も、気づいたことも。<br>大切な記録は、あなたの手元に。</p></div></div><div class="settings-section"><h3>自分の対局者名</h3>${['wars','journal'].map(kind=>`<button class="setting-row" data-action="names" data-value="${kind}">${icon('user')}<span>${serviceName(kind)}<small>${state.names[kind]?esc(state.names[kind]):'対局者名を登録してください'}</small></span>${icon('right')}</button>`).join('')}<p class="field-note">サービスごとに、複数の名前を登録できます。</p></div><div class="settings-section"><h3>見た目</h3><div class="theme-setting"><div class="segmented"><button data-action="theme" data-value="light" aria-pressed="${state.theme==='light'}">ライト</button><button data-action="theme" data-value="dark" aria-pressed="${state.theme==='dark'}">ダーク</button></div></div><button class="setting-row" data-action="board-setting">${icon('board')}<span>盤面の向き</span><small>自分が手前</small>${icon('right')}</button></div><div class="settings-section"><h3>meeshogiについて</h3><button class="setting-row" data-action="about">${icon('info')}<span>このアプリについて</span>${icon('right')}</button><button class="setting-row" data-action="empty-demo">${icon('folder')}<span>空の棋譜一覧を試す<small>保存したサンプル・設定は保持します</small></span>${icon('right')}</button><div class="privacy-note">${icon('shield')}<p>ログイン不要で、棋譜は端末内に。<br>このプレビューの設定・サンプル追加・メモは、<br>このブラウザに保存されます。</p></div>${!storageAvailable?'<p class="field-error">このブラウザでは保存を利用できません。変更はページを閉じると失われます。</p>':''}<p class="settings-version">meeshogi <span class="separator-dot">·</span> design preview 01<br>棋譜と向き合う、小さな習慣。</p></div></div>${nav()}</section>`;
}
const sheet=$('#sheet');
function sheetHeader(title, back=false) {return `<div class="sheet-header">${back?iconButton('left','貼り付けに戻る','import-back'):''}<h2 id="sheet-title">${title}</h2>${iconButton('close','閉じる','close-sheet')}</div>`;}
function placeSheet() {
  if(innerWidth>=900){const r=$('#device').getBoundingClientRect();Object.assign(sheet.style,{left:`${r.left+6}px`,bottom:`${Math.max(12,innerHeight-r.bottom+6)}px`,top:'auto',right:'auto',margin:'0',width:`${r.width-12}px`,maxHeight:`${Math.min(r.height-70,innerHeight-60)}px`});}
  else {sheet.removeAttribute('style');}
}
function showSheet(content, focusSelector) {
  stopPlaying();
  $('#sheet-content').innerHTML=content;placeSheet();
  setTheme(state.theme,false);
  if(!sheet.open)sheet.showModal();
  requestAnimationFrame(()=>{const focus=focusSelector?$(focusSelector,sheet):$('[data-action="close-sheet"]',sheet);focus?.focus({preventScroll:true});});
}
function closeSheet(){sheet.close();}
function importSheet(preserve=false) {
  if(!preserve){state.importText='';state.importSelf='0';}
  showSheet(`${sheetHeader('棋譜を貼り付け')}<p class="sheet-intro">あの一局を、振り返ろう。<br>コピーしたKIF形式の棋譜を貼り付けてください。</p><div class="segmented source-segment"><button data-action="import-source" data-value="wars" aria-pressed="${state.importSource==='wars'}">将棋ウォーズ</button><button data-action="import-source" data-value="journal" aria-pressed="${state.importSource==='journal'}">棋桜</button></div><label class="field-label" for="kif-input">棋譜のテキスト</label><textarea class="field kif-field" id="kif-input" spellcheck="false" placeholder="開始日時：2026/09/09 19:42:00&#10;先手：sample_player&#10;後手：sample_sora&#10;手数----指手---------消費時間--">${esc(state.importText)}</textarea><div class="sample-actions"><button class="text-button" data-action="clipboard">${icon('paste')}クリップボードから</button><button class="text-button" data-action="fill-sample">サンプルを使う ${icon('arrow')}</button></div><p class="field-error" id="import-error" role="alert"></p><button class="primary-button" data-action="confirm-import">棋譜を確認する ${icon('arrow')}</button><p class="field-note" style="margin-bottom:0;margin-top:13px">このモックでは「サンプルを使う」から取り込みを体験できます。実際の棋譜の取り込みは未接続です。</p>`);
}
const normalizeKif = text => text.replace(/\r\n/g,'\n').trim();
function confirmImport() {
  state.importText=$('#kif-input').value;
  const error=$('#import-error');
  if(!state.importText.trim()){error.textContent='棋譜が空です。貼り付けるか、サンプルを選んでください。';$('#kif-input').setAttribute('aria-invalid','true');return;}
  const matched=['wars','journal'].find(kind=>normalizeKif(DEMO.games[kind].importRaw)===normalizeKif(state.importText));
  if(!matched){error.textContent='このプレビューではサンプル棋譜のみ確認できます。「サンプルを使う」を選んでください。';$('#kif-input').setAttribute('aria-invalid','true');return;}
  if(matched!==state.importSource){error.textContent='選択したサービスとサンプルが異なります。サービスを選び直してください。';return;}
  if(state.imported.some(x=>x.id===`import-${matched}`)){error.textContent='このサンプル棋譜は保存済みです。重複して追加されません。';return;}
  const game={...DEMO.games[matched],raw:DEMO.games[matched].importRaw},sente=game.raw.match(/^先手：(.*)$/m)[1],gote=game.raw.match(/^後手：(.*)$/m)[1];
  showSheet(`${sheetHeader('この棋譜を保存する',true)}<p class="sheet-intro">対局の内容と、自分の手番を確認してください。</p><div class="import-preview"><h3>${esc(sente)}<span>vs.</span>${esc(gote)}</h3><p>${serviceName(matched)} <span class="separator-dot">·</span> ${game.frames.length-1}手</p><dl><div class="info-row"><dt>対局日時</dt><dd>${esc(game.raw.match(/^開始日時：(.*)$/m)[1])}</dd></div><div class="info-row"><dt>結果</dt><dd>${matched==='wars'?'後手':'先手'}の勝ち・投了</dd></div></dl></div><form id="import-form"><p class="field-label">この対局の自分</p><div class="radio-list">${[['0','先手',sente],['1','後手',gote],['none','どちらでもない','戦績に含めない']].map(([v,t,n])=>`<label class="choice-row"><input type="radio" name="self" value="${v}" ${v===state.importSelf?'checked':''}><span>${t}</span><small>${esc(n)}</small></label>`).join('')}</div><div class="sheet-footer"><button type="submit" class="primary-button">${icon('check')}保存して振り返る</button></div></form><p class="field-note" style="margin-bottom:0">サンプルの保存後、固定の盤面と評価値を開きます。</p>`);
}
function importSave() {
  state.importSelf=$('input[name="self"]:checked',sheet)?.value||'none';
  const id=`import-${state.importSource}`;
  if(state.imported.some(x=>x.id===id)){closeSheet();toast('このサンプルは保存済みです。');return;}
  state.imported.unshift({id,self:state.importSelf});
  const saved=save();state.demoEmpty=false;closeSheet();openGame(id);
  toast(saved?'棋譜を保存しました。サンプルの解析を開きます。':'サンプルを開きました。ブラウザに保存できなかったため、再読み込みすると失われます。');
}
function filtersSheet() {
  state.filterDraft={service:state.serviceFilter,strategy:state.strategyFilter};drawFilters();
}
function drawFilters() {
  showSheet(`${sheetHeader('棋譜を絞り込む')}<p class="field-label">サービス</p><div class="filter-options">${[['all','すべて'],['wars','将棋ウォーズ'],['journal','棋桜']].map(([v,t])=>`<button class="filter-chip" data-action="draft-service" data-value="${v}" aria-pressed="${state.filterDraft.service===v}">${t}</button>`).join('')}</div><p class="field-label">自分の戦型</p><div class="filter-options">${['all',...knownStrategies].map(v=>`<button class="filter-chip" data-action="draft-strategy" data-value="${v}" aria-pressed="${state.filterDraft.strategy===v}">${v==='all'?'すべて':v}</button>`).join('')}</div><div class="sheet-footer"><button class="primary-button" data-action="apply-filters">この条件で表示</button><button class="text-button" data-action="clear-draft">条件をクリア</button></div>`);
}
function namesSheet(kind) {
  showSheet(`${sheetHeader(serviceName(kind)+'の名前')}<p class="sheet-intro">棋譜に書かれている自分の対局者名を登録します。複数ある場合は改行で区切ってください。</p><form id="names-form" data-kind="${kind}"><label class="field-label" for="player-names">自分の対局者名</label><textarea class="field" id="player-names" name="names" rows="4" maxlength="500" placeholder="あなたの対局者名">${esc(state.names[kind])}</textarea><p class="field-note">ここで入力した名前は、このブラウザに保存します。プレビューの対局者と勝敗は固定のサンプルです。</p><button class="primary-button" type="submit">名前を保存</button></form>`);
}
function editStrategySheet() {
  const r=selectedRecord();
  showSheet(`${sheetHeader('戦型を修正')}<p class="sheet-intro">この対局の戦型を、自分と相手でそれぞれ選べます。</p><form id="strategy-form">${[['self','自分の戦型'],['opponent','相手の戦型']].map(([key,label])=>`<label class="field-label" for="strategy-${key}">${label}</label><select class="field" name="${key}" id="strategy-${key}">${knownStrategies.map(v=>`<option value="${v}" ${strategyOf(r,key)===v?'selected':''}>${v}</option>`).join('')}</select>`).join('')}<p class="field-note">手動の修正は保存され、戦型別の戦績にも反映されます。</p><button class="primary-button" type="submit">修正を保存</button></form>`);
}
function gameMenu() {
  showSheet(`${sheetHeader('棋譜のメニュー')}<button class="setting-row" data-action="export">${icon('download')}<span>KIFを書き出し</span>${icon('right')}</button><button class="setting-row" data-action="edit-strategy">${icon('edit')}<span>戦型を修正</span>${icon('right')}</button><button class="setting-row" data-action="game-info">${icon('info')}<span>対局情報・メモ</span>${icon('right')}</button><button class="setting-row" data-action="branch-demo">${icon('branch')}<span>分岐のサンプルを見る<small>先手３六銀から、別の手順を検討</small></span>${icon('right')}</button>`);
}
function aboutSheet() {
  showSheet(`${sheetHeader('meeshogiについて')}${mascot('about-illustration')}<div class="about-copy"><h3>一局を、次の一手に。</h3><p>対局を残し、一手を振り返り、<br>自分のあゆみをたしかめる。<br>将棋をつづける人の、小さな相棒です。</p></div><div class="about-details">この画面は操作できるHTMLモックです。棋譜・対局者・戦績・評価値はデザイン用のサンプルで、実際の解析や詰み判定は行いません。<br><br>棋譜一覧、手送り、グラフ操作、３手の分岐サンプル、取り込み体験、KIF書き出し、戦型の修正、メモ・設定の保存をお試しいただけます。<br><br>ネイティブアプリの実装や、iOS・Android実機での確認を示すものではありません。</div><div class="sheet-footer"><button class="primary-button" data-action="close-sheet">棋譜と向き合う</button></div>`);
}
function exportKif() {
  const r=selectedRecord();let raw=DEMO.games[r.kind].raw;
  const sente=r.self===0?'sample_player':r.opponent,gote=r.self===1?'sample_player':r.opponent;
  raw=raw.replace(/^先手：.*$/m,`先手：${r.self===null?'sample_player':sente}`).replace(/^後手：.*$/m,`後手：${gote}`).replace(/^開始日時：.*$/m,`開始日時：${r.date} ${r.time}:00`);
  const url=URL.createObjectURL(new Blob(['\uFEFF'+raw],{type:'text/plain;charset=utf-8'}));
  const link=document.createElement('a');link.href=url;link.download=`meeshogi-sample-${r.id}.kif`;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);
  if(sheet.open)closeSheet();toast('サンプル棋譜をKIFで書き出しました。');
}
function progressDemo() {
  if(state.analysing){clearInterval(state.analysing);state.analysing=null;updateAnalysis();return;}
  const r=selectedRecord(),max=countMoves(r);
  state.analysing=setInterval(()=>{
    state.progress[r.id]=Math.min(max,(state.progress[r.id]||36)+3);
    if(state.progress[r.id]===max){clearInterval(state.analysing);state.analysing=null;}
    if(state.screen==='analysis'&&state.selected===r.id)updateAnalysis();
    if(state.screen==='library')updateList();
  },500);updateAnalysis();
}
document.addEventListener('click',async event=>{
  const button=event.target.closest('[data-action]');if(!button||button.disabled)return;
  const action=button.dataset.action,value=button.dataset.value;
  switch(action){
    case 'go':go(button.dataset.screen);break;
    case 'theme':setTheme(value);break;
    case 'platform':setPlatform(value);placeSheet();break;
    case 'about':aboutSheet();break;
    case 'open-game':openGame(button.dataset.id);updateStepDisabled();break;
    case 'clear-search':state.query='';$('#game-search').value='';updateList();$('#game-search').focus();break;
    case 'result-filter':state.resultFilter=value;$$('[data-action="result-filter"]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.value===value)));updateList();break;
    case 'reset-filters':state.query='';state.resultFilter='all';state.serviceFilter='all';state.strategyFilter='all';render();break;
    case 'filters':filtersSheet();break;
    case 'draft-service':state.filterDraft.service=value;drawFilters();break;
    case 'draft-strategy':state.filterDraft.strategy=value;drawFilters();break;
    case 'clear-draft':state.filterDraft={service:'all',strategy:'all'};drawFilters();break;
    case 'apply-filters':state.serviceFilter=state.filterDraft.service;state.strategyFilter=state.filterDraft.strategy;closeSheet();render();break;
    case 'import':importSheet();break;
    case 'import-back':state.importSelf=$('input[name="self"]:checked',sheet)?.value||state.importSelf;importSheet(true);break;
    case 'import-source':state.importSource=value;state.importText='';importSheet(true);break;
    case 'fill-sample':state.importText=DEMO.games[state.importSource].importRaw;$('#kif-input').value=state.importText;$('#import-error').textContent='';$('#kif-input').removeAttribute('aria-invalid');break;
    case 'confirm-import':confirmImport();break;
    case 'clipboard':
      try{if(!navigator.clipboard?.readText)throw new Error('unavailable');const text=await navigator.clipboard.readText();if(!sheet.open||!$('#kif-input'))break;$('#kif-input').value=text;state.importText=text;$('#import-error').textContent=text?'':'クリップボードが空です。テキストをコピーしてからお試しください。';}
      catch{if($('#import-error'))$('#import-error').textContent='クリップボードを読み取れませんでした。入力欄を長押しして貼り付けるか、サンプルを選んでください。';}
      break;
    case 'close-sheet':closeSheet();break;
    case 'flip':state.flip=!state.flip;updateAnalysis();break;
    case 'step':step(value);break;
    case 'seek':stopPlaying();state.move=Number(value);updateAnalysis();break;
    case 'play':play();break;
    case 'analysis-tab':state.analysisTab=value;updateAnalysis();break;
    case 'branch':startBranch();break;
    case 'branch-demo':{const changed=state.selected!=='g1';if(sheet.open)closeSheet();state.selected='g1';state.move=32;state.analysisTab='candidates';state.branch=null;go('analysis');if(changed)toast('分岐検討用のサンプル棋譜を開きました。');break;}
    case 'leave-branch':stopPlaying();state.branch=null;state.move=32;updateAnalysis();break;
    case 'game-menu':gameMenu();break;
    case 'game-info':closeSheet();state.analysisTab='info';updateAnalysis();$('.scroll-area').scrollTop=$('.scroll-area').scrollHeight;break;
    case 'edit-strategy':editStrategySheet();break;
    case 'export':exportKif();break;
    case 'save-note':state.notes[selectedRecord().id]=$('#game-note').value;toast(save()?'この一局のメモを保存しました。':'ブラウザに保存できませんでした。メモをコピーして残してください。');break;
    case 'period':state.period=value;render();break;
    case 'month':state.month=Math.max(1,Math.min(9,state.month+(value==='prev'?-1:1)));render();break;
    case 'strategy-view':state.strategyView=value;{const top=$('.scroll-area').scrollTop;render();$('.scroll-area').scrollTop=top;}break;
    case 'names':namesSheet(value);break;
    case 'board-setting':showSheet(`${sheetHeader('自分が、手前に。')}<p class="sheet-intro">対局を開くと、自分の駒が手前になります。盤面の右下にある反転ボタンで、相手側から見ることもできます。</p><button class="primary-button" data-action="close-sheet">わかりました</button>`);break;
    case 'empty-demo':state.demoEmpty=true;state.libraryScroll=0;state.query='';state.resultFilter='all';state.serviceFilter='all';state.strategyFilter='all';go('library');break;
    case 'restore-demo':state.demoEmpty=false;render();break;
    case 'analysis-progress':progressDemo();break;
  }
});
document.addEventListener('input',event=>{
  if(event.target.id==='game-search'){state.query=event.target.value;updateList();}
  if(event.target.id==='graph-range'){
    stopPlaying();state.move=Number(event.target.value);
    // Keep the range node alive during pointer drag; rebuild only its neighbours.
    const r=selectedRecord(),bottom=(r.self===1)!==state.flip?1:0;
    $('#board-container').innerHTML=boardMarkup();$('#opponent-player').innerHTML=player(1-bottom);$('#self-player').innerHTML=player(bottom);
    const wrapper=document.createElement('div');wrapper.innerHTML=graphMarkup();$('.evaluation-heading').replaceWith($('.evaluation-heading',wrapper));$('.graph svg').replaceWith($('.graph svg',wrapper));
    $('#move-label').textContent=`${state.move} / ${countMoves(r)}手 · ${currentFrame().label}`;$('#turn-label').textContent=state.move%2===0?'先手番':'後手番';
    event.target.setAttribute('aria-valuetext',`${state.move}手目`);$('#analysis-panel').innerHTML=analysisPanel();updateStepDisabled();
    const playButton=$('[data-action="play"]');playButton.innerHTML=icon('play');playButton.setAttribute('aria-label','棋譜を自動再生');
  }
});
document.addEventListener('submit',event=>{
  if(event.target.id==='import-form'){event.preventDefault();importSave();}
  if(event.target.id==='names-form'){
    event.preventDefault();const kind=event.target.dataset.kind;
    state.names[kind]=[...new Set($('#player-names').value.split(/[\n,、]+/).map(x=>x.trim()).filter(Boolean))].join('\n');
    const saved=save();closeSheet();render();toast(saved?'対局者名を保存しました。':'ブラウザに保存できませんでした。');
  }
  if(event.target.id==='strategy-form'){
    event.preventDefault();const r=selectedRecord(),form=new FormData(event.target);
    ['self','opponent'].forEach(key=>state.strategies[`${r.id}-${key}`]=form.get(key));
    const saved=save();closeSheet();state.analysisTab='info';updateAnalysis();toast(saved?'戦型を修正しました。戦績にも反映されます。':'この表示には反映しましたが、ブラウザに保存できませんでした。');
  }
});
sheet.addEventListener('click',event=>{if(event.target===sheet){const r=sheet.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)closeSheet();}});
sheet.addEventListener('close',()=>{if(state.screen==='analysis')updateAnalysis();});
window.addEventListener('resize',()=>{if(sheet.open)placeSheet();});
window.addEventListener('popstate',()=>{if(sheet.open)closeSheet();go(location.hash.slice(1)||'library',false);});
window.addEventListener('hashchange',()=>{const next=location.hash.slice(1);if(next!==state.screen)go(next||'library',false);});
document.addEventListener('visibilitychange',()=>{if(document.hidden){stopPlaying();if(state.analysing){clearInterval(state.analysing);state.analysing=null;}if(state.screen==='analysis')updateAnalysis();}});
document.addEventListener('keydown',event=>{if(state.screen!=='analysis'||sheet.open||['INPUT','TEXTAREA','SELECT'].includes(event.target.tagName))return;if(event.key==='ArrowRight'){event.preventDefault();step('next');}if(event.key==='ArrowLeft'){event.preventDefault();step('prev');}});
setTheme(state.theme,false);setPlatform(state.platform);go(params.get('view')||location.hash.slice(1)||'library',false);updateStepDisabled();
