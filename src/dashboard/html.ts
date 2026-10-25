import { html, raw } from 'hono/html';
import type { Consensus, Entry, EntryStatus, EntryType, Person } from '../domain/types';

// Brand palette (docs/brand): ink navy #14213D, ivory #F4F1EA, coral #FF6B4A.
const DARK = `color-scheme:dark;
--rail-hi:rgba(244,241,234,.08);
--bg:#0b1324;--card:#121d33;--soft:#1a2742;--line:#24324f;--tx:#f4f1ea;--mut:#a3acbf;
--btn:#f4f1ea;--btn-tx:#14213d;--btn-hi:#fff;
--hot-ink:#ff8a70;--hot-soft:#3a2026;
--ok:#5cc489;--warn:#f0b44c;--bad:#ff8a7a;--info:#8fb0ff;--off:#9aa3b2;
--t-decision:#8fb0ff;--t-principle:#4fd1c5;--t-view:#b89cff;--t-exploration:#f0b44c;--t-proposal:#ff8a70;--t-workstream:#5cc489;--t-update:#a3acbf;
--shadow:none;--card-line:var(--line);--hot-bg:var(--hot-soft);--hot-line:var(--coral);--hot-sub:var(--mut)`;
const CHEVRON = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%238a93a6' stroke-width='2.2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E")`;
// Inter (variable, OFL) is served from public/fonts by the Worker's static assets.
const CSS = `
@font-face{font-family:Inter;font-style:normal;font-weight:100 900;font-display:swap;src:url(/fonts/inter-latin.woff2) format("woff2");
unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD}
@font-face{font-family:Inter;font-style:normal;font-weight:100 900;font-display:swap;src:url(/fonts/inter-latin-ext.woff2) format("woff2");
unicode-range:U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF}
:root{color-scheme:light;
--navy:#14213d;--ivory:#f4f1ea;--coral:#ff6b4a;
--rail:#14213d;--rail-tx:#f4f1ea;--rail-mut:#a9b1c4;--rail-hi:rgba(244,241,234,.1);
--bg:#f4f1ea;--card:#fff;--soft:#ece8df;--line:#e2ddd2;--tx:#14213d;--mut:#5a6478;
--btn:#14213d;--btn-tx:#f4f1ea;--btn-hi:#24365f;
--hot-ink:#b8391e;--hot-soft:#ffe8e1;
--ok:#276b43;--warn:#9a5b00;--bad:#c0362c;--info:#2f5bd3;--off:#5f6672;
--t-decision:#2f5bd3;--t-principle:#0f7f81;--t-view:#7c4dcc;--t-exploration:#9a5b00;--t-proposal:#c8432a;--t-workstream:#2f7d4f;--t-update:#5a6478;
--shadow:0 1px 2px rgba(20,33,61,.06),0 4px 14px rgba(20,33,61,.05);
--card-line:transparent;--hot-bg:var(--navy);--hot-line:var(--navy);--hot-sub:#c9cfdc;--maxw:1600px;
--sans:Inter,"Segoe UI Variable Text","Segoe UI",system-ui,-apple-system,Roboto,"Helvetica Neue",sans-serif}
/* Dark: chosen in the dashboard, or the OS setting when nothing is chosen. */
:root[data-theme="dark"]{${DARK}}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){${DARK}}}
*{box-sizing:border-box}
html{scrollbar-color:var(--line) transparent}
body{margin:0;background:var(--bg);color:var(--tx);font:15px/1.55 var(--sans);caret-color:var(--coral);accent-color:var(--navy);-webkit-font-smoothing:antialiased}
::selection{background:var(--hot-soft);color:var(--tx)}
a{color:inherit;text-decoration:none}
a:hover{text-decoration:underline;text-decoration-color:color-mix(in srgb,currentColor 40%,transparent);text-underline-offset:3px}
:focus-visible{outline:2px solid var(--hot-ink);outline-offset:2px;border-radius:6px}
.rail :focus-visible{outline-color:var(--coral)}
h1,h2,h3,h4{margin:0;font-weight:650;letter-spacing:-.015em;text-wrap:balance}
p{margin:0}
time,.num{font-variant-numeric:tabular-nums}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.mut{color:var(--mut)}
.pre{white-space:pre-wrap}
svg.i{width:18px;height:18px;flex:none;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}

/* Shell */
.app{display:grid;grid-template-columns:240px minmax(0,1fr);min-height:100vh}
.rail{background:var(--rail);color:var(--rail-tx);position:sticky;top:0;height:100vh;display:flex;flex-direction:column;gap:4px;padding:20px 14px 14px}
.brand{display:flex;align-items:center;gap:10px;padding:2px 10px 22px;font-weight:600;font-size:18px;letter-spacing:-.02em}
.brand svg{width:28px;height:28px;flex:none}
.brand:hover{text-decoration:none}
.rail nav{display:flex;flex-direction:column;gap:2px}
.rail nav a{display:flex;align-items:center;gap:11px;padding:9px 10px;border-radius:10px;color:var(--rail-mut);font-weight:500;transition:background .15s,color .15s}
.rail nav a:hover{background:var(--rail-hi);color:var(--rail-tx);text-decoration:none}
.rail nav a.on{background:var(--rail-hi);color:var(--rail-tx);font-weight:600}
.rail nav a.on svg{color:var(--coral)}
.count{margin-left:auto;min-width:22px;padding:0 7px;border-radius:999px;background:var(--coral);color:var(--navy);font:700 12px/20px var(--sans);text-align:center}
.foot{margin-top:auto}
.theme{display:flex;gap:2px;padding:3px;margin:0 0 10px;border-radius:10px;background:rgba(244,241,234,.06)}
.theme form{display:contents}
.theme button{all:unset;box-sizing:border-box;flex:1;display:grid;place-items:center;height:30px;border-radius:8px;color:var(--rail-mut);cursor:pointer;transition:background .15s,color .15s}
.theme button:hover{color:var(--rail-tx)}
.theme button[aria-pressed="true"]{background:var(--rail-hi);color:var(--rail-tx)}
.theme button[aria-pressed="true"] svg{color:var(--coral)}
.theme button:focus-visible{outline:2px solid var(--coral)}
.theme svg{width:16px;height:16px}
.me{display:flex;align-items:center;gap:10px;padding:12px 10px 4px;border-top:1px solid rgba(244,241,234,.1)}
.me .who{min-width:0;flex:1;font-weight:600;font-size:14px;line-height:1.3;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.me form{margin:0}
.me button{all:unset;cursor:pointer;display:grid;place-items:center;width:32px;height:32px;border-radius:8px;color:var(--rail-mut)}
.me button:hover{background:var(--rail-hi);color:var(--rail-tx)}
.top{position:sticky;top:0;z-index:5;background:var(--bg);border-bottom:1px solid var(--line);padding:12px 40px}
.top-in{max-width:calc(var(--maxw) - 80px);margin:0 auto}
main{min-width:0}
.page{padding:30px 40px 72px;max-width:var(--maxw);margin:0 auto;overflow-wrap:anywhere}

/* Search group: icon, words, optional area, button, as one control */
.sgroup{display:flex;align-items:center;flex:1;max-width:760px;min-height:44px;background:var(--card);border:1px solid var(--line);border-radius:12px;transition:border-color .15s,box-shadow .15s}
.sgroup:hover{border-color:color-mix(in srgb,var(--mut) 45%,var(--line))}
.sgroup:focus-within{border-color:var(--hot-ink);box-shadow:0 0 0 3px color-mix(in srgb,var(--hot-ink) 20%,transparent)}
.sgroup>svg{margin-left:14px;color:var(--mut)}
.sgroup input{flex:1;min-width:0;border:0;background:transparent;min-height:42px;padding:8px 12px}
.sgroup input:focus,.sgroup select:focus{outline:none;box-shadow:none}
.sgroup select{flex:none;max-width:200px;border:0;border-left:1px solid var(--line);border-radius:0;background-color:transparent;min-height:26px;padding:2px 36px 2px 14px;color:var(--mut);font-weight:500;box-shadow:none}
.sgroup select:open{color:var(--tx)}
.sgroup select:hover{color:var(--tx)}
.sgroup button{flex:none;margin:4px;min-height:34px;padding:6px 14px;border-radius:9px}

/* Avatars: one colour per person, stable across pages */
.av{flex:none;display:inline-grid;place-items:center;width:32px;height:32px;border-radius:50%;color:#fff;font:700 12px/1 var(--sans);letter-spacing:.02em;background:var(--c,#5a6478)}
.av.sm{width:22px;height:22px;font-size:9.5px}
.av.lg{width:44px;height:44px;font-size:15px}
.avs{display:inline-flex}.avs .av{box-shadow:0 0 0 2px var(--card)}.avs .av+.av{margin-left:-3px}
.hero .avs .av{box-shadow:0 0 0 2px var(--bg)}
.c0{--c:#2f5bd3}.c1{--c:#c8432a}.c2{--c:#0f7f81}.c3{--c:#7c4dcc}.c4{--c:#2f7d4f}.c5{--c:#a8336a}

/* Entry type: icon tile in the type's colour */
.tic{flex:none;display:inline-grid;place-items:center;width:34px;height:34px;border-radius:10px;color:var(--tc);background:color-mix(in srgb,var(--tc) 13%,transparent)}
.tic svg{width:17px;height:17px}
.t-decision{--tc:var(--t-decision)}.t-principle{--tc:var(--t-principle)}.t-view{--tc:var(--t-view)}.t-exploration{--tc:var(--t-exploration)}
.t-proposal{--tc:var(--t-proposal)}.t-workstream{--tc:var(--t-workstream)}.t-update{--tc:var(--t-update)}
.t-blocked{--tc:var(--bad)}.t-new{--tc:var(--info)}
.type{font-weight:600;color:var(--tc)}

/* Chips */
.st{display:inline-flex;align-items:center;gap:6px;padding:2px 9px 2px 8px;border-radius:999px;font:600 12px/18px var(--sans);white-space:nowrap;color:var(--sc);background:color-mix(in srgb,var(--sc) 12%,transparent)}
.st::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor}
.ok{--sc:var(--ok)}.warn{--sc:var(--warn)}.bad{--sc:var(--bad)}.info{--sc:var(--info)}.off{--sc:var(--off)}
.area{display:inline-block;padding:1px 8px;border-radius:6px;background:var(--soft);color:var(--mut);font:500 12px/18px var(--sans)}
.tags{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.meta{display:flex;flex-wrap:wrap;align-items:center;gap:4px 8px;font-size:13px;color:var(--mut)}

/* Page heads and sections */
.head{display:flex;flex-wrap:wrap;align-items:flex-end;justify-content:space-between;gap:16px;margin-bottom:24px}
.head h1{font-size:28px;line-height:1.2}
.head .sub{margin-top:4px;color:var(--mut)}
.sec{margin-top:36px}
.sh{display:flex;align-items:center;gap:10px;margin-bottom:14px;font-size:17px}
.sh .n{display:inline-grid;place-items:center;min-width:24px;height:22px;padding:0 7px;border-radius:999px;background:var(--soft);color:var(--mut);font:600 12.5px var(--sans)}
.sh.hot .n{background:var(--coral);color:var(--navy)}
.card{background:var(--card);border:1px solid var(--card-line);border-radius:14px;box-shadow:var(--shadow)}
.empty{display:flex;align-items:center;gap:12px;padding:16px 20px;border:1px dashed var(--line);border-radius:14px;color:var(--mut)}
.empty svg{color:var(--ok)}
.split{display:grid;grid-template-columns:minmax(0,1fr) 340px;gap:32px;align-items:start}
.split>aside{display:flex;flex-direction:column;gap:20px}
.panel{padding:18px 20px}
.panel>h2{display:flex;align-items:center;gap:8px;font-size:15px;margin-bottom:6px}

/* Focus tiles: where to look first */
.focus{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px;margin-bottom:8px}
.tile{display:flex;flex-direction:column;gap:10px;padding:16px 18px;min-height:136px}
.tile:hover{text-decoration:none;border-color:color-mix(in srgb,var(--tx) 25%,var(--line))}
.tile .row{display:flex;align-items:center;justify-content:space-between}
.tile b{font-size:30px;line-height:1;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.tile .l{font-weight:600}
.tile small{color:var(--mut);font-size:13px;line-height:1.4;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.tile.hot{background:var(--hot-bg);border-color:var(--hot-line);color:var(--ivory)}
.tile.hot .tic{--tc:var(--coral);background:rgba(255,107,74,.18)}
.tile.hot small{color:var(--hot-sub)}
.tile.hot b{color:var(--coral)}

/* Feed */
.feed{list-style:none;margin:0;padding:4px 0}
.day{padding:14px 20px 4px;font:600 13px var(--sans);color:var(--mut)}
.day::first-letter{text-transform:uppercase}
.item{display:flex;align-items:flex-start;gap:14px;padding:11px 20px}
.day+.item{padding-top:6px}
.item+.item{border-top:1px solid var(--line)}
.item .body{flex:1;min-width:0}
.item .title{font-weight:600}
.item .meta{margin-top:3px}
.kind{flex:none;margin-top:2px;font:600 12px/18px var(--sans);padding:1px 8px;border-radius:6px;color:var(--info);background:color-mix(in srgb,var(--info) 12%,transparent)}
.kind.removed{color:var(--off);background:color-mix(in srgb,var(--off) 12%,transparent)}
.list{list-style:none;margin:0;padding:0}
.list>li{display:flex;align-items:flex-start;gap:12px;padding:10px 0}
.list>li+li{border-top:1px solid var(--line)}
.list .body{flex:1;min-width:0}
.list .title{font-weight:600;font-size:14.5px}
.list .tags{margin-top:5px}

/* Division tally: one tick per person, grouped by position */
.tally{display:inline-flex;align-items:center;gap:6px}
.tally .g{display:inline-flex;flex-direction:column;gap:2px}
.tally i{width:18px;height:3px;border-radius:2px;background:color-mix(in srgb,var(--off) 55%,transparent)}
.tally .win i{background:var(--ok)}
.score{font:600 12px var(--sans);color:var(--mut);font-variant-numeric:tabular-nums}
.sh .tally{gap:8px}.sh .tally .g{gap:4px}.sh .tally i{width:34px;height:6px;border-radius:3px}.sh .score{font-size:14px;color:var(--tx)}
.sides{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:14px}
.side{padding:16px 18px}
.side>header{display:flex;align-items:baseline;justify-content:space-between;gap:10px;padding-bottom:10px;margin-bottom:6px;border-bottom:3px solid color-mix(in srgb,var(--off) 45%,transparent)}
.side.win>header{border-color:var(--ok)}
.side h3{font-size:16px}
.side ul{list-style:none;margin:0;padding:0}
.side li{display:flex;gap:10px;padding:10px 0}
.side li+li{border-top:1px solid var(--line)}
.side li p{font-size:14px;color:var(--mut)}

/* Motions: a proposal awaiting a verdict */
.motion{overflow:hidden}
.motion+.motion{margin-top:14px}
.motion>header{display:flex;align-items:flex-start;gap:14px;padding:18px 20px 0}
.motion h3{font-size:17px;line-height:1.35}
.motion .revises{margin-top:4px;font-size:13.5px;color:var(--mut)}
.motion .revises a{color:var(--tx);font-weight:500}
.motion .meta{margin-top:6px}
.compare{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:16px 20px 0}
.compare>div{padding:12px 14px;border-radius:10px;background:var(--soft)}
.compare>div.new{background:var(--hot-soft)}
.compare h4{margin-bottom:4px;font:600 13px var(--sans);color:var(--mut)}
.compare .new h4{color:var(--hot-ink)}
.compare p{font-size:14.5px}
.why{margin:12px 20px 0;font-size:14px}
.why b{font-weight:650}
.motion footer{display:flex;flex-wrap:wrap;align-items:flex-start;gap:10px;padding:14px 20px 18px;margin-top:14px;border-top:1px solid var(--line)}
.motion footer form{margin:0}
.waiting{display:flex;align-items:center;gap:8px;color:var(--mut);font-size:14px}
.reject summary{list-style:none}
.reject summary::-webkit-details-marker{display:none}
.reject[open] summary{display:none}
.reject form{display:flex;gap:8px;flex-wrap:wrap}
.reject input{width:min(320px,70vw)}

/* Controls */
input,select,button,.btn{font:inherit;font-size:14px;color:var(--tx)}
input,select{background-color:var(--card);border:1px solid var(--line);border-radius:10px;padding:8px 12px;min-height:40px;transition:border-color .15s,box-shadow .15s,color .15s}
input::placeholder{color:var(--mut)}
input:hover,select:hover{border-color:color-mix(in srgb,var(--mut) 45%,var(--line))}
input:focus,select:focus{outline:none;border-color:var(--hot-ink);box-shadow:0 0 0 3px color-mix(in srgb,var(--hot-ink) 20%,transparent)}
select{appearance:none;-webkit-appearance:none;padding-right:38px;cursor:pointer;background-image:${CHEVRON};background-repeat:no-repeat;background-position:right 12px center;background-size:16px}
select option{background:var(--card);color:var(--tx)}
/* Customizable select (Chromium): the open list is ours, not the OS's. Elsewhere the native list stays. */
@supports (appearance:base-select){
select,::picker(select){appearance:base-select}
select,.sgroup select{display:inline-flex;align-items:center;gap:8px;background-image:none;padding-right:12px}
select::picker-icon{content:"";width:16px;height:16px;background:${CHEVRON} center/16px no-repeat;transition:rotate .2s}
select:open::picker-icon{rotate:180deg}
::picker(select){margin-top:6px;padding:6px;min-width:anchor-size(width);border:1px solid var(--line);border-radius:12px;background:var(--card);color:var(--tx);
box-shadow:0 12px 32px rgba(11,19,36,.18),0 2px 6px rgba(11,19,36,.08);opacity:0;translate:0 -4px;
transition:opacity .15s,translate .15s,display .15s allow-discrete,overlay .15s allow-discrete}
::picker(select):popover-open{opacity:1;translate:0 0}
@starting-style{::picker(select):popover-open{opacity:0;translate:0 -4px}}
select option{display:flex;align-items:center;gap:10px;padding:8px 12px;border-radius:8px;background:transparent;font-size:14px;font-weight:500;cursor:pointer}
select option:hover,select option:focus-visible{background:var(--soft);outline:none}
select option:checked{background:var(--hot-soft);color:var(--tx);font-weight:600}
select option::checkmark{content:"";order:1;margin-left:auto;width:8px;height:8px;border-radius:50%;background:var(--coral)}
select option:not(:checked)::checkmark{visibility:hidden}
}
button,.btn{display:inline-flex;align-items:center;gap:7px;min-height:40px;padding:8px 15px;border-radius:10px;border:1px solid var(--line);background:var(--card);font-weight:600;cursor:pointer;transition:background .15s,border-color .15s}
button:hover,.btn:hover{border-color:color-mix(in srgb,var(--mut) 55%,var(--line));background:var(--soft);text-decoration:none}
button:active,.btn:active{transform:translateY(1px)}
button.go{background:var(--btn);border-color:var(--btn);color:var(--btn-tx)}
button.go:hover{background:var(--btn-hi);border-color:var(--btn-hi)}
button.hot{background:var(--coral);border-color:var(--coral);color:var(--navy)}
button.hot:hover{background:#ff8466;border-color:#ff8466}
button svg,.btn svg{width:16px;height:16px}

/* Tabs and filters */
.tabs{display:flex;gap:4px;padding:4px;border-radius:12px;background:var(--soft);width:max-content;max-width:100%;overflow-x:auto}
.tabs a{display:flex;align-items:center;gap:8px;padding:7px 14px;border-radius:9px;color:var(--mut);font-weight:600;font-size:14px;white-space:nowrap}
.tabs a:hover{color:var(--tx);text-decoration:none}
.tabs a.on{background:var(--card);color:var(--tx);box-shadow:var(--shadow)}
.tabs .n{font-weight:600;color:var(--mut);font-size:12.5px}
.filters{display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin-bottom:20px}
.filters .sgroup{min-width:260px}

/* Who thinks what */
.two{display:grid;grid-template-columns:240px minmax(0,1fr);gap:28px;align-items:start}
.areas{position:sticky;top:84px;padding:8px}
.areas a{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 10px;border-radius:8px;font-size:14px;font-weight:500;text-transform:capitalize}
.areas a:hover{background:var(--soft);text-decoration:none}
.areas a.on{background:var(--btn);color:var(--btn-tx)}
.areas a.on .n{color:inherit;opacity:.75}
.areas .n{font-size:12.5px;color:var(--mut);font-variant-numeric:tabular-nums}
.area-h{text-transform:capitalize;font-size:24px}
.current{display:flex;gap:14px;align-items:flex-start;padding:16px 18px;margin:16px 0 20px}
.current h3{font:600 13px var(--sans);color:var(--mut);margin-bottom:2px}
.current a{font-weight:600}
.people{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:14px}
.col{padding:16px 18px}
.col>header{display:flex;align-items:center;gap:10px;margin-bottom:10px;font-weight:600}
.col.none{background:transparent;box-shadow:none;border:1px dashed var(--line)}
.view+.view{margin-top:14px;padding-top:14px;border-top:1px solid var(--line)}
.view a{font-weight:600}
.view p{margin-top:4px;font-size:14px}
.view .meta{margin-top:2px}

/* Team */
.crew{display:grid;grid-template-columns:repeat(auto-fill,minmax(290px,1fr));gap:14px}
.person{padding:18px 20px}
.person>header{display:flex;align-items:center;gap:12px;margin-bottom:12px}
.person h3{font-size:16px}
.line{display:grid;grid-template-columns:96px minmax(0,1fr);gap:10px;padding:5px 0;font-size:14px}
.line b{font:600 12.5px/1.65 var(--sans);color:var(--mut)}
.line.alert b{color:var(--bad)}
.line a{font-weight:500}
.stats{display:flex;gap:6px;flex-wrap:wrap;margin-top:12px;padding-top:12px;border-top:1px solid var(--line)}
.board{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;align-items:start}
.lane{padding:12px;border-radius:14px;background:var(--soft)}
.lane>h3{display:flex;align-items:center;gap:8px;padding:4px 6px 10px;font-size:14px}
.lane>h3 .n{margin-left:auto;font-weight:600;color:var(--mut);font-size:12.5px}
.ws{display:block;padding:12px 14px;border-radius:10px;background:var(--card);border:1px solid var(--line)}
.ws+.ws,.lane details{margin-top:8px}
.ws:hover{text-decoration:none;border-color:color-mix(in srgb,var(--tx) 25%,var(--line))}
.ws .title{display:block;font-weight:600;font-size:14.5px}
.ws .meta{margin-top:8px;justify-content:space-between}
.lane .empty{padding:12px;font-size:13.5px}
details>summary{cursor:pointer;color:var(--mut);font-size:13.5px;padding:6px}

/* Entry pages */
.hero{display:flex;gap:16px;align-items:flex-start;margin-bottom:26px}
.hero .tic{width:48px;height:48px;border-radius:14px}
.hero .tic svg{width:22px;height:22px}
.hero h1{font-size:28px;line-height:1.2}
.hero .tags{margin-top:10px}
.lead{font-size:16.5px;line-height:1.6;max-width:70ch}
.verdict{padding:20px 22px;border-top:4px solid var(--coral)}
.verdict p{font-size:17px;line-height:1.6;max-width:70ch}
.verdict .note{margin-top:12px;font-size:14px;color:var(--mut)}
.qa{padding:16px 20px}
.dl{display:grid;grid-template-columns:92px minmax(0,1fr);gap:12px;margin:0;font-size:14px}
.dl dt{color:var(--mut);font-weight:600;font-size:13px;padding-top:1px}
.dl dd{margin:0;display:flex;flex-wrap:wrap;align-items:center;gap:6px}
.who-list{display:flex;flex-direction:column;gap:8px}
.who-list span{display:flex;align-items:center;gap:8px}
.timeline{list-style:none;margin:0;padding:0 0 0 6px}
.timeline li{position:relative;padding:0 0 18px 26px}
.timeline li::before{content:"";position:absolute;left:0;top:6px;width:10px;height:10px;border-radius:50%;background:var(--card);border:2px solid var(--off)}
.timeline li::after{content:"";position:absolute;left:5px;top:20px;bottom:0;width:2px;background:var(--line)}
.timeline li:last-child{padding-bottom:0}
.timeline li:last-child::after{display:none}
.timeline li.here::before{background:var(--coral);border-color:var(--coral)}
.timeline .label{font:600 13px var(--sans);color:var(--mut)}
.timeline .title{font-weight:600}
.timeline p{margin-top:4px;font-size:14px}
.manage{padding:18px 20px;position:sticky;top:84px}
.manage form{margin:0}
.manage form+form{margin-top:16px;padding-top:16px;border-top:1px solid var(--line)}
.manage label{display:block;font:600 12.5px var(--sans);color:var(--mut);margin-bottom:6px}
.manage .row{display:flex;gap:8px}
.manage input,.manage select{flex:1;min-width:0}

/* Bare message page */
.bare{min-height:100vh;display:grid;place-items:center;padding:24px}
.bare>div{max-width:440px;padding:30px 32px}
.bare .brand{padding:0;color:var(--tx)}
.bare p{margin-top:14px}

@media (max-width:1180px){.split{grid-template-columns:minmax(0,1fr)}.focus{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media (max-width:900px){.two{grid-template-columns:minmax(0,1fr)}.areas{position:static;display:flex;gap:4px;overflow-x:auto}.areas a{white-space:nowrap}.board{grid-template-columns:minmax(0,1fr)}}
@media (max-width:760px){
.app{grid-template-columns:minmax(0,1fr);align-content:start}
.rail{position:static;height:auto;flex-direction:row;flex-wrap:wrap;align-items:center;gap:6px;padding:10px 16px}
.brand{padding:0 8px 0 0;font-size:17px}
.rail nav{order:3;display:grid;grid-template-columns:repeat(4,minmax(0,1fr));width:100%}
.rail nav a{position:relative;flex-direction:column;gap:3px;padding:7px 2px;font-size:11.5px;line-height:1.2;text-align:center}
.rail nav .count{position:absolute;top:2px;left:calc(50% + 6px);margin:0;min-width:18px;padding:0 5px;font-size:10.5px;line-height:16px}
.foot{order:2;margin:0 0 0 auto;display:flex;align-items:center;gap:8px}.theme{margin:0}.theme button{width:30px;flex:none}
.me{padding:0;border:0}.me .who{display:none}
.sgroup select{max-width:116px;padding-left:10px}
.top{position:static;padding:10px 16px}
.page{padding:20px 16px 56px}
.head h1,.hero h1{font-size:23px}
.focus{gap:10px}.tile{min-height:0;padding:14px}.tile b{font-size:24px}
.item{padding:11px 14px;gap:12px}.day{padding:12px 14px 4px}
.compare{grid-template-columns:minmax(0,1fr)}
.line{grid-template-columns:minmax(0,1fr);gap:0}
.hero .tic{display:none}
}
@media (max-width:420px){.top .sgroup select{display:none}}
`;

