import http from "node:http";
import { URL } from "node:url";

const PORT = Number(process.env.PORT || 10000);
const CACHE_MS = Number(process.env.CACHE_SECONDS || 600) * 1000;
const cache = new Map();

function json(res, code, body){
  res.writeHead(code, {"content-type":"application/json; charset=utf-8","cache-control":"no-store"});
  res.end(JSON.stringify(body));
}
function html(res, code, body){
  res.writeHead(code, {"content-type":"text/html; charset=utf-8","cache-control":"no-store"});
  res.end(body);
}
function esc(s){return String(s??"").replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[m]))}
async function cached(key, loader){
  const hit=cache.get(key), now=Date.now();
  if(hit && hit.expires>now) return {...hit.value,cache:{hit:true,expiresAt:new Date(hit.expires).toISOString()}};
  const value=await loader();
  cache.set(key,{expires:now+CACHE_MS,value});
  return {...value,cache:{hit:false,expiresAt:new Date(now+CACHE_MS).toISOString()}};
}
async function getJson(url, opts={}){
  const r=await fetch(url,{...opts,headers:{"user-agent":"COBALT/0.2","accept":"application/json",...(opts.headers||{})}});
  if(!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return r.json();
}
async function getText(url){
  const r=await fetch(url,{headers:{"user-agent":"COBALT/0.2","accept":"text/html"}});
  if(!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return r.text();
}
function live(source,data,freshness="source-current"){return {source,status:"live",observedAt:new Date().toISOString(),freshness,data}}
function unavailable(source,reason){return {source,status:"unavailable",reason,data:null}}

async function gdelt(query,max=100,timespan="24h"){
  try{
    const u=new URL("https://api.gdeltproject.org/api/v2/doc/doc");
    u.searchParams.set("query",query);
    u.searchParams.set("mode","artlist");
    u.searchParams.set("maxrecords",String(Math.min(max,250)));
    u.searchParams.set("timespan",timespan);
    u.searchParams.set("format","json");
    const j=await getJson(u);
    const a=(j.articles||[]).map(x=>({title:x.title||null,url:x.url||null,domain:x.domain||null,seenDate:x.seendate||null}));
    return live("GDELT DOC 2.0",{query,totalReports:a.length,uniqueDomains:new Set(a.map(x=>x.domain).filter(Boolean)).size,uniqueUrls:new Set(a.map(x=>x.url).filter(Boolean)).size,articles:a});
  }catch(e){return unavailable("GDELT DOC 2.0",String(e))}
}
async function whiteHouse(){
  try{
    const body=await getText("https://www.whitehouse.gov/presidential-actions/");
    const re=/<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>\s*<\/h2>[\s\S]{0,500}?([A-Z][a-z]+\s+\d{1,2},\s+20\d{2})/gi;
    const out=[]; let m;
    while((m=re.exec(body))&&out.length<20){
      const title=m[2].replace(/<[^>]+>/g,"").replace(/&amp;/g,"&").trim();
      const url=new URL(m[1],"https://www.whitehouse.gov").toString();
      out.push({title,url,date:m[3]});
    }
    if(!out.length){
      const linkRe=/<a[^>]*href="([^"]*\/presidential-actions\/[^"]+)"[^>]*>(.*?)<\/a>/gi;
      while((m=linkRe.exec(body))&&out.length<20){
        const title=m[2].replace(/<[^>]+>/g,"").replace(/&amp;/g,"&").trim();
        if(title.length>8) out.push({title,url:new URL(m[1],"https://www.whitehouse.gov").toString()});
      }
    }
    return live("White House Presidential Actions",{count:out.length,items:out});
  }catch(e){return unavailable("White House Presidential Actions",String(e))}
}
async function fec(q="Donald Trump"){
  try{
    const key=process.env.FEC_API_KEY || "DEMO_KEY";
    const u=new URL("https://api.open.fec.gov/v1/candidates/search/");
    u.searchParams.set("api_key",key);u.searchParams.set("q",q);u.searchParams.set("per_page","5");
    const j=await getJson(u);
    return live("OpenFEC API",{count:(j.results||[]).length,candidates:(j.results||[]).map(x=>({candidate_id:x.candidate_id,name:x.name,office:x.office,party:x.party_full,state:x.state}))},"nightly processed data");
  }catch(e){return unavailable("OpenFEC API",String(e))}
}
async function congress(){
  const key=process.env.CONGRESS_API_KEY || "";
  if(!key) return unavailable("Congress.gov API","CONGRESS_API_KEY not configured");
  try{
    const u=new URL("https://api.congress.gov/v3/bill");
    u.searchParams.set("api_key",key);u.searchParams.set("format","json");u.searchParams.set("limit","10");
    const j=await getJson(u);
    return live("Congress.gov API",{count:(j.bills||[]).length,bills:(j.bills||[]).map(x=>({congress:x.congress,number:x.number,type:x.type,title:x.title,latestAction:x.latestAction||null,url:x.url||null}))});
  }catch(e){return unavailable("Congress.gov API",String(e))}
}

const TOPICS=["housing","immigration","economy","federal budget","public safety","healthcare","education","energy","taxes","elections"];
async function topicStats(){
  const out=[];
  for(const topic of TOPICS){
    const r=await gdelt(`(${topic}) sourcecountry:US`,100,"24h");
    if(r.status==="live") out.push({topic,status:"live",reports:r.data.totalReports,independentDomains:r.data.uniqueDomains,uniqueUrls:r.data.uniqueUrls,observedAt:r.observedAt});
    else out.push({topic,status:"unavailable",reason:r.reason});
  }
  return out;
}
async function audit(){
  const defs=[
    ["gdelt",()=>gdelt("politics sourcecountry:US",10,"24h")],
    ["whitehouse",whiteHouse],
    ["fec",()=>fec("Donald Trump")],
    ["congress",congress]
  ];
  const checks=[];
  for(const [id,fn] of defs){
    const t=Date.now(), r=await fn();
    checks.push({id,status:r.status,reason:r.reason||null,latencyMs:Date.now()-t,observedAt:r.observedAt||null,freshness:r.freshness||null});
  }
  return {generatedAt:new Date().toISOString(),mode:"live-only",checks};
}
async function dashboard(){
  const [topics,wh,fe,cg]=await Promise.all([topicStats(),whiteHouse(),fec("Donald Trump"),congress()]);
  return {generatedAt:new Date().toISOString(),mode:"live-only",topics:topics.filter(x=>x.status==="live").sort((a,b)=>(b.independentDomains||0)-(a.independentDomains||0)),sources:{whiteHouse:wh,fec:fe,congress:cg}};
}

const page=`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>COBALT Live</title><style>
:root{--bg:#03111b;--panel:#061824;--line:#15384a;--cyan:#1bc2ff;--gold:#f1bd4d;--text:#e9f2f5;--muted:#7893a0;--ok:#3be0b8;--bad:#ff8b7c}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px Arial,sans-serif}.top{height:68px;border-bottom:1px solid var(--line);display:flex;align-items:center;padding:0 18px;gap:16px}.brand{font-size:27px;font-weight:300}.sub{font-size:8px;letter-spacing:.12em;color:var(--muted)}#live{margin-left:auto;color:var(--ok);font-size:9px}.wrap{padding:16px}.hero{display:grid;grid-template-columns:1fr 350px;gap:10px}.panel{background:var(--panel);border:1px solid var(--line)}.main{padding:16px;min-height:440px}.eyebrow{font-size:8px;letter-spacing:.17em;color:var(--cyan)}h1{font-size:36px;font-weight:300;margin:7px 0 4px}.note{color:var(--muted);font-size:11px}.topics{display:grid;grid-template-columns:repeat(2,1fr);gap:8px;margin-top:18px}.topic{border:1px solid var(--line);padding:11px}.topic b{display:block;font-size:18px;font-weight:300;text-transform:capitalize}.topic small{display:block;margin-top:4px;color:var(--muted)}.source{padding:11px;border-top:1px solid var(--line)}.source:first-child{border-top:0}.source span{float:right}.source .live{color:var(--ok)}.source .unavailable{color:var(--bad)}.grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-top:10px}.card{padding:12px}.row{padding:8px 0;border-top:1px solid var(--line);font-size:10px}.row:first-child{border-top:0}.muted{color:var(--muted);font-size:8px}.bad{color:var(--bad)}button{background:#071d2b;border:1px solid #20546b;color:#cdebf5;padding:7px 9px;cursor:pointer}@media(max-width:900px){.hero,.grid{grid-template-columns:1fr}.topics{grid-template-columns:1fr}}</style></head><body>
<div class="top"><div class="brand">COBALT</div><div class="sub">LIVE POLITICAL INTELLIGENCE · NO SIMULATED DATA</div><div id="live">CONNECTING…</div></div><div class="wrap">
<div class="hero"><section class="panel main"><div class="eyebrow">LIVE U.S. POLITICAL ACTIVITY</div><h1>What is actually trending right now?</h1><div class="note">Every number on this screen comes from a live source response. Missing sources show unavailable instead of demo values.</div><div id="topics" class="topics"></div></section>
<aside class="panel"><div style="padding:12px;border-bottom:1px solid var(--line)"><b>SOURCE HEALTH</b><button id="refresh" style="float:right">REFRESH</button></div><div id="sources"></div></aside></div>
<div class="grid"><section class="panel card"><div class="eyebrow">PRESIDENTIAL ACTIONS</div><div id="wh"></div></section><section class="panel card"><div class="eyebrow">CONGRESS</div><div id="cg"></div></section><section class="panel card"><div class="eyebrow">OPENFEC · DONALD TRUMP SEARCH</div><div id="fec"></div></section></div></div>
<script>
const $=s=>document.querySelector(s);const esc=s=>String(s??"").replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[m]));
async function load(){try{$("#live").textContent="LOADING LIVE…";const r=await fetch("/api/dashboard",{cache:"no-store"});const d=await r.json();if(!r.ok)throw new Error(d.error||"unavailable");$("#live").textContent="LIVE · "+new Date(d.generatedAt).toLocaleTimeString();
$("#topics").innerHTML=d.topics.length?d.topics.map(t=>`<div class="topic"><b>${esc(t.topic)}</b><small>${t.reports} reports · ${t.independentDomains} independent domains · ${t.uniqueUrls} unique URLs</small><small>${new Date(t.observedAt).toLocaleString()}</small></div>`).join(""):'<div class="bad">No live topic data returned.</div>';
const src=[d.sources.whiteHouse,d.sources.congress,d.sources.fec];$("#sources").innerHTML=src.map(s=>`<div class="source">${esc(s.source)}<span class="${esc(s.status)}">${esc(s.status)}</span><div class="muted">${esc(s.reason||s.freshness||"source-current")}</div></div>`).join("");
const wh=d.sources.whiteHouse;$("#wh").innerHTML=wh.status==="live"?(wh.data.items||[]).slice(0,8).map(x=>`<div class="row"><a target="_blank" rel="noopener" href="${esc(x.url)}" style="color:#d6eef6;text-decoration:none">${esc(x.title)}</a><div class="muted">${esc(x.date||"")}</div></div>`).join(""):`<div class="bad">${esc(wh.reason)}</div>`;
const cg=d.sources.congress;$("#cg").innerHTML=cg.status==="live"?(cg.data.bills||[]).slice(0,8).map(x=>`<div class="row">${esc(x.title||((x.type||"")+" "+(x.number||"")))}<div class="muted">${esc(x.latestAction?.text||"")}</div></div>`).join(""):`<div class="bad">${esc(cg.reason)}</div>`;
const fe=d.sources.fec;$("#fec").innerHTML=fe.status==="live"?(fe.data.candidates||[]).map(x=>`<div class="row">${esc(x.name)}<div class="muted">${esc([x.office,x.party,x.state].filter(Boolean).join(" · "))}</div></div>`).join(""):`<div class="bad">${esc(fe.reason)}</div>`;
}catch(e){$("#live").textContent="LIVE SOURCES UNAVAILABLE";$("#topics").innerHTML='<div class="bad">'+esc(e)+'</div>';}}$("#refresh").onclick=load;load();setInterval(load,600000);
</script></body></html>`;

const server=http.createServer(async(req,res)=>{
  try{
    const u=new URL(req.url,`http://${req.headers.host}`);
    if(u.pathname==="/api/health") return json(res,200,{status:"ok",mode:"live-only",time:new Date().toISOString()});
    if(u.pathname==="/api/audit") return json(res,200,await audit());
    if(u.pathname==="/api/dashboard") return json(res,200,await cached("dashboard",dashboard));
    if(u.pathname==="/api/news") return json(res,200,await gdelt(u.searchParams.get("q")||"politics sourcecountry:US",Number(u.searchParams.get("max")||100),u.searchParams.get("timespan")||"24h"));
    if(u.pathname==="/") return html(res,200,page);
    return json(res,404,{error:"not found"});
  }catch(e){return json(res,503,{status:"unavailable",error:String(e)})}
});
server.listen(PORT,()=>console.log(`COBALT live listening on ${PORT}`));