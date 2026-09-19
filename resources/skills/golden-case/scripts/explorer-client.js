/* explorer-client —— Case Explorer 的浏览器端（骨架 + 样式 + 渲染 + 交互 + IndexedDB 便签）。
   由 explorer.mjs 生成时整段内联进 case-explorer.html；不是运行时外部依赖。
   数据契约：前置 script 提供全局 DATA（形状见 explorer.mjs 的 buildModel）。
   存储边界：localStorage 只存 UI 偏好；IndexedDB 只存便签与 Prompt 草稿；Case 源零写入。 */

const CSS = `
:root{
--bg:#f7f6f3;--surface:#fff;--surface2:#fbfaf8;--ink:#1a1d1c;--soft:#6b7370;--faint:#95998f;
--rule:#e3e1da;--rule2:#eeede8;--accent:#2c6350;--accent-soft:#e2efe9;
--bad:#a13c2f;--bad-soft:#f8ebe8;--warn:#7e5c10;--warn-soft:#f0e7cf;
--ok:#2e7c4d;--ok-soft:#e7f0ea;--slate:#4f5f6e;--slate-soft:#e8ecf0;--shadow:0 1px 2px rgba(24,22,18,.06)}
@media(prefers-color-scheme:dark){:root{
--bg:#12100d;--surface:#1b1916;--surface2:#201e19;--ink:#e8e5de;--soft:#9ba19c;--faint:#7d8380;
--rule:#2c2a25;--rule2:#26241f;--accent:#7cc7ab;--accent-soft:#1b2a25;
--bad:#e08a7d;--bad-soft:#33201c;--warn:#d2ad67;--warn-soft:#2b2312;
--ok:#83c99e;--ok-soft:#1c2a22;--slate:#9db0c0;--slate-soft:#212932;--shadow:none}}
*{box-sizing:border-box}
html,body{margin:0}
body{background:var(--bg);color:var(--ink);
font:13px/1.6 ui-sans-serif,system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;
-webkit-font-smoothing:antialiased}
button,input,select,textarea{font:inherit;color:inherit}
button{background:none;border:none;padding:0;cursor:pointer}
code,kbd,.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.85em}
::-webkit-scrollbar{width:9px;height:9px}
::-webkit-scrollbar-thumb{background:var(--rule);border-radius:5px}
::-webkit-scrollbar-track{background:transparent}

/* ── 骨架：左业务树 + 中央 Explorer ── */
.app{display:grid;grid-template-columns:14.5rem minmax(0,1fr);min-height:100vh}
.side{background:var(--surface);border-right:1px solid var(--rule);display:flex;flex-direction:column;
position:sticky;top:0;height:100vh}
.brand{padding:.85rem .9rem .7rem;border-bottom:1px solid var(--rule)}
.brand b{display:block;font-size:.82rem;letter-spacing:.02em}
.brand span{display:block;font-size:.68rem;color:var(--soft);margin-top:.15rem}
.tree{flex:1;overflow-y:auto;padding:.5rem .45rem 1rem}
.sidehint{border-top:1px solid var(--rule);padding:.55rem .9rem;font-size:.66rem;color:var(--soft);line-height:1.5}
.tgroup{margin:.7rem .3rem .2rem;font-size:.64rem;letter-spacing:.1em;color:var(--soft)}
.titem{display:flex;align-items:baseline;gap:.4rem;width:100%;text-align:left;padding:.26rem .45rem;
border-radius:5px;color:var(--ink);font-size:.76rem}
.titem:hover{background:var(--rule2)}
.titem.on{background:var(--accent-soft);color:var(--accent);font-weight:600}
.titem .tn{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.titem .tc{color:var(--soft);font-size:.68rem;font-variant-numeric:tabular-nums}
.titem.on .tc{color:var(--accent)}
.dot{width:5px;height:5px;border-radius:50%;background:var(--faint);flex:none;align-self:center}

.main{min-width:0;display:flex;flex-direction:column}
.mhead{padding:1rem 1.4rem .6rem;border-bottom:1px solid var(--rule);background:var(--bg);
position:sticky;top:0;z-index:6}
.mhead .row{display:flex;align-items:flex-start;gap:1rem;flex-wrap:wrap}
h1{margin:0;font:600 1.05rem/1.3 ui-serif,Georgia,"Songti SC",serif}
.sub{margin:.2rem 0 0;color:var(--soft);font-size:.72rem}
.tools{margin-left:auto;display:flex;align-items:center;gap:.4rem;flex-wrap:wrap}
.mhead .lselall{margin:.4rem 0 0}
.search{display:flex;align-items:center;gap:.35rem;border:1px solid var(--rule);background:var(--surface);
border-radius:6px;padding:.22rem .5rem;min-width:16rem}
.search input{border:none;background:none;outline:none;width:100%;font-size:.76rem}
.search kbd{border:1px solid var(--rule);border-radius:3px;padding:0 .2rem;color:var(--soft);font-size:.65rem}
.seg{display:flex;border:1px solid var(--rule);border-radius:6px;overflow:hidden;background:var(--surface)}
.seg button{padding:.24rem .6rem;font-size:.74rem;color:var(--soft)}
.seg button+button{border-left:1px solid var(--rule)}
.seg button.on{background:var(--accent-soft);color:var(--accent);font-weight:600}
select.sel{border:1px solid var(--rule);background:var(--surface);border-radius:6px;padding:.24rem .4rem;font-size:.74rem}
.btn{border:1px solid var(--rule);background:var(--surface);border-radius:6px;padding:.24rem .6rem;font-size:.74rem;
white-space:nowrap}
.btn:hover{border-color:var(--accent);color:var(--accent)}
.btn.pri{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:600}
.btn.pri:hover{opacity:.92;color:#fff}
.btn.on{border-color:var(--accent);color:var(--accent);background:var(--accent-soft)}
.btn[disabled]{opacity:.45;cursor:not-allowed}

/* ── 筛选条 + 筛选面板 ── */
.fbar{display:flex;align-items:center;gap:.4rem;flex-wrap:wrap;padding:.5rem 1.4rem;border-bottom:1px solid var(--rule)}
.fchip{display:inline-flex;align-items:center;gap:.3rem;border:1px solid var(--rule);border-radius:999px;
padding:.05rem .1rem .05rem .5rem;font-size:.7rem;color:var(--soft);background:var(--surface)}
.fchip b{font-weight:600;color:var(--ink)}
.fchip button{width:1.1rem;height:1.1rem;line-height:1;color:var(--soft);border-radius:50%}
.fchip button:hover{background:var(--bad-soft);color:var(--bad)}
.fpanel{border-bottom:1px solid var(--rule);background:var(--surface);padding:.9rem 1.4rem 1rem}
.fgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(13rem,1fr));gap:.9rem 1.6rem}
.fgroup>span{display:block;font-size:.68rem;color:var(--soft);margin-bottom:.3rem}
.chipset{display:flex;flex-wrap:wrap;gap:.3rem}
.chip{border:1px solid var(--rule);border-radius:999px;padding:.08rem .5rem;font-size:.7rem;color:var(--soft);
background:var(--surface)}
.chip:hover{border-color:var(--accent);color:var(--accent)}
.chip.on{background:var(--accent-soft);border-color:var(--accent);color:var(--accent);font-weight:600}
.fops{display:flex;gap:.4rem;justify-content:flex-end;margin-top:.9rem;padding-top:.7rem;border-top:1px dashed var(--rule)}

/* ── 列表 / 卡片 ── */
.list{padding:1rem 1.4rem 6rem;flex:1}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(20rem,1fr));gap:.7rem}
.card{position:relative;background:var(--surface);border:1px solid var(--rule);border-radius:8px;
padding:.7rem .8rem .6rem;cursor:pointer;box-shadow:var(--shadow)}
.card:hover{border-color:var(--accent)}
.card.on{border-color:var(--accent);box-shadow:inset 0 0 0 1px var(--accent)}
.card.bad{border-color:var(--bad)}
.card.sel{background:var(--accent-soft);border-color:var(--accent)}
.chead{display:flex;align-items:center;gap:.45rem}
.pick{flex:none;width:2.25rem;min-height:1.75rem;margin:-.25rem 0;border-radius:5px;cursor:pointer;
  display:inline-flex;align-items:center;justify-content:center;vertical-align:middle}
.pick:hover{background:var(--rule2)}
.chead .pick{align-self:stretch;margin:-.3rem 0 -.2rem -.35rem}
.pick input[type=checkbox]{accent-color:var(--accent);margin:0;pointer-events:none}
.cid{font-size:.7rem;font-weight:600;color:var(--soft);font-variant-numeric:tabular-nums;white-space:nowrap}
.cname{font-size:.86rem;font-weight:600;margin:.35rem 0 0;line-height:1.35}
.cdesc{color:var(--soft);font-size:.73rem;margin:.25rem 0 0;display:-webkit-box;-webkit-line-clamp:2;
-webkit-box-orient:vertical;overflow:hidden}
.ctags{display:flex;flex-wrap:wrap;gap:.25rem;margin-top:.4rem}
.tag{font-size:.66rem;color:var(--soft);background:var(--rule2);border-radius:3px;padding:.02rem .32rem}
.cfoot{display:flex;align-items:center;gap:.4rem;margin-top:.5rem;padding-top:.45rem;border-top:1px solid var(--rule2);
font-size:.68rem;color:var(--soft)}
.cfoot .lvl{border:1px solid var(--rule);border-radius:3px;padding:0 .28rem;white-space:nowrap}
.cfoot .scope{border:1px solid var(--rule);border-radius:3px;padding:0 .28rem;white-space:nowrap}
.cfoot .cwhat{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.cfoot .when{white-space:nowrap;font-variant-numeric:tabular-nums}
.cnote{color:var(--warn);white-space:nowrap}
.cmore{margin-left:auto;color:var(--soft);padding:0 .25rem;border-radius:4px}
.cmore:hover{background:var(--rule2)}
.pri{font-size:.66rem;font-weight:700;border-radius:3px;padding:.02rem .3rem;background:var(--slate-soft);color:var(--slate)}
.pri.p0{background:var(--bad-soft);color:var(--bad)}
.pri.p1{background:var(--warn-soft);color:var(--warn)}

table.tbl{width:100%;border-collapse:collapse;font-size:.76rem}
table.tbl th{position:sticky;top:0;z-index:2;background:var(--bg);text-align:left;font-size:.66rem;
letter-spacing:.06em;color:var(--soft);font-weight:600;padding:.4rem .45rem;border-bottom:1px solid var(--rule)}
table.tbl td{padding:.4rem .45rem;border-bottom:1px solid var(--rule2);vertical-align:middle}
table.tbl tr.rowc{cursor:pointer}
table.tbl tr.rowc:hover td{background:var(--surface)}
table.tbl tr.rowc.on td{background:var(--accent-soft)}
table.tbl tr.rowc.sel td{background:var(--accent-soft)}
table.tbl tr.rowc.sel td.pid{color:var(--accent)}
table.tbl td.pid{font-variant-numeric:tabular-nums;color:var(--soft);font-weight:600;white-space:nowrap}
table.tbl td.pname .n{font-weight:600}
table.tbl td.pname .d{color:var(--soft);font-size:.7rem;display:block;overflow:hidden;text-overflow:ellipsis;
white-space:nowrap;max-width:26rem}
table.tbl td.nowrap{white-space:nowrap}
.tags-cell{display:flex;gap:.2rem;flex-wrap:wrap}
tr.bad td.pid{color:var(--bad)}

/* ── 状态三态：生命周期 chip / 健康状态点 / 单次运行判定 ── */
.lc{display:inline-block;font-size:.66rem;font-weight:600;border-radius:3px;padding:.02rem .38rem;white-space:nowrap;
border:1px solid var(--rule);color:var(--soft)}
.lc.draft{color:var(--slate);background:var(--slate-soft);border-color:transparent}
.lc.review{color:var(--warn);background:var(--warn-soft);border-color:transparent}
.lc.confirmed{color:var(--accent);background:var(--accent-soft);border-color:transparent}
.lc.frozen{color:var(--warn);background:var(--warn-soft);border:1px solid var(--warn)}
.hl{display:inline-flex;align-items:center;gap:.28rem;font-size:.68rem;color:var(--soft);white-space:nowrap}
.hl i{width:6px;height:6px;border-radius:50%;background:var(--faint);flex:none;align-self:center}
.hl.active i{background:var(--ok)}
.hl.stale i{background:var(--warn)}
.hl.broken{color:var(--bad)}.hl.broken i{background:var(--bad)}
.hl.deprecated{text-decoration:line-through}
.vd{font-size:.7rem;font-variant-numeric:tabular-nums;white-space:nowrap}
.vd.ok{color:var(--ok)}.vd.no{color:var(--bad)}.vd.na{color:var(--soft)}
.badge{border:1px solid var(--rule);border-radius:3px;padding:0 .3rem;font-size:.66rem;color:var(--soft);
white-space:nowrap;display:inline-block}

/* ── 底部 Selection Bar ── */
.selbar{position:fixed;left:14.5rem;right:0;bottom:0;z-index:20;display:flex;align-items:center;gap:.7rem;
background:var(--surface);border-top:1px solid var(--rule);padding:.5rem 1.4rem;font-size:.74rem;
box-shadow:0 -1px 3px rgba(24,22,18,.06)}
.selbar .n b{color:var(--accent)}
.selbar .ops{margin-left:auto;display:flex;gap:.4rem}
.selbar .clear{color:var(--soft);text-decoration:underline}

/* ── Drawer ── */
.scrim{position:fixed;inset:0;z-index:30;background:rgba(18,16,13,.26);opacity:0;transition:opacity .12s}
.scrim.on{opacity:1}
.drawer{position:fixed;top:0;right:0;bottom:0;width:min(44rem,94vw);z-index:31;background:var(--surface);
border-left:1px solid var(--rule);display:flex;flex-direction:column;transform:translateX(1.5rem);opacity:0;
transition:transform .14s,opacity .14s}
.drawer.on{transform:none;opacity:1}
.dhead{padding:.85rem 1.1rem .7rem;border-bottom:1px solid var(--rule);background:var(--surface2)}
.dhead .r1{display:flex;align-items:center;gap:.45rem;flex-wrap:wrap}
.dhead h2{margin:.45rem 0 0;font:600 1.05rem/1.35 ui-serif,Georgia,"Songti SC",serif}
.ddesc{color:var(--soft);font-size:.76rem;margin:.3rem 0 0}
.dmeta{color:var(--soft);font-size:.68rem;margin-top:.45rem;display:flex;flex-wrap:wrap;gap:.1rem .9rem}
.dnav{margin-left:auto;display:flex;gap:.2rem}
.dnav button{width:1.5rem;height:1.5rem;border-radius:5px;color:var(--soft)}
.dnav button:hover{background:var(--rule2);color:var(--ink)}
.dactions{display:flex;gap:.4rem;margin-top:.6rem;flex-wrap:wrap;align-items:center}
.tabs{display:flex;gap:.2rem;padding:.35rem .7rem 0;border-bottom:1px solid var(--rule);background:var(--surface)}
.tabs button{padding:.4rem .6rem;font-size:.74rem;color:var(--soft);border-bottom:2px solid transparent}
.tabs button.on{color:var(--ink);font-weight:600;border-bottom-color:var(--accent)}
.tabs button span{color:var(--soft);font-size:.66rem;margin-left:.25rem}
.dbody{flex:1;overflow-y:auto;padding:1rem 1.1rem 3rem;background:var(--bg)}
.blk{background:var(--surface);border:1px solid var(--rule);border-radius:7px;padding:.7rem .8rem;margin-bottom:.6rem}
.blk>h3{margin:0 0 .35rem;font-size:.76rem;font-weight:600;display:flex;align-items:center;gap:.4rem}
.blk>h3 .no{color:var(--faint);font-variant-numeric:tabular-nums;font-size:.7rem}
.blk.lead-h{border-left:3px solid var(--accent)}
.blk.warn-h{border-color:var(--warn);background:var(--warn-soft)}
.blk ul{margin:.15rem 0;padding-left:1.1rem}
.blk li{margin:.12rem 0}
.blk p{margin:.2rem 0}
.blk h4{margin:.8rem 0 .3rem;font-size:.72rem;color:var(--soft);font-weight:600}
.muted{color:var(--soft)}
.sql{margin:.3rem 0 0;border:1px solid var(--rule);border-radius:5px;background:var(--surface2);padding:.35rem .5rem;
overflow-x:auto;white-space:pre}
details.q{margin-top:.35rem}
details.q>summary{cursor:pointer;font-size:.68rem;color:var(--soft)}
.vp{border:1px solid var(--rule);border-radius:7px;background:var(--surface);padding:.6rem .75rem;margin-bottom:.5rem}
.vp.fail{border-color:var(--bad)}
.vp .vh{display:flex;align-items:center;gap:.4rem;flex-wrap:wrap}
.vp .vh .vid{font-size:.68rem;font-weight:700;color:var(--soft);font-variant-numeric:tabular-nums}
.vp .vh .vn{font-size:.8rem;font-weight:600}
.vp .qa{display:grid;grid-template-columns:5.2rem 1fr;gap:.15rem .6rem;margin:.4rem 0 0;font-size:.75rem}
.vp .qa dt{color:var(--soft);font-size:.7rem}
.vp .qa dd{margin:0}
.issue{margin-top:.45rem;border-top:1px dashed var(--rule);padding-top:.35rem;font-size:.72rem;color:var(--bad)}
.first-fail{border-radius:3px;padding:0 .3rem;font-size:.66rem;font-weight:600;background:var(--bad-soft);color:var(--bad)}
.meta-grid{display:grid;grid-template-columns:6.4rem 1fr;gap:.3rem .7rem;font-size:.75rem;margin:0}
.meta-grid dt{color:var(--soft);font-size:.7rem}
.meta-grid dd{margin:0}
.tl{margin:.2rem 0 0;padding:0;list-style:none}
.tl li{position:relative;padding:.15rem 0 .5rem 1.1rem;font-size:.74rem}
.tl li:before{content:"";position:absolute;left:.28rem;top:.62rem;width:6px;height:6px;border-radius:50%;
background:var(--rule);border:1.5px solid var(--soft)}
.tl li.cur:before{background:var(--accent);border-color:var(--accent)}
.tl li:after{content:"";position:absolute;left:.52rem;top:1.1rem;bottom:-.1rem;width:1px;background:var(--rule)}
.tl li:last-child:after{display:none}
.tl .v{font-weight:700;font-variant-numeric:tabular-nums;margin-right:.4rem}
.tl .w{color:var(--soft);margin-right:.4rem;font-variant-numeric:tabular-nums}
.side-note{font-size:.7rem;color:var(--soft);margin-top:.4rem}

/* ── 便签面板 ── */
.notes{position:fixed;top:0;right:0;bottom:0;width:min(30rem,94vw);z-index:33;background:var(--surface);
border-left:1px solid var(--rule);display:flex;flex-direction:column;opacity:0;transform:translateX(1.5rem);
transition:transform .14s,opacity .14s}
.notes.on{transform:none;opacity:1}
.nhead{padding:.8rem 1rem .6rem;border-bottom:1px solid var(--rule);background:var(--surface2)}
.nhead .r1{display:flex;align-items:center;gap:.4rem}
.nhead h2{margin:0;font:600 .9rem/1.3 ui-serif,Georgia,"Songti SC",serif}
.nhead .x{margin-left:0;color:var(--soft);width:1.5rem;height:1.5rem;border-radius:5px}
.nhead .x:hover{background:var(--rule2)}
.ntabs{display:flex;gap:.3rem;margin-top:.5rem;flex-wrap:wrap}
.ntabs button{font-size:.7rem;color:var(--soft);border-radius:5px;padding:.15rem .5rem}
.ntabs button.on{background:var(--accent-soft);color:var(--accent);font-weight:600}
.nbody{flex:1;overflow-y:auto;padding:.6rem .7rem 1rem;background:var(--bg)}
.nitem{background:var(--surface);border:1px solid var(--rule);border-radius:7px;padding:.5rem .6rem;margin-bottom:.45rem}
.nitem.on{border-color:var(--accent)}
.nitem.done{opacity:.62}
.nitem .r1{display:flex;align-items:center;gap:.4rem;font-size:.74rem}
.nitem .r1 input{accent-color:var(--accent);margin:0}
.nitem .r1 .cid{font-weight:600}
.nitem .r1 .st{margin-left:auto;font-size:.64rem;border-radius:3px;padding:0 .3rem;background:var(--rule2);color:var(--soft)}
.nitem .r1 .st.generated{background:var(--accent-soft);color:var(--accent)}
.nitem .r1 .st.done{background:var(--ok-soft);color:var(--ok)}
.nitem .sc{display:flex;gap:.25rem;margin-top:.3rem;flex-wrap:wrap}
.nitem .ct{margin:.3rem 0 0;font-size:.74rem;white-space:pre-wrap}
.nitem .r2{display:flex;align-items:center;gap:.6rem;margin-top:.35rem;font-size:.66rem;color:var(--soft)}
.nitem .r2 .ops{margin-left:auto;display:flex;gap:.5rem}
.nitem .r2 .ops button{color:var(--soft);text-decoration:underline}
.nitem .r2 .ops button:hover{color:var(--accent)}
.nfoot{border-top:1px solid var(--rule);padding:.6rem .8rem;display:flex;align-items:center;gap:.5rem;
font-size:.72rem;background:var(--surface)}
.nfoot .ops{margin-left:auto;display:flex;gap:.4rem}
.empty{color:var(--soft);font-size:.74rem;text-align:center;padding:2rem 1rem}

/* ── 模态（Composer / 便签 / Frozen 提示） ── */
.modal{position:fixed;inset:0;z-index:40;display:flex;align-items:center;justify-content:center;padding:1.2rem;
background:rgba(18,16,13,.34)}
.modal.top{z-index:45}
.mcard{background:var(--surface);border:1px solid var(--rule);border-radius:10px;width:min(52rem,96vw);
max-height:92vh;display:flex;flex-direction:column;box-shadow:var(--shadow)}
.mcard.narrow{width:min(30rem,96vw)}
.mhead2{display:flex;align-items:center;gap:.5rem;padding:.75rem .95rem;border-bottom:1px solid var(--rule)}
.mhead2 h3{margin:0;font-size:.86rem;font-weight:600}
.x{margin-left:auto;color:var(--soft);width:1.5rem;height:1.5rem;border-radius:5px}
.x:hover{background:var(--rule2)}
.mbody{padding:.85rem .95rem;overflow-y:auto}
.mbody h4{margin:.9rem 0 .35rem;font-size:.74rem;color:var(--soft);font-weight:600}
.mbody h4:first-child{margin-top:0}
.mfoot{display:flex;align-items:center;gap:.5rem;padding:.65rem .95rem;border-top:1px solid var(--rule);flex-wrap:wrap}
.mfoot .hint{color:var(--soft);font-size:.68rem;margin-right:auto}
textarea{border:1px solid var(--rule);border-radius:6px;background:var(--surface2);padding:.5rem .6rem;width:100%;
font-size:.76rem;resize:vertical;outline:none}
textarea:focus,input:focus,select:focus{border-color:var(--accent)}
textarea.draft{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.72rem;line-height:1.65;min-height:16rem}
.warnbox{border:1px solid var(--warn);background:var(--warn-soft);color:var(--warn);border-radius:6px;
padding:.5rem .65rem;font-size:.72rem;margin-bottom:.5rem;line-height:1.55}
.tgt{display:flex;flex-wrap:wrap;gap:.3rem;margin-bottom:.4rem}
.opts{display:grid;grid-template-columns:repeat(auto-fit,minmax(15rem,1fr));gap:.25rem .9rem;font-size:.74rem}
.opts label{display:flex;align-items:center;gap:.35rem;cursor:pointer}
.opts input{accent-color:var(--accent)}
.count{color:var(--soft);font-size:.66rem;text-align:right;margin-top:.15rem}

.toast{position:fixed;left:50%;bottom:1.4rem;transform:translateX(-50%);z-index:60;background:var(--ink);
color:var(--bg);border-radius:6px;padding:.4rem .8rem;font-size:.74rem;opacity:0;transition:opacity .15s;
pointer-events:none}
.toast.on{opacity:.94}
.menu{position:fixed;z-index:50;background:var(--surface);border:1px solid var(--rule);border-radius:7px;
box-shadow:var(--shadow);padding:.25rem;min-width:11rem}
.menu button{display:block;width:100%;text-align:left;padding:.32rem .55rem;border-radius:5px;font-size:.74rem}
.menu button:hover{background:var(--accent-soft);color:var(--accent)}
.menu hr{border:none;border-top:1px solid var(--rule);margin:.25rem 0}
.hidden{display:none !important}

@media(max-width:960px){
.app{grid-template-columns:1fr}
.side{position:static;height:auto;border-right:none;border-bottom:1px solid var(--rule)}
.tree{max-height:12rem}
.selbar{left:0}
.mhead{padding:.9rem 1rem .6rem}
.list{padding:.8rem 1rem 7rem}
.fbar,.fpanel{padding-left:1rem;padding-right:1rem}
}
@media print{.side,.tools,.selbar,.scrim{display:none}}
`;