// Lucide-style icons (24px grid, 2px stroke), inlined so pages need no requests.
const ICONS = {
  home: '<path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M9 22V12h6v10"/>',
  proposal: '<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7"/><path d="M6 9v12"/>',
  views: '<path d="M14 9a2 2 0 0 1-2 2H6l-4 4V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2z"/><path d="M18 9h2a2 2 0 0 1 2 2v11l-4-4h-6a2 2 0 0 1-2-2v-1"/>',
  team: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  decision: '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
  principle: '<path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z"/>',
  view: '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22z"/>',
  exploration: '<path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/>',
  workstream: '<path d="m12 2 10 5-10 5L2 7z"/><path d="m2 17 10 5 10-5"/><path d="m2 12 10 5 10-5"/>',
  update: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
  moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
  monitor: '<rect width="20" height="14" x="2" y="3" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/>',
} as const;
export type Icon = keyof typeof ICONS;
export const icon = (name: Icon) => raw(`<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`);
export const typeTile = (t: EntryType) => html`<span class="tic t-${t}">${icon(t)}</span>`;

// The S symbol from docs/brand/symbol*.svg; `stroke` is the strips' colour.
const SYMBOL = (stroke: string) => raw(`<svg viewBox="0 0 96 96" fill="none" stroke-width="12" aria-hidden="true"><g stroke="${stroke}">
<path d="M84 12H30A18 18 0 0 0 12 30M84 66A18 18 0 0 1 66 84H12"/><circle cx="84" cy="12" r="6" fill="${stroke}" stroke="none"/>
<circle cx="12" cy="84" r="6" fill="${stroke}" stroke="none"/><path d="M30 30H84M12 66H66" stroke-linecap="round"/></g>
<path d="M12 30A18 18 0 0 0 30 48H66A18 18 0 0 1 84 66" stroke="#FF6B4A"/></svg>`);
// docs/brand/app-icon.svg as the favicon.
const FAVICON = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96" fill="none"><rect width="96" height="96" rx="22" fill="#14213D"/><g transform="translate(19.2 19.2) scale(.6)" stroke-width="12"><g stroke="#F4F1EA"><path d="M84 12H30A18 18 0 0 0 12 30M84 66A18 18 0 0 1 66 84H12"/><circle cx="84" cy="12" r="6" fill="#F4F1EA" stroke="none"/><circle cx="12" cy="84" r="6" fill="#F4F1EA" stroke="none"/><path d="M30 30H84M12 66H66" stroke-linecap="round"/></g><path d="M12 30A18 18 0 0 0 30 48H66A18 18 0 0 1 84 66" stroke="#FF6B4A"/></g></svg>')}`;

const NAV = [['home', '/dashboard', 'Home', 'home'], ['proposals', '/dashboard/proposals', 'Proposals', 'proposal'],
  ['views', '/dashboard/views', 'Who thinks what', 'views'], ['team', '/dashboard/team', 'Team', 'team']] as const;

const head = (title: string, theme: Theme = 'system') => html`<!doctype html>
<html lang="en"${theme === 'system' ? '' : raw(` data-theme="${theme}"`)}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title><link rel="icon" href="${raw(FAVICON)}">
<link rel="preload" href="/fonts/inter-latin.woff2" as="font" type="font/woff2" crossorigin><style>${raw(CSS)}</style></head>`;

export const initials = (name: string) => {
  const w = name.trim().split(/\s+/);
  return ((w[0]?.[0] ?? '') + (w.length > 1 ? w[w.length - 1]![0] : '')).toUpperCase();
};
const hue = (id: string) => [...id].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7) % 6;
export const avatar = (p: Person, size: '' | 'sm' | 'lg' = '') =>
  html`<span class="av c${hue(p.id)} ${size}" title="${p.name}" aria-hidden="true">${initials(p.name)}</span>`;
// Avatar for an id that may not be a current person.
export const avatarOf = (people: Person[], id: string, size: '' | 'sm' | 'lg' = 'sm') =>
  avatar(people.find((p) => p.id === id) ?? { id, name: id, isSystem: false, lastSeenAt: null, dashboardSeenAt: null }, size);