(function () {
  'use strict';

  // ── 工具 ──
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.prototype.slice.call((r || document).querySelectorAll(s));
  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#x27;' };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (m) => ESC[m]);
  const now = () => Date.now();
  const DAY = 86400000;
  const ts = (d) => Date.parse(String(d == null ? '' : d).replace(' ', 'T')) || 0;

  function fmtRel(d) {
    const t = ts(d);
    if (!t) return '—';
    const diff = now() - t;
    if (diff < 0) return String(d).slice(0, 10);
    if (diff < 60000) return '刚刚';
    if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前';
    if (diff < DAY) return Math.floor(diff / 3600000) + ' 小时前';
    if (diff < 30 * DAY) return Math.floor(diff / DAY) + ' 天前';
    return String(d).slice(0, 10);
  }
  const fmtDur = (ms) => (ms == null ? '—' : ms < 1000 ? ms + ' ms' : (ms / 1000).toFixed(1) + ' s');
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('on');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.remove('on'), 1800);
  }
  async function copyText(text) {
    try {
      if (navigator.clipboard) { await navigator.clipboard.writeText(text); return true; }
    } catch (e) { /* file:// 或权限受限：落到 execCommand */ }
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e2) { ok = false; }
    document.body.removeChild(ta);
    return ok;
  }

  // ── 常量 ──
  const SCOPE_ALL = ['Description', 'Given', 'When', 'Then', 'Invariant', 'Verification Point', 'Meta', '其他'];
  const SCOPE_FROZEN = ['Then', 'Invariant', 'Verification Point'];
  const LC_ORDER = ['DRAFT', 'REVIEW', 'CONFIRMED', 'FROZEN'];
  const HL_ORDER = ['ACTIVE', 'STALE', 'BROKEN', 'DEPRECATED'];
  const TYPE_ORDER = ['HAPPY_PATH', 'BOUNDARY', 'STATE', 'ERROR', 'CONCURRENCY', 'REGRESSION'];
  const LV_ORDER = ['L1', 'L2', 'L3', 'L4'];
  const PR_ORDER = ['P0', 'P1', 'P2', 'P3'];
  const LC_CN = { DRAFT: '草稿', REVIEW: '待复核', CONFIRMED: '已确认', FROZEN: '已冻结' };
  const HL_CN = { ACTIVE: '有效', STALE: '陈旧', BROKEN: '已损坏', DEPRECATED: '已废弃' };
  const TYPE_CN = {
    HAPPY_PATH: '正常路径', BOUNDARY: '边界', STATE: '状态', ERROR: '异常',
    CONCURRENCY: '并发', REGRESSION: '回归沉淀',
  };
  const LV_CN = { L1: 'Logic', L2: 'Local Integration', L3: 'Real Dependency', L4: 'E2E' };
  const VERDICT_CN = {
    NOT_RUN: '未跑', RUNNING: '运行中', PASS: '通过', FAIL: '失败', ERROR: '环境错误', SKIPPED: '跳过',
  };
  const ST_CN = { pending: '待处理', generated: '已生成', done: '已完成' };
  const PR = { P0: 0, P1: 1, P2: 2, P3: 3 };
  const uniq = (a) => Array.from(new Set(a.filter(Boolean)));

  // ── 状态（UI 偏好 → localStorage） ──
  const PREF = 'gce:prefs';
  const EMPTY_F = () => ({ business: '', tags: [], lifecycle: [], health: [], type: [], level: [], priority: [], mtime: '', scope: [] });
  const S = {
    view: 'card', sort: 'recent', q: '', tab: 'SPEC', notesTab: 'all', notesOpen: false, panel: false,
    f: EMPTY_F(), sel: new Set(), open: null, noteSel: new Set(),
  };
  function savePrefs() {
    try {
      localStorage.setItem(PREF, JSON.stringify({
        view: S.view, sort: S.sort, q: S.q, tab: S.tab, notesTab: S.notesTab, panel: S.panel, f: S.f,
      }));
    } catch (e) { /* 隐私模式：偏好非关键数据，静默降级 */ }
  }
  function loadPrefs() {
    let p;
    try { p = JSON.parse(localStorage.getItem(PREF) || '{}'); } catch (e) { return; }
    if (!p || typeof p !== 'object') return;
    if (p.view === 'card' || p.view === 'list') S.view = p.view;
    if (typeof p.sort === 'string') S.sort = p.sort;
    if (typeof p.q === 'string') S.q = p.q;
    if (typeof p.tab === 'string') S.tab = p.tab;
    if (typeof p.notesTab === 'string') S.notesTab = p.notesTab;
    if (typeof p.panel === 'boolean') S.panel = p.panel;
    if (p.f && typeof p.f === 'object') Object.keys(S.f).forEach((k) => {
      const v = p.f[k];
      if (Array.isArray(S.f[k]) && Array.isArray(v)) S.f[k] = v.filter((x) => typeof x === 'string');
      else if (!Array.isArray(S.f[k]) && typeof v === 'string') S.f[k] = v;
    });
  }

  const CASES = DATA.cases;
  const BY_ID = new Map(CASES.map((c) => [c.id, c]));
  const noteCount = (id) => notesCache.filter((n) => n.case_id === id).length;

  // ── 骨架（先建 DOM，再接线）──
  // 只往 body 追加一个根容器（不用 body.innerHTML 覆盖：那会连带清掉页面里其它节点）
  function initShell() {
    const root = document.createElement('div');
    root.id = 'gce-root';
    document.body.appendChild(root);
    root.innerHTML =
      '<div class="app">' +
        '<aside class="side">' +
          '<div class="brand"><b>' + esc(DATA.title) + '</b><span>Case Explorer · ' + esc(DATA.subtitle || '本地只读审阅面') + '</span></div>' +
          '<nav class="tree" id="tree"></nav>' +
          '<div class="sidehint" id="storageNote">便签仅存本机浏览器（IndexedDB），不会修改 Case 文件 · 生成于 ' +
            esc(DATA.generated_at) + '</div>' +
        '</aside>' +
        '<main class="main">' +
          '<div class="mhead"><div class="row">' +
            '<div><h1>Case Explorer</h1><p class="sub" id="count"></p>' +
              '<button class="btn lselall hidden" id="lselall" data-act="selAll"></button></div>' +
            '<div class="tools">' +
              '<span class="search"><input id="q" placeholder="搜索 Case（名称、描述、标签…）" autocomplete="off">' +
              '<kbd>/</kbd></span>' +
              '<span class="seg"><button data-view="card">卡片</button><button data-view="list">列表</button></span>' +
              '<select class="sel" id="sort">' +
                '<option value="recent">修改时间（最近）</option>' +
                '<option value="oldest">修改时间（最早）</option>' +
                '<option value="priority">优先级</option>' +
                '<option value="name">名称</option>' +
                '<option value="id">案号</option>' +
              '</select>' +
              '<button class="btn" id="notesBtn">便签 <span id="notesCount">0</span></button>' +
            '</div>' +
          '</div></div>' +
          '<div id="filterbar"></div>' +
          '<div class="list" id="list"></div>' +
        '</main>' +
      '</div>' +
      '<div class="selbar hidden" id="selbar"></div>' +
      '<div class="scrim hidden" id="scrim"></div>' +
      '<aside class="drawer hidden" id="drawer"></aside>' +
      '<aside class="notes hidden" id="notes"></aside>' +
      '<div class="modal hidden" id="modal"></div>' +
      '<div class="modal top hidden" id="modal2"></div>' +
      '<div class="menu hidden" id="menu"></div>' +
      '<div class="toast" id="toast"></div>';
  }

  // ── 筛选 / 排序 ──
  function visible() {
    const q = S.q.trim().toLowerCase();
    const f = S.f;
    const list = CASES.filter((c) => {
      if (q && c.search.indexOf(q) < 0) return false;
      if (f.business && c.business !== f.business) return false;
      if (f.tags.length && !f.tags.some((t) => c.tags.indexOf(t) >= 0)) return false;
      if (f.lifecycle.length && f.lifecycle.indexOf(c.lifecycle) < 0) return false;
      if (f.health.length && f.health.indexOf(c.health) < 0) return false;
      if (f.type.length && f.type.indexOf(c.type) < 0) return false;
      if (f.level.length && f.level.indexOf(c.level) < 0) return false;
      if (f.priority.length && f.priority.indexOf(c.priority) < 0) return false;
      if (f.scope.length && !f.scope.some((s) => c.changes.some((ch) => ch.scope === s))) return false;
      if (f.mtime && !(now() - ts(c.updated) <= Number(f.mtime) * DAY)) return false;
      return true;
    });
    const s = S.sort;
    list.sort((a, b) => {
      if (s === 'oldest') return String(a.updated).localeCompare(String(b.updated)) || a.id.localeCompare(b.id);
      if (s === 'priority') {
        return ((PR[a.priority] == null ? 9 : PR[a.priority]) - (PR[b.priority] == null ? 9 : PR[b.priority])) ||
          String(b.updated).localeCompare(String(a.updated));
      }
      if (s === 'name') return a.name.localeCompare(b.name, 'zh');
      if (s === 'id') return a.id.localeCompare(b.id);
      return String(b.updated).localeCompare(String(a.updated)) || a.id.localeCompare(b.id);
    });
    return list;
  }
  const activeFilters = () =>
    (S.f.business ? 1 : 0) + S.f.tags.length + S.f.lifecycle.length + S.f.health.length +
    S.f.type.length + S.f.level.length + S.f.priority.length + S.f.scope.length + (S.f.mtime ? 1 : 0);

  // ── 三态渲染 ──
  const lcChip = (c) => '<span class="lc ' + c.lifecycle.toLowerCase() + '" title="生命周期：' +
    (LC_CN[c.lifecycle] || c.lifecycle) + '">' + esc(c.lifecycle) + '</span>';
  const hlChip = (c) => '<span class="hl ' + c.health.toLowerCase() + '" title="健康状态：' +
    (HL_CN[c.health] || c.health) + '"><i></i>' + esc(c.health) + '</span>';
  function verdictOf(c) {
    const r = c.run;
    if (!r) return { cls: 'na', text: '—', title: '无运行记录' };
    const stage = r.failure_stage ? ' · 失败位置 ' + r.failure_stage : '';
    if (r.status === 'FAIL' || r.status === 'ERROR') {
      return {
        cls: 'no', text: '✗ ' + r.fail.length + (r.expected_red ? ' 预期红' : ''),
        title: '最近一次运行：' + (VERDICT_CN[r.status] || r.status) + stage,
      };
    }
    if (r.status === 'PASS') return { cls: 'ok', text: '✓ ' + r.ok, title: '最近一次运行：通过' };
    return { cls: 'na', text: VERDICT_CN[r.status] || r.status, title: '最近一次运行：' + (VERDICT_CN[r.status] || r.status) };
  }
  function runBadge(r) {
    if (r.expected_red) return '<span class="badge" style="color:var(--warn);border-color:var(--warn)">EXPECTED_RED</span>';
    if (r.status === 'FAIL') return '<span class="badge" style="color:var(--bad);border-color:var(--bad)">FAIL</span>';
    if (r.status === 'PASS') return '<span class="badge" style="color:var(--ok);border-color:var(--ok)">PASS</span>';
    return '<span class="badge">' + esc(r.status) + '</span>';
  }
  const priBadge = (p) => (p ? '<span class="pri ' + p.toLowerCase() + '">' + esc(p) + '</span>' : '');
  const tagChips = (tags) => (tags || []).map((t) => '<span class="tag">#' + esc(t) + '</span>').join('');

  // ── 左树 ──
  function renderTree() {
    const byBiz = new Map();
    const tagCount = new Map();
    CASES.forEach((c) => {
      byBiz.set(c.business, (byBiz.get(c.business) || 0) + 1);
      c.tags.forEach((t) => tagCount.set(t, (tagCount.get(t) || 0) + 1));
    });
    const item = (label, count, on, attr) => '<button class="titem' + (on ? ' on' : '') + '" ' + attr + '>' +
      '<span class="tn">' + esc(label) + '</span><span class="tc">' + count + '</span></button>';
    let h = '<div class="tgroup">项目</div>';
    h += item('全部用例', CASES.length, !S.f.business && !S.f.tags.length, 'data-all="1"');
    const uncat = byBiz.get('未分类');
    if (uncat) h += item('未分类', uncat, S.f.business === '未分类', 'data-biz="未分类"');
    h += '<div class="tgroup">业务分类</div>';
    Array.from(byBiz.keys()).sort((a, b) => byBiz.get(b) - byBiz.get(a) || a.localeCompare(b, 'zh'))
      .forEach((b) => { h += item(b, byBiz.get(b), S.f.business === b, 'data-biz="' + esc(b) + '"'); });
    h += '<div class="tgroup">标签</div>';
    Array.from(tagCount.keys()).sort().forEach((t) => {
      h += '<button class="titem' + (S.f.tags.indexOf(t) >= 0 ? ' on' : '') + '" data-tag="' + esc(t) + '">' +
        '<i class="dot"></i><span class="tn">' + esc(t) + '</span><span class="tc">' + tagCount.get(t) + '</span></button>';
    });
    h += '<div class="tgroup">快捷筛选</div>';
    h += item('全部分类', CASES.length, false, 'data-reset="1"');
    h += '<button class="titem" data-jump="lifecycle"><span class="tn">生命周期</span><span class="tc">' +
      (S.f.lifecycle.length || '') + '</span></button>';
    h += '<button class="titem" data-jump="health"><span class="tn">健康状态</span><span class="tc">' +
      (S.f.health.length || '') + '</span></button>';
    $('#tree').innerHTML = h;
  }

  // ── 筛选条 / 面板 ──
  function renderFilterBar() {
    const n = activeFilters();
    const chips = [];
    const push = (label, value, clear) => chips.push('<span class="fchip">' + label + ' <b>' + esc(value) +
      '</b><button data-fclear="' + clear + '" title="清除">×</button></span>');
    if (S.f.business) push('业务分类', S.f.business, 'business');
    S.f.lifecycle.forEach((v) => push('生命周期', v, 'lifecycle:' + v));
    S.f.health.forEach((v) => push('健康', v, 'health:' + v));
    S.f.type.forEach((v) => push('类型', v, 'type:' + v));
    S.f.level.forEach((v) => push('等级', v, 'level:' + v));
    S.f.priority.forEach((v) => push('优先级', v, 'priority:' + v));
    S.f.tags.forEach((v) => push('标签', '#' + v, 'tags:' + v));
    S.f.scope.forEach((v) => push('变更范围', v, 'scope:' + v));
    if (S.f.mtime) push('修改时间', '近 ' + S.f.mtime + ' 天', 'mtime');

    const groups = [
      ['生命周期', 'lifecycle', LC_ORDER, (v) => v + ' · ' + LC_CN[v]],
      ['健康状态', 'health', HL_ORDER, (v) => v + ' · ' + HL_CN[v]],
      ['Case 类型', 'type', TYPE_ORDER, (v) => v],
      ['验证等级', 'level', LV_ORDER, (v) => v + ' · ' + LV_CN[v]],
      ['优先级', 'priority', PR_ORDER, (v) => v],
      ['变更范围', 'scope', SCOPE_ALL, (v) => v],
    ];
    const groupHtml = groups.map(([label, key, values, fmt]) =>
      '<div class="fgroup"><span>' + label + '</span><div class="chipset">' +
      values.map((v) => '<button class="chip' + (S.f[key].indexOf(v) >= 0 ? ' on' : '') + '" data-mf="' +
        key + ':' + esc(v) + '">' + esc(fmt(v)) + '</button>').join('') + '</div></div>').join('');
    const biz = uniq(CASES.map((c) => c.business));
    const tagList = uniq(CASES.reduce((a, c) => a.concat(c.tags), []));

    $('#filterbar').innerHTML =
      '<div class="fbar">' +
        '<button class="btn' + (S.panel ? ' on' : '') + '" data-act="panel">筛选' + (n ? ' · ' + n : '') + '</button>' +
        chips.join('') +
        (!n ? '<span class="muted" style="font-size:.7rem">未设筛选</span>' : '') +
        (n ? '<button class="btn" data-act="clearf" style="margin-left:auto">清空筛选</button>' : '') +
      '</div>' +
      (S.panel ? '<div class="fpanel"><div class="fgrid">' +
        '<div class="fgroup"><span>业务分类</span><div class="chipset">' +
          '<button class="chip' + (!S.f.business ? ' on' : '') + '" data-sf="business:">全部</button>' +
          biz.map((b) => '<button class="chip' + (S.f.business === b ? ' on' : '') + '" data-sf="business:' +
            esc(b) + '">' + esc(b) + '</button>').join('') + '</div></div>' +
        '<div class="fgroup"><span>标签</span><div class="chipset">' +
          (tagList.length ? tagList.map((t) => '<button class="chip' + (S.f.tags.indexOf(t) >= 0 ? ' on' : '') +
            '" data-mf="tags:' + esc(t) + '">#' + esc(t) + '</button>').join('') : '<span class="muted">—</span>') +
          '</div></div>' + groupHtml +
        '<div class="fgroup"><span>修改时间（最近关键标准修改）</span><div class="chipset">' +
          '<button class="chip' + (!S.f.mtime ? ' on' : '') + '" data-sf="mtime:">不限</button>' +
          [['1', '今天'], ['3', '近 3 天'], ['7', '近 7 天'], ['30', '近 30 天']].map(([v, l]) =>
            '<button class="chip' + (S.f.mtime === v ? ' on' : '') + '" data-sf="mtime:' + v + '">' + l + '</button>').join('') +
        '</div></div></div>' +
      '<div class="fops"><button class="btn" data-act="clearf">清空</button>' +
      '<button class="btn pri" data-act="panel">收起</button></div></div>' : '');
  }

  // ── 卡片 / 列表 ──
  function changesCell(c) {
    const ch = c.changes.length ? c.changes[c.changes.length - 1] : null;
    if (!ch) return '<span class="muted">—</span>';
    return (ch.scope ? '<span class="scope">' + esc(ch.scope) + '</span>' : '') +
      '<span class="cwhat">' + esc(ch.what || '') + '</span><span class="when">' + fmtRel(ch.when || c.updated) + '</span>';
  }
  function cardHtml(c) {
    const n = noteCount(c.id);
    return '<article class="card' + (c.id === S.open ? ' on' : '') + (S.sel.has(c.id) ? ' sel' : '') +
      (c.health === 'BROKEN' ? ' bad' : '') +
      '" data-card="' + c.id + '">' +
      '<div class="chead"><span class="pick" data-sel="' + c.id + '" title="选择"><input type="checkbox"' +
        (S.sel.has(c.id) ? ' checked' : '') + '></span><span class="cid">' + c.id + '</span>' + lcChip(c) + hlChip(c) +
        '<button class="cmore" data-menu="' + c.id + '" title="更多操作">⋯</button></div>' +
      '<h3 class="cname">' + esc(c.name) + '</h3>' +
      '<p class="cdesc">' + esc(c.description) + '</p>' +
      '<div class="ctags">' + tagChips(c.tags) + '</div>' +
      '<div class="cfoot"><span class="lvl" title="' + esc(LV_CN[c.level] || '') + '">' + esc(c.level || '—') + '</span>' +
        priBadge(c.priority) + changesCell(c) +
        (n ? '<span class="cnote" title="本机便签">📝 ' + n + '</span>' : '') +
      '</div></article>';
  }
  function tableHtml() {
    const rows = visible().map((c) => {
      const ch = c.changes.length ? c.changes[c.changes.length - 1] : null;
      const n = noteCount(c.id);
      return '<tr class="rowc' + (c.id === S.open ? ' on' : '') + (S.sel.has(c.id) ? ' sel' : '') +
        (c.health === 'BROKEN' ? ' bad' : '') +
        '" data-card="' + c.id + '">' +
        '<td><span class="pick" data-sel="' + c.id + '" title="选择"><input type="checkbox"' +
          (S.sel.has(c.id) ? ' checked' : '') + '></span></td>' +
        '<td class="pid">' + c.id + '</td>' +
        '<td class="pname"><span class="n">' + esc(c.name) + (n ? ' <span class="cnote">📝 ' + n + '</span>' : '') +
          '</span><span class="d">' + esc(c.description) + '</span></td>' +
        '<td><div class="tags-cell">' + tagChips(c.tags) + '</div></td>' +
        '<td class="nowrap">' + lcChip(c) + '</td>' +
        '<td class="nowrap">' + hlChip(c) + '</td>' +
        '<td class="nowrap"><span class="badge">' + esc(c.level || '—') + '</span></td>' +
        '<td class="nowrap">' + (priBadge(c.priority) || '<span class="muted">—</span>') + '</td>' +
        '<td class="nowrap muted">' + fmtRel(c.updated) + '</td>' +
        '<td>' + (ch ? (ch.scope ? '<span class="badge">' + esc(ch.scope) + '</span> ' : '') +
          '<span class="muted">' + esc(ch.what || '') + '</span>' : '<span class="muted">—</span>') + '</td>' +
        '</tr>';
    }).join('');
    return '<table class="tbl"><thead><tr><th></th><th>ID</th><th>名称 / 描述</th><th>标签</th><th>生命周期</th>' +
      '<th>健康状态</th><th>等级</th><th>优先级</th><th>修改时间</th><th>最近关键标准修改</th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table>';
  }
  function renderList() {
    const list = visible();
    $('#count').textContent = '共 ' + list.length + ' 条用例' +
      (list.length !== CASES.length ? '（全量 ' + CASES.length + '）' : '') +
      ' · 排序：' + $('#sort').selectedOptions[0].textContent;
    const all = $('#lselall');
    all.textContent = '全选当前结果（' + list.length + '）';
    all.classList.toggle('hidden', !list.length);
    $('#list').innerHTML = list.length
      ? (S.view === 'card' ? '<div class="cards">' + list.map(cardHtml).join('') + '</div>' : tableHtml())
      : '<div class="empty">没有匹配的 Case —— 放宽筛选或清空搜索。</div>';
  }

  // ── Selection Bar ──
  function renderSelBar() {
    const el = $('#selbar');
    el.classList.toggle('hidden', S.sel.size === 0);
    if (!S.sel.size) return;
    const m = visible().length;
    el.innerHTML = '<span class="n">已选 <b>' + S.sel.size + '</b> / 匹配 <b>' + m + '</b></span>' +
      '<button class="clear" data-act="clearSel">清空选择</button>' +
      '<button class="btn" data-act="selAll">选择当前筛选结果（' + m + '）</button>' +
      '<span class="ops"><button class="btn" data-act="composeModifySel">让 Agent 修改</button>' +
      '<button class="btn pri" data-act="composeVerifySel">生成验证指令</button></span>';
  }

  // ── Drawer ──
  const tabsOf = (c) => [['SPEC', '业务规范', 5], ['VERIFY', '验证要点', c.vps.length],
    ['EXECUTION', '执行相关', c.dependencies.length + c.tests.length + (c.run ? 1 : 0) + 3],
    ['HISTORY', '运行历史', c.history.length],
    ['VERSION', '版本历史', c.changes.length]];
  const firstFail = (c) => c.vps.find((v) => v.status === 'FAIL' || v.status === 'ERROR') || null;

  function specTab(c) {
    const g = c.given;
    const items = [].concat(g.inputs || [], g.preconditions || []);
    const facts = [];
    Object.keys(g.balances || {}).forEach((u) => facts.push(esc(u) + ' 账上有 ' + esc(Number(g.balances[u])) + ' 元'));
    Object.keys(g.stock || {}).forEach((k) => facts.push(esc(k) + ' 还剩 ' + esc(Number(g.stock[k])) + ' ' +
      esc((g.stockUnits || {})[k] || '个')));
    const none = !items.length && !facts.length && !c.given_prose;
    return '<div class="blk lead-h"><h3><span class="no">1</span>Description · 业务描述</h3><p>' +
      esc(c.description || '未描述') + '</p></div>' +
      '<div class="blk"><h3><span class="no">2</span>Given · 前置条件</h3>' +
        (items.length ? '<ul>' + items.map((x) => '<li>' + esc(x) + '</li>').join('') + '</ul>' : '') +
        (facts.length ? '<ul>' + facts.map((x) => '<li>' + x + '</li>').join('') + '</ul>' : '') +
        (c.given_prose ? '<p class="muted">' + esc(c.given_prose) + '</p>' : '') +
        (g.environment ? '<p class="muted">环境：' + esc(g.environment) + '</p>' : '') +
        (none ? '<p class="muted">未描述</p>' : '') + '</div>' +
      '<div class="blk"><h3><span class="no">3</span>When · 执行动作</h3><p>' +
        esc(c.when_prose || c.when_struct || '未描述') + '</p>' +
        (c.when_struct ? '<details class="q"><summary>动作参数</summary><div class="sql">' + esc(c.when_struct) +
          '</div></details>' : '') + '</div>' +
      '<div class="blk"><h3><span class="no">4</span>Then · 预期结果</h3>' +
        (c.then.length ? '<ul>' + c.then.map((t) => '<li>' + esc(t) + '</li>').join('') + '</ul>'
          : '<p class="muted">未描述</p>') + '</div>' +
      '<div class="blk"><h3><span class="no">5</span>Invariant · 不变性要求</h3>' +
        (c.invariants.length ? c.invariants.map((iv) => '<p><b>' + esc(iv.id) + '</b> ' + esc(iv.description) +
          (iv.expression ? ' <span class="mono muted">' + esc(iv.expression) + '</span>' : '') +
          (iv.severity ? ' <span class="badge">' + esc(iv.severity) + '</span>' : '') +
          (iv.verification_status ? ' <span class="badge">' + esc(iv.verification_status) + '</span>' : '') +
          '</p>').join('') : '<p class="muted">无独立不变量对象</p>') + '</div>';
  }
  function verifyTab(c) {
    const ff = firstFail(c);
    const head = ff ? '<div class="blk warn-h"><h3>从哪里开始错</h3><p>首个失败验证点 <b>' + esc(ff.id) + ' ' +
      esc(ff.name) + '</b>' + (ff.actual != null ? '：期望 <b>' + esc(ff.expected) + '</b> · 实际 <b style="color:var(--bad)">' +
        esc(ff.actual) + '</b>' : '') + (ff.message ? '<br><span class="muted">' + esc(ff.message) + '</span>' : '') +
      '</p></div>' : '';
    const vps = c.vps.map((v) => {
      const st = v.status === 'PASS' ? '<span class="vd ok">✓ 通过</span>'
        : (v.status === 'FAIL' || v.status === 'ERROR') ? '<span class="vd no">✗ 不符</span>'
          : (v.status ? '<span class="vd na">' + esc(v.status) + '</span>' : '');
      return '<div class="vp' + (v.status === 'FAIL' || v.status === 'ERROR' ? ' fail' : '') + '">' +
        '<div class="vh"><span class="vid">' + esc(v.id) + '</span><span class="vn">' + esc(v.name) + '</span>' +
        (v.severity ? '<span class="badge">' + esc(v.severity) + '</span>' : '') +
        (ff && ff.id === v.id ? '<span class="first-fail">首失败</span>' : '') + st + '</div>' +
        '<dl class="qa">' +
          '<dt>看什么</dt><dd>' + esc(v.name) + '</dd>' +
          '<dt>去哪里看</dt><dd>' + esc(v.target || v.source) +
            (v.source ? ' <span class="mono muted">' + esc(v.source) + '</span>' : '') + '</dd>' +
          '<dt>怎么判断</dt><dd><span class="mono">' + esc(v.operator || '==') + '</span>' +
            (v.actual != null ? ' · 实际 <b>' + esc(v.actual) + '</b>' : '') + '</dd>' +
          '<dt>Expected</dt><dd><b>' + esc(v.expected) + '</b>' + (v.unit ? ' ' + esc(v.unit) : '') +
            (v.bad ? ' <span class="first-fail">不可判定</span>' : '') + '</dd>' +
        '</dl>' + (v.message ? '<div class="issue">' + esc(v.message) + '</div>' : '') +
        (v.example ? '<details class="q"><summary>示例查询</summary><div class="sql">' + esc(v.example) +
          '</div></details>' : '') + '</div>';
    }).join('');
    return head + (vps || '<div class="blk"><p class="muted">该 Case 没有验证点。</p></div>');
  }
  function execTab(c) {
    const rows = [
      ['Case 类型', c.type ? esc(c.type) + (TYPE_CN[c.type] ? ' · ' + TYPE_CN[c.type] : '') : null],
      ['验证等级', c.level ? esc(c.level) + (LV_CN[c.level] ? ' · ' + LV_CN[c.level] : '') : null],
      ['优先级', c.priority ? priBadge(c.priority) : null],
      ['执行环境', c.run && c.run.environment ? esc(c.run.environment) : (c.given.environment ? esc(c.given.environment) : null)],
    ].filter((r) => r[1]);
    let h = '<div class="blk"><h3>执行相关</h3>' + (rows.length
      ? '<dl class="meta-grid">' + rows.map((r) => '<dt>' + r[0] + '</dt><dd>' + r[1] + '</dd>').join('') + '</dl>'
      : '<p class="muted">无结构化执行信息</p>');
    if (c.dependencies.length) {
      h += '<h4>依赖</h4>' + c.dependencies.map((d) => '<p><b>' + esc(d.name) + '</b> <span class="badge">' +
        esc(d.mode) + '</span>' + (d.type ? ' <span class="muted">' + esc(d.type) + '</span>' : '') +
        (d.configuration ? '<br><span class="muted">' + esc(d.configuration) + '</span>' : '') +
        (d.mock_behavior ? '<br><span class="muted">Mock：' + esc(d.mock_behavior) + '</span>' : '') + '</p>').join('');
    }
    if (c.tests.length) {
      h += '<h4>测试（机器可执行实现，Case 一对多）</h4>' + c.tests.map((t) => '<p><b>' + esc(t.id) + '</b> ' +
        '<span class="badge">' + esc(t.type) + '</span> <span class="badge" style="' +
        (t.status === 'EXPECTED_RED' ? 'color:var(--warn);border-color:var(--warn)'
          : t.status === 'GREEN' || t.status === 'PASS' ? 'color:var(--ok);border-color:var(--ok)' : '') + '">' +
        esc(t.status) + '</span>' + (t.framework ? '<br><span class="mono muted">' + esc(t.framework) + ' · ' +
          esc(t.file) + '</span>' : '') + (t.failure_reason ? '<br><span class="muted">' + esc(t.failure_reason) +
          '</span>' : '') + '</p>').join('');
    }
    if (c.run) {
      const r = c.run;
      h += '<h4>最近一次运行</h4><p>' + runBadge(r) + ' <span class="muted">' + esc(r.started_at) +
        (r.duration_ms != null ? ' · 耗时 ' + fmtDur(r.duration_ms) : '') +
        (r.failure_stage ? ' · 失败位置 <b>' + esc(r.failure_stage) + '</b>' : '') + '</span></p>' +
        (r.source_note ? '<p class="side-note">' + esc(r.source_note) + '</p>' : '') +
        (r.results.length ? '<table class="tbl"><thead><tr><th>验证点</th><th>Expected</th><th>Actual</th><th>判定</th>' +
          '</tr></thead><tbody>' + r.results.map((x) => '<tr><td>' + esc(x.vp_id || x.source) + '</td><td>' +
          esc(x.expected) + '</td><td>' + esc(x.actual == null ? '—' : x.actual) + '</td><td>' +
          (x.status === 'PASS' ? '<span class="vd ok">✓</span>' : x.status === 'FAIL'
            ? '<span class="vd no">✗</span>' : '<span class="vd na">' + esc(x.status || '未跑') + '</span>') +
          '</td></tr>').join('') + '</tbody></table>' : '') + (r.logs ? '<details class="q"><summary>日志 / 输出</summary>' +
          '<div class="sql">' + esc(r.logs) + '</div></details>' : '');
    }
    return h + '</div>';
  }
  // 台账判定 chip：历史行里的判定字符串直接渲染（未知值按中性色）
  const histChip = (v) => v === 'PASS' ? '<span class="vd ok">✓ PASS</span>'
    : (v === 'FAIL' || v === 'ERROR') ? '<span class="vd no">✗ ' + esc(v) + '</span>'
      : '<span class="vd na">' + esc(v || 'NOT_RUN') + '</span>';
  function historyTab(c) {
    const rows = c.history;
    return '<div class="blk"><h3>运行历史</h3>' + (rows.length
      ? '<p class="muted">最近 ' + rows.length + ' 次（新在前，每案封顶 20 条）· 来源 ' +
        'runs-history/YYYY-MM.jsonl，只读台账，不是本次判定依据</p>' +
        '<table class="tbl"><thead><tr><th>时间</th><th>判定</th><th>首失败</th></tr></thead><tbody>' +
        rows.map((h) => '<tr><td class="nowrap">' + esc(h.when) + '</td><td>' + histChip(h.verdict) +
          '</td><td class="mono">' + esc(h.first_fail || '—') + '</td></tr>').join('') + '</tbody></table>'
      : '<p class="muted">—</p>') + '</div>';
  }
  function versionTab(c) {
    const tl = c.changes.slice().reverse().map((ch, i) => '<li class="' + (i === 0 ? 'cur' : '') + '">' +
      '<span class="v">v' + esc(ch.v) + '</span><span class="w">' + esc(ch.when) + '</span>' +
      (ch.by ? '<span class="muted">' + esc(ch.by) + '</span> ' : '') +
      (ch.scope ? '<span class="badge">' + esc(ch.scope) + '</span> ' : '') + esc(ch.what) + '</li>').join('');
    return '<div class="blk"><h3>版本历史</h3><p class="muted">当前版本 v' + esc(c.version) + ' · 创建 ' +
      esc(c.created || '—') + ' ' + esc(c.createdBy) + '</p>' +
      (tl ? '<ul class="tl">' + tl + '</ul>' : '<p class="muted">无变更记录</p>') + '</div>' +
      (c.lifecycle === 'FROZEN' ? '<div class="blk warn-h"><h3>🔒 Frozen 保护规则</h3><p>当前 Case 处于 FROZEN 状态。' +
        'Then / Invariant / Verification Point 是人工确认过的业务标准，AI 不得静默覆盖。<br>' +
        '如需修改：<b>创建新版本 → 修改 → 重新进入人工确认 → 再次冻结</b>。</p></div>' : '');
  }

  function renderDrawer() {
    const el = $('#drawer');
    const scrim = $('#scrim');
    const c = S.open ? BY_ID.get(S.open) : null;
    if (!c) {
      el.classList.remove('on');
      scrim.classList.remove('on');
      if (!el.classList.contains('hidden')) setTimeout(() => {
        if (!S.open) { el.classList.add('hidden'); scrim.classList.add('hidden'); }
      }, 150);
      return;
    }
    el.classList.remove('hidden');
    scrim.classList.remove('hidden');
    requestAnimationFrame(() => { el.classList.add('on'); scrim.classList.add('on'); });
    const v = verdictOf(c);
    const list = visible();
    const idx = list.findIndex((x) => x.id === c.id);
    const last = c.changes.length ? c.changes[c.changes.length - 1] : null;
    el.innerHTML =
      '<div class="dhead"><div class="r1"><span class="cid">' + esc(c.id) + '</span>' + lcChip(c) + hlChip(c) +
        '<span class="badge">v' + esc(c.version) + '</span>' + priBadge(c.priority) +
        '<span class="badge" title="' + esc(LV_CN[c.level] || '') + '">' + esc(c.level || '—') + '</span>' +
        '<span class="dnav"><button data-act="prev" title="上一个（筛选结果内）">‹</button>' +
        '<button data-act="next" title="下一个">›</button><button data-act="closeDrawer" title="关闭">✕</button></span></div>' +
      '<h2>' + esc(c.name) + '</h2><p class="ddesc">' + esc(c.description) + '</p>' +
      '<div class="ctags">' + tagChips(c.tags) + '</div>' +
      '<div class="dmeta"><span>业务分类 ' + esc(c.business) + '</span><span>创建 ' + esc(c.created || '—') + '</span>' +
        '<span>最近关键标准修改 ' + fmtRel(c.updated) + (last ? '（' + esc(last.scope || '变更') + '）' : '') + '</span>' +
        (c.updatedBy ? '<span>修改者 ' + esc(c.updatedBy) + '</span>' : '') +
        '<span>筛选结果内 ' + (idx >= 0 ? idx + 1 : '—') + '/' + list.length + '</span></div>' +
      '<div class="dactions">' +
        '<button class="btn" data-act="noteAdd" data-id="' + c.id + '">加入便签</button>' +
        '<button class="btn" data-act="composeVerify" data-id="' + c.id + '">生成验证指令</button>' +
        '<button class="btn pri" data-act="composeModify" data-id="' + c.id + '">让 Agent 修改</button>' +
        '<span class="vd ' + v.cls + '" title="' + esc(v.title) + '">最近判定 ' + v.text + '</span></div></div>' +
      '<div class="tabs">' + tabsOf(c).map(([k, label, n]) => '<button class="' + (S.tab === k ? 'on' : '') +
        '" data-tab="' + k + '">' + label + '<span>' + n + '</span></button>').join('') + '</div>' +
      '<div class="dbody">' + (S.tab === 'SPEC' ? specTab(c) : S.tab === 'VERIFY' ? verifyTab(c)
        : S.tab === 'EXECUTION' ? execTab(c) : S.tab === 'HISTORY' ? historyTab(c) : versionTab(c)) + '</div>';
  }

  // ── 便签：IndexedDB（不可用则退化为内存并提示） ──
  const DB_NAME = 'golden-case-explorer';
  let DB = null;        // null=未探测 false=不可用
  let MEM_NOTES = [];
  let MEM_KV = {};
  let notesCache = [];

  function openDB() {
    if (DB !== null) return Promise.resolve(DB);
    return new Promise((resolve) => {
      let req;
      try { req = indexedDB.open(DB_NAME, 1); } catch (e) { DB = false; return resolve(false); }
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('notes')) d.createObjectStore('notes', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv', { keyPath: 'k' });
      };
      req.onsuccess = () => { DB = req.result; resolve(DB); };
      req.onerror = () => { DB = false; resolve(false); };
    });
  }
  async function dbAll(store) {
    const db = await openDB();
    if (!db) return store === 'notes' ? MEM_NOTES.slice() : Object.keys(MEM_KV).map((k) => ({ k, v: MEM_KV[k] }));
    return new Promise((res) => {
      const r = db.transaction(store, 'readonly').objectStore(store).getAll();
      r.onsuccess = () => res(r.result || []);
      r.onerror = () => res([]);
    });
  }
  async function dbPut(store, val) {
    const db = await openDB();
    if (!db) {
      if (store === 'notes') MEM_NOTES = MEM_NOTES.filter((n) => n.id !== val.id).concat([val]);
      else MEM_KV[val.k] = val.v;
      return;
    }
    return new Promise((res) => {
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).put(val);
      tx.oncomplete = () => res();
      tx.onerror = () => res();
    });
  }
  async function dbDel(store, key) {
    const db = await openDB();
    if (!db) {
      if (store === 'notes') MEM_NOTES = MEM_NOTES.filter((n) => n.id !== key); else delete MEM_KV[key];
      return;
    }
    return new Promise((res) => {
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).delete(key);
      tx.oncomplete = () => res();
      tx.onerror = () => res();
    });
  }
  async function dbClear(store) {
    const db = await openDB();
    if (!db) { if (store === 'notes') MEM_NOTES = []; else MEM_KV = {}; return; }
    return new Promise((res) => {
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).clear();
      tx.oncomplete = () => res();
      tx.onerror = () => res();
    });
  }
  async function loadNotes() {
    notesCache = (await dbAll('notes')).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    $('#notesCount').textContent = notesCache.length;
    renderNotes();
    renderList();
  }
  const noteNew = (caseId) => {
    const c = caseId ? BY_ID.get(caseId) : null;
    return {
      id: 'N-' + now().toString(36) + '-' + Math.floor((performance.now() || 0) % 1000),
      case_id: c ? c.id : null, case_name: c ? c.name : '', scope: [], content: '',
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(), status: 'pending',
    };
  };
  async function saveNote(n) {
    n.updated_at = new Date().toISOString();
    await dbPut('notes', n);
    await loadNotes();
  }

  function renderNotes() {
    const el = $('#notes');
    el.classList.toggle('hidden', !S.notesOpen);
    if (!S.notesOpen) { el.classList.remove('on'); return; }
    requestAnimationFrame(() => el.classList.add('on'));
    const counts = { all: notesCache.length, pending: 0, generated: 0, done: 0 };
    notesCache.forEach((n) => { counts[n.status] = (counts[n.status] || 0) + 1; });
    const list = notesCache.filter((n) => S.notesTab === 'all' || n.status === S.notesTab);
    el.innerHTML =
      '<div class="nhead"><div class="r1"><h2>临时便签 · ' + notesCache.length + '</h2>' +
        '<span style="margin-left:auto;display:flex;gap:.4rem">' +
          '<button class="btn" data-act="notesExport">导出</button>' +
          '<button class="btn" data-act="notesClear">清空</button>' +
          '<button class="x" data-act="notesClose" title="关闭">✕</button></span></div>' +
        '<div class="ntabs">' + [['all', '全部'], ['pending', '待处理'], ['generated', '已生成'], ['done', '已完成']]
          .map(([k, l]) => '<button class="' + (S.notesTab === k ? 'on' : '') + '" data-ntab="' + k + '">' + l +
            ' (' + (counts[k] || 0) + ')</button>').join('') + '</div></div>' +
      '<div class="nbody">' + (list.length ? list.map((n) =>
        '<div class="nitem' + (n.status === 'done' ? ' done' : '') + '">' +
        '<div class="r1"><input type="checkbox" data-nsel="' + n.id + '"' + (S.noteSel.has(n.id) ? ' checked' : '') + '>' +
          '<span class="cid">' + esc(n.case_id || '自由便签') + '</span>' +
          '<span class="muted">' + esc(n.case_name) + '</span>' +
          '<span class="st ' + esc(n.status) + '">' + (ST_CN[n.status] || n.status) + '</span></div>' +
        (n.scope.length ? '<div class="sc">' + n.scope.map((s) => '<span class="badge">' + esc(s) + '</span>').join('') +
          '</div>' : '') +
        '<p class="ct">' + esc(n.content) + '</p>' +
        '<div class="r2"><span>' + fmtRel(n.updated_at) + '</span><span class="ops">' +
          '<button data-act="noteEdit" data-nid="' + n.id + '">编辑</button>' +
          '<button data-act="noteDel" data-nid="' + n.id + '">删除</button></span></div></div>').join('')
        : '<div class="empty">还没有便签。<br>浏览 Case 时点「加入便签」，或直接记一条不关联 Case 的想法。</div>') +
      '</div>' +
      '<div class="nfoot"><span>已选 ' + S.noteSel.size + ' 条</span><span class="ops">' +
        '<button class="btn" data-act="noteNewFree">+ 自由便签</button>' +
        '<button class="btn pri" data-act="notesCompose"' + (S.noteSel.size ? '' : ' disabled') +
        '>生成 Agent 指令</button></span></div>' +
      '<div class="sidehint">⚠ 临时便签仅保存在当前浏览器（IndexedDB），不会修改任何 Case 文件。</div>';
  }

  // ── Prompt 生成（§8 / §9 / §12：初稿可编辑 → 复制） ──
  function modifyPrompt(ids, scopes, requirement) {
    const cases = ids.map((id) => BY_ID.get(id)).filter(Boolean);
    const frozen = cases.filter((c) => c.lifecycle === 'FROZEN' && scopes.some((s) => SCOPE_FROZEN.indexOf(s) >= 0));
    const lines = ['# 请处理以下 Case 的修改', ''];
    cases.forEach((c, i) => {
      lines.push('## ' + (i + 1) + '. ' + c.id + ' ' + c.name);
      lines.push('- 修改范围：' + (scopes.length ? scopes.join('、') : '（未指定，请先向用户确认）'));
      lines.push('- 当前状态：' + c.lifecycle + (c.lifecycle === 'FROZEN' ? '（已冻结）' : ''));
      lines.push('- 要求：');
      lines.push('  ' + (requirement.trim() || '（在此填写具体修改要求）').replace(/\n/g, '\n  '));
      lines.push('');
    });
    if (frozen.length) {
      lines.push('## ⚠ Frozen 保护（必须遵守）');
      frozen.forEach((c) => lines.push('- ' + c.id + ' 处于 FROZEN：' + SCOPE_FROZEN.join(' / ') +
        ' 是人工确认过的业务标准，不得静默覆盖。'));
      lines.push('- 处理方式：**创建新版本（version + 1）→ 修改 → 重新进入人工确认 → 再次冻结**。');
      lines.push('- 人工确认通过之前，不要改动已冻结的期望值。');
      lines.push('');
    }
    lines.push('## 通用要求');
    lines.push('1. 只改指定 Case 的指定范围，不动其它业务标准。');
    lines.push('2. 期望值（金标）只能由需求方定义/确认，不得从实现输出反推。');
    lines.push('3. 不得为了让测试转绿而修改期望值：改实现，不改标准。');
    lines.push('4. 修改后同步 cases 文件的 changes（v / when / what / scope）。');
    lines.push('5. 完成后回报每个 Case 的变更摘要与影响面。');
    return lines.join('\n');
  }
  function verifyPrompt(ids, o) {
    const cases = ids.map((id) => BY_ID.get(id)).filter(Boolean);
    const lines = ['# 请执行以下 Case 的批量验证', '', '用例清单（' + cases.length + '）：'];
    cases.forEach((c) => lines.push('- ' + c.id + ' ' + c.name + '（' + (c.level || '默认等级') + ' · ' +
      c.business + ' · ' + c.vps.length + ' 个验证点）'));
    lines.push('', '要求：');
    lines.push('1. 按各 Case 的 Given / When 搭建验证环境；观察点见对应 Verification Point（看什么 / 去哪里看 / 怎么判断 / Expected）。');
    lines.push('2. 验证范围：' + (o.scope.join('、') || '全部'));
    lines.push(o.l12 ? '3. 仅执行本地验证（L1 + L2），不申请真实外部依赖。' : '3. 按各 Case 的 Verification Level 执行。');
    lines.push(o.real ? '4. 包含真实依赖执行；需要 Key 时只引用环境变量，不把密钥写进文件或 Case 数据。'
      : '4. 缺少真实依赖时使用 MOCK / FAKE，并在报告中标注哪些验证点因此降级。');
    lines.push('5. ' + (o.keepGoing ? '某个 Case 失败后继续执行其它 Case。' : '遇失败即停止，先报告首个失败。'));
    if (o.firstFail) lines.push('6. 每个 Case 返回第一个失败的 Verification Point，作为 Debug 入口。');
    if (o.expActual) lines.push('7. 输出 Expected / Actual 对照（含实际取值与差异）。');
    lines.push('8. 测试名携带锚点（如 CASE-003:checkpoint_c_total），便于报告按 CASE 聚合。');
    lines.push('9. 不得修改 Case 文件里的期望值（金标）；若发现期望可疑，单独提出由需求方裁决。');
    return lines.join('\n');
  }
  function notesPrompt(notes) {
    const lines = ['# 请处理以下 Case 的修改', '', '（来源：Review 便签，共 ' + notes.length + ' 条）', ''];
    notes.forEach((n, i) => {
      lines.push('## ' + (i + 1) + '. ' + (n.case_id ? n.case_id + ' ' + n.case_name : '不关联具体 Case（自由记录）'));
      if (n.scope.length) lines.push('- 修改范围：' + n.scope.join('、'));
      lines.push('- 要求：', '  ' + n.content.replace(/\n/g, '\n  '), '');
    });
    lines.push('## 通用要求');
    lines.push('1. 分别定位到对应 Case；不修改无关的业务标准。');
    lines.push('2. 涉及 Frozen Case 的核心标准（Then / Invariant / Verification Point）修改，请创建新版本并进入人工确认流程。');
    lines.push('3. 完成后汇总每个 Case 的变更。');
    return lines.join('\n');
  }

  // ── Composer ──
  let composer = null;
  const frozenHits = (ids) => ids.map((id) => BY_ID.get(id)).filter((c) => c && c.lifecycle === 'FROZEN');
  function openComposer(mode, ids) {
    composer = {
      mode, ids: ids.slice(), scopes: [], requirement: '', draft: '', dirty: false, frozenOk: false,
      v: {
        l12: true, real: false, keepGoing: true, firstFail: true, expActual: true,
        scope: ['Given 前置条件', 'When 执行动作', 'Then 预期结果', 'Invariant 约束规则', 'Verification Point 验证点'],
      },
    };
    if (mode === 'notes') composer.draft = notesPrompt(notesCache.filter((n) => S.noteSel.has(n.id)));
    renderComposer();
  }
  function closeComposer() { composer = null; renderComposer(); }
  function draftFor() {
    if (composer.mode === 'modify') return modifyPrompt(composer.ids, composer.scopes, composer.requirement);
    if (composer.mode === 'verify') return verifyPrompt(composer.ids, composer.v);
    return notesPrompt(notesCache.filter((n) => S.noteSel.has(n.id)));
  }
  function renderComposer() {
    const el = $('#modal');
    if (!composer) { el.classList.add('hidden'); el.innerHTML = ''; return; }
    const c = composer;
    const cases = c.ids.map((id) => BY_ID.get(id)).filter(Boolean);
    el.classList.remove('hidden');
    const title = c.mode === 'modify' ? '让 Agent 修改 Case' : c.mode === 'verify' ? '生成验证指令' : '生成 Agent 指令（来自便签）';
    let body = '';
    if (c.mode === 'notes') {
      const notes = notesCache.filter((n) => S.noteSel.has(n.id));
      body = '<p class="muted" style="margin-top:0">基于已选 ' + notes.length + ' 条便签生成修改指令，可继续编辑后复制。</p>' +
        notes.map((n) => '<p><b>' + esc(n.case_id ? n.case_id + ' ' + n.case_name : '自由便签') + '</b>' +
          (n.scope.length ? ' <span class="badge">' + esc(n.scope.join('、')) + '</span>' : '') +
          '<br><span class="muted">' + esc(n.content) + '</span></p>').join('');
    } else {
      body += '<h4>目标用例（' + cases.length + '）</h4><div class="tgt">' + cases.map((x) =>
        '<span class="fchip"><b>' + x.id + '</b> ' + esc(x.name) + lcChip(x) + '</span>').join('') + '</div>';
      if (c.mode === 'modify') {
        const frozen = frozenHits(c.ids);
        if (frozen.length) {
          body += '<div class="warnbox"><b>⚠ Frozen 保护</b><br>' + frozen.map((x) => x.id).join('、') +
            ' 处于 FROZEN 状态。若修改范围包含 ' + SCOPE_FROZEN.join(' / ') +
            '，系统将要求<b>创建新版本 → 重新人工确认 → 再次冻结</b>，不会静默覆盖原标准。</div>';
        }
        body += '<h4>选择修改范围（可多选）</h4><div class="chipset">' + SCOPE_ALL.map((s) =>
          '<button class="chip' + (c.scopes.indexOf(s) >= 0 ? ' on' : '') + '" data-mscope="' + esc(s) + '">' +
          esc(s) + '</button>').join('') + '</div>' +
          '<h4>修改要求</h4><textarea id="mreq" rows="3" placeholder="请描述你希望怎么改（如：Then 里的余额验证应该用 delta，不应写死 80；同时检查库存）">' +
          esc(c.requirement) + '</textarea><div class="count" id="mcount">' + c.requirement.length + '/500</div>';
      } else {
        body += '<h4>验证选项</h4><div class="opts">' +
          [['l12', '仅本地验证 L1 + L2'], ['real', '包含真实依赖执行'], ['keepGoing', '失败后继续执行其它 Case'],
            ['firstFail', '返回首个失败 Verification Point'], ['expActual', '输出 Expected / Actual 对照']]
            .map(([k, l]) => '<label><input type="checkbox" data-vopt="' + k + '"' + (c.v[k] ? ' checked' : '') +
              '>' + l + '</label>').join('') + '</div>' +
          '<h4>验证范围（点击可取消）</h4><div class="chipset">' + c.v.scope.map((s) =>
            '<button class="chip on" data-vscope="' + esc(s) + '">' + esc(s) + '</button>').join('') + '</div>';
      }
    }
    body += '<h4>生成结果（可编辑）</h4>' +
      '<textarea class="draft" id="mdraft" placeholder="点「生成初稿」自动生成，或直接在这里手写">' + esc(c.draft) + '</textarea>' +
      (c.dirty ? '<div class="count">已手动编辑；改选项后点「刷新初稿」会用新选项覆盖</div>' : '');
    const canCopy = !!c.draft;
    el.innerHTML = '<div class="mcard"><div class="mhead2"><h3>' + title + '</h3>' +
      '<button class="x" data-act="composerClose">✕</button></div>' +
      '<div class="mbody">' + body + '</div>' +
      '<div class="mfoot"><span class="hint">' + (c.dirty ? '已编辑（内容以文本框为准）' : '初稿可任意修改后再复制给 Coding Agent') +
      '</span><button class="btn" data-act="composerClose">取消</button>' +
      '<button class="btn pri" data-act="genDraft">' + (canCopy ? '刷新初稿' : '生成初稿') + '</button>' +
      '<button class="btn pri" data-act="copyDraft"' + (canCopy ? '' : ' disabled') + '>复制到剪贴板</button>' +
      '</div></div>';
    if (c.mode === 'modify') {
      $('#mreq').addEventListener('input', (e) => {
        c.requirement = e.target.value.slice(0, 500);
        $('#mcount').textContent = c.requirement.length + '/500';
      });
    }
    $('#mdraft').addEventListener('input', (e) => {
      c.draft = e.target.value;
      c.dirty = true;
    });
  }

  // ── Frozen 确认（§7：生成修改 Prompt 前明确提示） ──
  function frozenConfirm(ids) {
    const el = $('#modal2');
    el.classList.remove('hidden');
    el.innerHTML = '<div class="mcard narrow"><div class="mhead2"><h3>⚠ 此修改涉及已冻结验证标准</h3>' +
      '<button class="x" data-act="frozenCancel">✕</button></div>' +
      '<div class="mbody"><p><b>' + ids.join('、') + '</b> 当前处于 Frozen 状态。你选择修改以下内容：</p>' +
      '<ul><li>Then 预期结果</li><li>Invariant 约束规则</li><li>Verification Point 验证点</li></ul>' +
      '<div class="warnbox">这将要求系统创建新版本，并重新进入人工确认流程，以保证验证标准的稳定性。</div>' +
      '<p>是否继续？</p></div>' +
      '<div class="mfoot"><button class="btn" data-act="frozenCancel">取消</button>' +
      '<button class="btn pri" data-act="frozenGo">创建新版本并生成修改指令</button></div></div>';
  }
  const closeFrozen = () => { const el = $('#modal2'); el.classList.add('hidden'); el.innerHTML = ''; };

  // ── 便签编辑 ──
  function noteDialog(note, presetId) {
    const n = note || noteNew(presetId);
    const el = $('#modal');
    el.classList.remove('hidden');
    el._note = n;
    el.innerHTML = '<div class="mcard narrow"><div class="mhead2"><h3>' + (note ? '编辑便签' : '加入便签') +
      '</h3><button class="x" data-act="noteCancel">✕</button></div><div class="mbody">' +
      '<h4>关联 Case</h4><select class="sel" id="ncase" style="width:100%">' +
        '<option value="">不关联具体 Case（自由便签）</option>' +
        CASES.map((c) => '<option value="' + c.id + '"' + (n.case_id === c.id ? ' selected' : '') + '>' + c.id + ' ' +
          esc(c.name) + '</option>').join('') + '</select>' +
      '<h4>修改范围（可选）</h4><div class="chipset">' + SCOPE_ALL.map((s) =>
        '<button class="chip' + (n.scope.indexOf(s) >= 0 ? ' on' : '') + '" data-nscope="' + esc(s) + '">' + esc(s) +
        '</button>').join('') + '</div>' +
      '<h4>便签内容</h4><textarea id="ncontent" rows="5" placeholder="例如：Then 里的余额验证应该使用 delta，不应该写死 80。同时检查库存是否正确减少。">' +
      esc(n.content) + '</textarea><div class="count" id="ncount">' + n.content.length + '/1000</div>' +
      '<p class="side-note">仅存本浏览器（IndexedDB），不会修改 Case 文件。</p></div>' +
      '<div class="mfoot"><span class="hint"></span><button class="btn" data-act="noteCancel">取消</button>' +
      '<button class="btn pri" data-act="noteSave">保存便签</button></div></div>';
    $('#ncontent').addEventListener('input', (e) => {
      el._note.content = e.target.value.slice(0, 1000);
      $('#ncount').textContent = el._note.content.length + '/1000';
    });
    $('#ncase').addEventListener('change', (e) => {
      const id = e.target.value;
      el._note.case_id = id || null;
      el._note.case_name = id ? BY_ID.get(id).name : '';
    });
  }
  const closeNoteDialog = () => { const el = $('#modal'); el.classList.add('hidden'); el.innerHTML = ''; delete el._note; };

  // ── 卡片 ⋯ 菜单 ──
  function openMenu(id, x, y) {
    const el = $('#menu');
    el.classList.remove('hidden');
    el.style.left = Math.max(8, Math.min(x, window.innerWidth - 200)) + 'px';
    el.style.top = Math.max(8, Math.min(y, window.innerHeight - 200)) + 'px';
    el.innerHTML = '<button data-act="openDrawer" data-id="' + id + '">查看详情</button>' +
      '<button data-act="noteAdd" data-id="' + id + '">加入便签</button>' +
      '<button data-act="composeModify" data-id="' + id + '">让 Agent 修改</button>' +
      '<button data-act="composeVerify" data-id="' + id + '">生成验证指令</button><hr>' +
      '<button data-act="selToggle" data-id="' + id + '">' + (S.sel.has(id) ? '取消选择' : '加入选择') + '</button>';
  }
  const closeMenu = () => $('#menu').classList.add('hidden');

  // ── 统一渲染 ──
  function renderAll() { renderTree(); renderFilterBar(); renderList(); renderSelBar(); renderDrawer(); }
  function applyHash() {
    const h = location.hash.replace(/^#/, '');
    if (h === 'notes') { S.notesOpen = true; renderNotes(); return; }
    if (h === 'list' || h === 'card') { S.view = h; savePrefs(); $$('.seg button').forEach((b) => b.classList.toggle('on', b.dataset.view === h)); renderList(); return; }
    const m = /^case-(CASE-\d{3})$/.exec(h);
    if (m && BY_ID.has(m[1])) { S.open = m[1]; S.tab = 'SPEC'; renderAll(); }
  }
  const toggleSel = (id) => { if (S.sel.has(id)) S.sel.delete(id); else S.sel.add(id); };
  const closeDrawer = () => { S.open = null; renderDrawer(); };
  function step(d) {
    const list = visible();
    if (!list.length || !S.open) return;
    const i = list.findIndex((c) => c.id === S.open);
    S.open = list[(i + d + list.length) % list.length].id;
    renderAll();
  }

  // ── 事件委托 ──
  const ACTS = {
    closeDrawer,
    prev: () => step(-1),
    next: () => step(1),
    panel: () => { S.panel = !S.panel; savePrefs(); renderFilterBar(); },
    clearf: () => { S.f = EMPTY_F(); savePrefs(); renderAll(); },
    clearSel: () => { S.sel.clear(); renderAll(); },
    selAll: () => { visible().forEach((c) => S.sel.add(c.id)); renderAll(); },
    selToggle: (el) => { toggleSel(el.dataset.id); renderAll(); },
    openDrawer: (el) => { S.open = el.dataset.id; S.tab = 'SPEC'; renderAll(); },
    composeModify: (el) => openComposer('modify', S.sel.has(el.dataset.id) ? Array.from(S.sel) : [el.dataset.id]),
    composeVerify: (el) => openComposer('verify', S.sel.has(el.dataset.id) ? Array.from(S.sel) : [el.dataset.id]),
    composeModifySel: () => openComposer('modify', Array.from(S.sel)),
    composeVerifySel: () => openComposer('verify', Array.from(S.sel)),
    notesCompose: () => openComposer('notes', []),
    noteAdd: (el) => noteDialog(null, el.dataset.id),
    noteNewFree: () => noteDialog(null, null),
    noteCancel: closeNoteDialog,
    noteEdit: (el) => { const n = notesCache.find((x) => x.id === el.dataset.nid); if (n) noteDialog(n); },
    noteDel: async (el) => {
      if (confirm('删除这条便签？')) {
        await dbDel('notes', el.dataset.nid);
        S.noteSel.delete(el.dataset.nid);
        await loadNotes();
      }
    },
    noteSave: async () => {
      const n = $('#modal')._note;
      if (!n.content.trim()) { toast('便签内容不能为空'); return; }
      n.status = n.status || 'pending';
      await saveNote(n);
      closeNoteDialog();
      toast('便签已保存');
    },
    notesExport: () => {
      const blob = new Blob([JSON.stringify(notesCache, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'review-notes.json';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(a.href);
      toast('已导出 ' + notesCache.length + ' 条便签');
    },
    notesClear: async () => {
      if (confirm('清空全部便签？（只影响本浏览器，Case 源文件不受影响）')) {
        await dbClear('notes');
        S.noteSel.clear();
        await loadNotes();
        toast('便签已清空');
      }
    },
    notesClose: () => { S.notesOpen = false; renderNotes(); },
    composerClose: closeComposer,
    frozenCancel: () => { closeFrozen(); },
    frozenGo: () => {
      closeFrozen();
      if (!composer) return;
      composer.frozenOk = true;
      composer.dirty = false;
      composer.draft = draftFor();
      renderComposer();
      toast('已按「新版本 → 重新确认」生成初稿');
    },
    genDraft: () => {
      if (!composer) return;
      if (composer.mode === 'modify' && !composer.scopes.length) { toast('请先选择修改范围'); return; }
      const need = composer.mode === 'modify' && !composer.frozenOk &&
        frozenHits(composer.ids).length && composer.scopes.some((s) => SCOPE_FROZEN.indexOf(s) >= 0);
      if (need) {
        frozenConfirm(frozenHits(composer.ids).map((c) => c.id));
        return;
      }
      composer.dirty = false;
      composer.draft = draftFor();
      renderComposer();
      toast('初稿已生成，可继续编辑');
    },
    copyDraft: async () => {
      if (!composer || !composer.draft) return;
      const ok = await copyText(composer.draft);
      if (!ok) { toast('复制失败：请手动选中文本复制'); return; }
      await dbPut('kv', { k: 'last-draft', v: composer.draft });
      if (composer.mode === 'notes') {
        for (const id of Array.from(S.noteSel)) {
          const n = notesCache.find((x) => x.id === id);
          if (n) { n.status = 'generated'; await dbPut('notes', n); }
        }
        await loadNotes();
      }
      toast('已复制到剪贴板');
    },
  };

  document.addEventListener('click', (e) => {
    const t = e.target;
    const hit = (sel) => (t.closest ? t.closest(sel) : null);
    let el;

    if (hit('#scrim')) { closeDrawer(); return; }
    if (!hit('#menu')) closeMenu();

    if ((el = hit('[data-act]'))) {
      const fn = ACTS[el.dataset.act];
      if (fn) { fn(el); return; }
    }
    if ((el = hit('[data-tab]'))) { S.tab = el.dataset.tab; savePrefs(); renderDrawer(); return; }
    if ((el = hit('[data-ntab]'))) { S.notesTab = el.dataset.ntab; savePrefs(); renderNotes(); return; }
    if ((el = hit('[data-fclear]'))) {
      const k = el.dataset.fclear;
      if (k.indexOf(':') > 0) { const p = k.split(':'); S.f[p[0]] = S.f[p[0]].filter((x) => x !== p[1]); }
      else S.f[k] = (k === 'business' || k === 'mtime') ? '' : [];
      savePrefs(); renderAll(); return;
    }
    if ((el = hit('[data-mf]'))) {
      const p = el.dataset.mf.split(':'), k = p[0], v = p[1];
      const i = S.f[k].indexOf(v);
      if (i >= 0) S.f[k].splice(i, 1); else S.f[k].push(v);
      savePrefs(); renderAll(); return;
    }
    if ((el = hit('[data-sf]'))) {
      const p = el.dataset.sf.split(':');
      S.f[p[0]] = p[1];
      savePrefs(); renderAll(); return;
    }
    if ((el = hit('[data-biz]'))) {
      S.f.business = S.f.business === el.dataset.biz ? '' : el.dataset.biz;
      savePrefs(); renderAll(); return;
    }
    if ((el = hit('[data-all]'))) { S.f.business = ''; S.f.tags = []; savePrefs(); renderAll(); return; }
    if ((el = hit('[data-reset]'))) { S.f = EMPTY_F(); S.q = ''; $('#q').value = ''; savePrefs(); renderAll(); return; }
    if ((el = hit('[data-tag]'))) {
      const tg = el.dataset.tag, i = S.f.tags.indexOf(tg);
      if (i >= 0) S.f.tags.splice(i, 1); else S.f.tags.push(tg);
      savePrefs(); renderAll(); return;
    }
    if ((el = hit('[data-jump]'))) { S.panel = true; savePrefs(); renderFilterBar(); return; }
    if ((el = hit('[data-menu]'))) {
      const r = el.getBoundingClientRect();
      openMenu(el.dataset.menu, r.right - 190, r.bottom + 4);
      return;
    }
    if ((el = hit('[data-mscope]'))) {
      const s = el.dataset.mscope, i = composer.scopes.indexOf(s);
      if (i >= 0) composer.scopes.splice(i, 1); else composer.scopes.push(s);
      renderComposer(); return;
    }
    if ((el = hit('[data-vscope]'))) {
      const s = el.dataset.vscope, i = composer.v.scope.indexOf(s);
      if (i >= 0) composer.v.scope.splice(i, 1); else composer.v.scope.push(s);
      if (!composer.dirty) { composer.draft = draftFor(); renderComposer(); }
      else { el.classList.toggle('on'); }
      return;
    }
    if ((el = hit('[data-vopt]'))) {
      composer.v[el.dataset.vopt] = el.checked;
      if (!composer.dirty) { composer.draft = draftFor(); renderComposer(); }
      return;
    }
    if ((el = hit('[data-nscope]'))) {
      const s = el.dataset.nscope, n = $('#modal')._note;
      const i = n.scope.indexOf(s);
      if (i >= 0) n.scope.splice(i, 1); else n.scope.push(s);
      el.classList.toggle('on'); return;
    }
    if ((el = hit('[data-nsel]'))) {
      const id = el.dataset.nsel;
      if (S.noteSel.has(id)) S.noteSel.delete(id); else S.noteSel.add(id);
      renderNotes(); return;
    }
    if ((el = hit('[data-sel]'))) { toggleSel(el.dataset.sel); renderAll(); return; }
    if ((el = hit('[data-card]'))) {
      S.open = el.dataset.card;
      S.tab = 'SPEC';
      renderAll();
      return;
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!$('#modal2').classList.contains('hidden')) return closeFrozen();
      if (composer) return closeComposer();
      if ($('#modal')._note) return closeNoteDialog();
      if (!$('#menu').classList.contains('hidden')) return closeMenu();
      if (S.notesOpen) { S.notesOpen = false; return renderNotes(); }
      if (S.open) return closeDrawer();
      return;
    }
    if (e.key === '/' && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) {
      e.preventDefault();
      $('#q').focus();
    }
  });

  // ── 启动 ──
  (function boot() {
    const st = document.createElement('style');
    st.textContent = CSS;
    document.head.appendChild(st);
    initShell();
    loadPrefs();
    $('#q').value = S.q;
    $('#sort').value = S.sort;
    $$('.seg button').forEach((b) => {
      b.classList.toggle('on', b.dataset.view === S.view);
      b.addEventListener('click', () => {
        S.view = b.dataset.view;
        savePrefs();
        $$('.seg button').forEach((x) => x.classList.toggle('on', x === b));
        renderList();
      });
    });
    $('#q').addEventListener('input', (e) => { S.q = e.target.value; savePrefs(); renderList(); renderSelBar(); });
    $('#sort').addEventListener('change', (e) => { S.sort = e.target.value; savePrefs(); renderList(); });
    $('#notesBtn').addEventListener('click', () => { S.notesOpen = !S.notesOpen; renderNotes(); });
    renderAll();
    openDB().then((db) => {
      if (!db) $('#storageNote').textContent += '（本环境不支持 IndexedDB：便签只保存在本次会话内存中）';
      return loadNotes();
    });
    applyHash();
  })();
})();