export const avatars = (people: Person[], ids: string[]) => html`<span class="avs">${ids.map((id) => avatarOf(people, id))}</span>`;

export const THEMES = ['light', 'dark', 'system'] as const;
export type Theme = (typeof THEMES)[number];
// Who is looking, plus what the nav needs on every page. `path` is where the theme switch returns to.
export type Viewer = { person: Person; people: Person[]; openProposals: number; theme?: Theme; path?: string };
export type Search = { q: string; area: string; areas: string[] };
const THEME_LABEL: Record<Theme, string> = { light: 'Light theme', dark: 'Dark theme', system: 'Match system theme' };

export const layout = (o: { title: string; active: 'home' | 'proposals' | 'views' | 'team' | null; viewer: Viewer; body: unknown; search?: Search }) =>
  html`${head(`${o.title} · SamePage`, o.viewer.theme)}
<body><div class="app">
<header class="rail"><a class="brand" href="/dashboard">${SYMBOL('#F4F1EA')}SamePage</a>
<nav aria-label="Dashboard">${NAV.map(([key, href, label, ic]) => html`<a href="${href}"${key === o.active ? raw(' class="on" aria-current="page"') : ''}>${icon(ic)}${label}${
  key === 'proposals' && o.viewer.openProposals ? html` <span class="count">${o.viewer.openProposals}<span class="sr"> awaiting your verdict</span></span>` : ''}</a>`)}</nav>
<div class="foot"><div class="theme" role="group" aria-label="Theme"><form method="post" action="/dashboard/theme"><input type="hidden" name="back" value="${o.viewer.path ?? '/dashboard'}">
${THEMES.map((t) => html`<button name="theme" value="${t}" title="${THEME_LABEL[t]}" aria-pressed="${String((o.viewer.theme ?? 'system') === t)}">${
  icon(t === 'light' ? 'sun' : t === 'dark' ? 'moon' : 'monitor')}<span class="sr">${THEME_LABEL[t]}</span></button>`)}</form></div>
<div class="me">${avatar(o.viewer.person)}<span class="who">${o.viewer.person.name}</span>
<form method="post" action="/dashboard/logout"><button title="Sign out">${icon('logout')}<span class="sr">Sign out</span></button></form></div></div></header>
<main><div class="top"><div class="top-in"><form class="sgroup" action="/dashboard" method="get" role="search">${icon('search')}
<input name="q" value="${o.search?.q ?? ''}" aria-label="Search" placeholder="Search decisions, views, principles…">
${o.search ? html`<select name="area" aria-label="Area"><option value="">All areas</option>
${o.search.areas.map((a) => html`<option value="${a}" ${a === o.search!.area ? 'selected' : ''}>${a}</option>`)}</select>` : ''}
<button class="go">Search</button></form></div></div>
<div class="page">${o.body}</div></main>
</div></body></html>`;

// Bare page for errors: it must work without a signed-in person.
export const message = async (status: number, text: string, back?: { href: string; label: string }): Promise<Response> =>
  new Response(await html`${head('SamePage')}<body><div class="bare"><div class="card"><span class="brand">${SYMBOL('#14213D')}SamePage</span><p>${text}</p>
${back && html`<p><a href="${back.href}">${back.label}</a></p>`}</div></div></body></html>`,
    { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });

export const entryHref = (e: Entry) => `/dashboard/${e.type === 'workstream' ? 'workstreams' : 'entries'}/${e.id}`;
export const day = (d: Date) => d.toISOString().slice(0, 10);
export const nameOf = (people: Person[], id: string) => people.find((p) => p.id === id)?.name ?? id;
export const names = (people: Person[], ids: string[]) => ids.map((id) => nameOf(people, id)).join(', ');

const DAY_MS = 86_400_000;
const MONTH_DAY = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const FULL = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

export const daysAgo = (d: Date, now = new Date()) => Math.round((Date.parse(day(now)) - Date.parse(day(d))) / DAY_MS);
// "today", "3 days ago", "Mar 5": in UTC, like everything the Worker stores.
export const ago = (d: Date, now = new Date()) => {
  const days = daysAgo(d, now);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  return (d.getUTCFullYear() === now.getUTCFullYear() ? MONTH_DAY : FULL).format(d);
};
export const when = (d: Date) => html`<time datetime="${day(d)}" title="${FULL.format(d)}">${ago(d)}</time>`;

type Tone = 'ok' | 'warn' | 'bad' | 'info' | 'off';
const STATUS: Record<EntryStatus, [string, Tone]> = {
  active: ['Active', 'ok'], superseded: ['Superseded', 'off'], under_review: ['Under review', 'info'], open: ['Open', 'info'],
  accepted: ['Accepted', 'ok'], rejected: ['Rejected', 'off'], in_progress: ['In progress', 'info'], blocked: ['Blocked', 'bad'], done: ['Done', 'ok'],
};
export const status = (s: EntryStatus) => html`<span class="st ${STATUS[s][1]}">${STATUS[s][0]}</span>`;
export const statusLabel = (s: EntryStatus) => STATUS[s][0];

const CONSENSUS: Record<Consensus, [string, Tone]> = {
  unanimous: ['Unanimous', 'ok'], majority: ['Majority', 'warn'], no_consensus: ['No consensus', 'bad'],
};
export const consensus = (c: Consensus) => html`<span class="st ${CONSENSUS[c][1]}">${CONSENSUS[c][0]}</span>`;

export const typeLabel = (t: string) => t[0]!.toUpperCase() + t.slice(1);
export const areaTag = (a: string) => html`<span class="area">${a}</span>`;

// People grouped by the position they took, largest side first. With a consensus, the largest side carried.
export function sides(people: Person[], e: Entry) {
  const groups = new Map<string, { position: string; members: { id: string; name: string; arguments?: string }[] }>();
  for (const p of e.positions ?? []) {
    const key = p.position.trim().toLowerCase();
    if (!groups.has(key)) groups.set(key, { position: p.position.trim(), members: [] });
    groups.get(key)!.members.push({ id: p.person, name: nameOf(people, p.person), arguments: p.arguments });
  }
  const list = [...groups.values()].sort((a, b) => b.members.length - a.members.length);
  const carried = e.consensus === 'unanimous' || e.consensus === 'majority';
  return list.map((g, i) => ({ ...g, tone: carried && i === 0 ? 'win' : '' }));
}

// "2–1": people per side, largest first; a lone side reads "3–0".
export const score = (s: { members: unknown[] }[]) => [...s.map((g) => g.members.length), ...(s.length === 1 ? [0] : [])].join('–');

export const tally = (people: Person[], e: Entry) => {
  const s = sides(people, e);
  if (!s.length) return '';
  const label = s.map((g) => `${g.position}: ${g.members.map((m) => m.name).join(', ')}`).join(' · ');
  return html`<span class="tally" role="img" aria-label="${label}" title="${label}">${s.map((g) =>
    html`<span class="g ${g.tone}">${g.members.map(() => html`<i></i>`)}</span>`)}<span class="score" aria-hidden="true">${score(s)}</span></span>`;
};
