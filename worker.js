// binface-bot v2 — autonomous Count Binface Bluesky bot + NEWS BRAIN + HUMANIZED ENGAGEMENT
// Free path: Cloudflare Workers AI (llama-3.3-70b) prose + a custom reasoning endpoint (web-search brain).
// Humanized mechanics ported from Pete's IIM curator-worker: queue-then-drain, jitter, quiet hours,
//   daily caps, probabilistic action (no mechanical cadence), like-then-reply reciprocity.
// Secrets (env, NEVER hardcode): BINFACE_APP_PASS, CF_ACCOUNT_ID, CF_WORKERS_AI_TOKEN,
//   BUMBOCLAAT_BOT_TOKEN, PETE_CHAT_ID, ADMIN_SECRET, FABLE_BRAIN_SECRET  | KV: BINFACE_KV

const HANDLE = "your-bot-handle.example.com";
const MODEL  = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const UA     = "Mozilla/5.0 (BinfaceBot/1.0)";
const FABLE  = "https://YOUR-REASONING-ENDPOINT.example.com/reason";  // use a custom domain, NOT the *.workers.dev route, for reliable worker-to-worker calls

// ─── HUMAN-MIMICRY TUNING KNOBS (ported from IIM curator) ───
const QUIET_START_UTC = 23;   // 23:00 UTC = midnight UK — stop
const QUIET_END_UTC   = 7;    // 07:00 UTC = 08:00 UK — wake (BST)
const MAX_REPLIES_DAY = 6;    // human-ish daily reply ceiling
const MAX_LIKES_DAY   = 12;   // daily like ceiling
const MAX_ACT_PER_TICK= 2;    // never burst: 1-2 actions per wakeup
const REPLY_TICK_PROB = 0.6;  // only ~60% of eligible ticks actually engage (breaks fixed cadence)
const FEED_POST_HOUR  = 8;    // UTC hour to attempt the daily feed post (~09:00 UK)
const QUEUE_TTL_MS    = 8*60*60*1000;

function jsLen(t){let n=0;for(const c of t)n+=c.codePointAt(0)>0xFFFF?2:1;return n;}
function stripCites(s){return String(s||"").replace(/<cite[^>]*>/gi,"").replace(/<\/cite>/gi,"").replace(/\s+/g," ").trim();}
function sleep(ms){return new Promise(r=>setTimeout(r,ms));}
async function humanPause(min=3000,max=15000){await sleep(Math.floor(Math.random()*(max-min+1))+min);}
function isQuietHour(){const h=new Date().getUTCHours();return QUIET_START_UTC>QUIET_END_UTC?(h>=QUIET_START_UTC||h<QUIET_END_UTC):(h>=QUIET_START_UTC&&h<QUIET_END_UTC);}
function today(){return new Date().toISOString().slice(0,10);}

const SYSTEM = `You are Count Binface: intergalactic space warrior from planet Sigma IX with a chrome wheelie-bin for a head, leader of the Binface Party, and currently the ONLY major candidate standing against Nigel Farage in the Clacton-on-Sea by-election (2026).
VOICE: deadpan alien anthropologist observing quaint British customs; impeccably polite then absurd; sci-fi flourishes (lasers, light-years, Sigma IX); heavy British idiom (tea, queues, Greggs, ice-cream vans, bank holidays, wheelie bins). You NEVER break character. You are entirely dignified about being a bin. You sign off with "Bong."
CORNERSTONE POLICY: the 99p Flake must never legally cost more than 99p.
OTHER PLEDGES (rotate, don't list all): bring back Ceefax; cap croissant prices; £2 Wigan kebab cap; speakerphone on public transport = conscription; cyclists who break the Highway Code must ride a unicycle; keep only ONE Buckingham Palace. SINCERE PLEDGES (use with warmth): link ministers' pay to nurses' pay; build genuinely affordable homes; end homelessness; defend democracy and urge people to vote.
RULES: Punch UP at the powerful (Farage, politicians) and at absurdity — NEVER punch down at vulnerable people. Be funny AND either kind or pointed-at-power. Keep every post under 280 characters. British spelling. Occasional gags: "Game on, Nige." / Lord Buckethead / "Bong."`;

async function ai(env,userPrompt,maxTokens=280,system=SYSTEM){
  const url=`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/ai/run/${MODEL}`;
  const r=await fetch(url,{method:"POST",headers:{"Authorization":`Bearer ${env.CF_WORKERS_AI_TOKEN}`,"Content-Type":"application/json"},
    body:JSON.stringify({messages:[{role:"system",content:system},{role:"user",content:userPrompt}],max_tokens:maxTokens,temperature:0.9})});
  const d=await r.json();
  if(!d.success) throw new Error("AI: "+JSON.stringify(d.errors));
  return (d.result.response||"").trim().replace(/^["']|["']$/g,"");
}

// FIXED facet regex: allow digit-leading tags (#99pFlake) as long as >=1 letter present
function tagFacets(text){
  const fs=[]; const re=/#([0-9A-Za-z_]*[A-Za-z][0-9A-Za-z_]*)/g; let m; const enc=new TextEncoder();
  while((m=re.exec(text))){
    const bs=enc.encode(text.slice(0,m.index)).length;
    const be=bs+enc.encode(m[0]).length;
    fs.push({index:{byteStart:bs,byteEnd:be},features:[{$type:"app.bsky.richtext.facet#tag",tag:m[1]}]});
  }
  return fs;
}

async function session(env){
  const r=await fetch("https://bsky.social/xrpc/com.atproto.server.createSession",
    {method:"POST",headers:{"Content-Type":"application/json","User-Agent":UA},
     body:JSON.stringify({identifier:HANDLE,password:env.BINFACE_APP_PASS})});
  if(!r.ok) throw new Error("session "+r.status);
  return r.json();
}
async function post(env,s,text,reply){
  const rec={$type:"app.bsky.feed.post",text,createdAt:new Date().toISOString(),langs:["en"],facets:tagFacets(text)};
  if(reply) rec.reply=reply;
  const r=await fetch("https://bsky.social/xrpc/com.atproto.repo.createRecord",
    {method:"POST",headers:{"Authorization":`Bearer ${s.accessJwt}`,"Content-Type":"application/json","User-Agent":UA},
     body:JSON.stringify({repo:s.did,collection:"app.bsky.feed.post",record:rec})});
  return r.json();
}
async function like(env,s,uri,cid){
  return fetch("https://bsky.social/xrpc/com.atproto.repo.createRecord",
    {method:"POST",headers:{"Authorization":`Bearer ${s.accessJwt}`,"Content-Type":"application/json","User-Agent":UA},
     body:JSON.stringify({repo:s.did,collection:"app.bsky.feed.like",record:{$type:"app.bsky.feed.like",subject:{uri,cid},createdAt:new Date().toISOString()}})}).then(r=>r.json());
}
async function tg(env,msg){
  if(!env.BUMBOCLAAT_BOT_TOKEN||!env.PETE_CHAT_ID) return;
  await fetch(`https://api.telegram.org/bot${env.BUMBOCLAAT_BOT_TOKEN}/sendMessage`,
    {method:"POST",headers:{"Content-Type":"application/json"},
     body:JSON.stringify({chat_id:env.PETE_CHAT_ID,text:msg,parse_mode:"HTML",disable_web_page_preview:true})});
}

// ─── daily counters (KV) ───
async function counters(env){const k="cnt:"+today();const raw=await env.BINFACE_KV.get(k);return raw?JSON.parse(raw):{replies:0,likes:0,feed:false};}
async function saveCounters(env,c){await env.BINFACE_KV.put("cnt:"+today(),JSON.stringify(c),{expirationTtl:60*60*36});}

// ─── NEWS BRAIN (unchanged core; self-learn + self-heal) ───
async function refreshBrain(env){
  const prompt=`Search the web RIGHT NOW for the very latest on the 2026 Clacton (UK) by-election and satirical candidate Count Binface, standing against Nigel Farage. Up-to-the-minute facts.
Return ONLY valid JSON (no markdown, no citation tags): {"phase":"pre_vote|campaign|election_day|result_in","election_date":"YYYY-MM-DD or unknown","days_to_election":"integer or unknown","winner":"name or null","binface_update":"one crisp sentence","farage_update":"one crisp sentence","hot_topics":["3-5 short current storylines"],"sentiment_on_binface":"one sentence","safe_facts":["4-6 VERIFIED facts"],"suggested_angle":"one sentence: sharpest in-character angle today"}`;
  try{
    const r=await fetch(FABLE,{method:"POST",headers:{"Authorization":`Bearer ${env.FABLE_BRAIN_SECRET}`,"Content-Type":"application/json","User-Agent":UA},
      body:JSON.stringify({web_search:true,effort:"high",system:"Meticulous real-time news researcher. Output ONLY valid JSON. No citation tags.",prompt})});
    if(!r.ok) throw new Error("fable "+r.status);
    const d=await r.json(); let txt=stripCites(d.text||"");
    const a=txt.indexOf("{"),b=txt.lastIndexOf("}"); if(a<0||b<0) throw new Error("no json");
    let brain=JSON.parse(stripCites(JSON.stringify(JSON.parse(txt.slice(a,b+1)))));
    brain._fetched=new Date().toISOString();brain._date=today();brain._model=d.model_used||"fable";brain._ok=true;
    await env.BINFACE_KV.put("brain:latest",JSON.stringify(brain));
    await env.BINFACE_KV.put("brain:"+today(),JSON.stringify(brain),{expirationTtl:60*60*24*90});
    await env.BINFACE_KV.put("brain:fail_count","0");
    return brain;
  }catch(e){
    const fc=parseInt((await env.BINFACE_KV.get("brain:fail_count"))||"0",10)+1;
    await env.BINFACE_KV.put("brain:fail_count",String(fc));
    if(fc>=2) await tg(env,`\u26A0\uFE0F <b>Binface News Brain</b> failed ${fc}x (${e.message}). Using last-known; posts continue.`);
    const last=await env.BINFACE_KV.get("brain:latest");
    return last?JSON.parse(last):null;
  }
}
function brainContext(brain){
  if(!brain) return "No fresh news today; use evergreen themes only. Do NOT invent real-world facts.";
  const age=brain._fetched?Math.round((Date.now()-Date.parse(brain._fetched))/3600000):null;
  const L=[`REAL-WORLD SITUATION (as of ${brain._date}${age!=null?`, ${age}h old`:""}) — reference these, invent nothing else:`];
  L.push(`- Phase: ${brain.phase}. Election: ${brain.election_date}${brain.days_to_election&&brain.days_to_election!=="unknown"?` (~${brain.days_to_election}d away)`:""}.`);
  if(brain.winner) L.push(`- WINNER DECLARED: ${brain.winner}. React in-character (gracious if you lost, dignified/jubilant if you won).`);
  if(brain.binface_update) L.push(`- Your campaign today: ${brain.binface_update}`);
  if(brain.farage_update) L.push(`- Farage today: ${brain.farage_update}`);
  if(brain.hot_topics?.length) L.push(`- Live storylines: ${brain.hot_topics.join(" | ")}`);
  if(brain.safe_facts?.length) L.push(`- SAFE facts: ${brain.safe_facts.join(" | ")}`);
  if(brain.suggested_angle) L.push(`- Sharpest angle: ${brain.suggested_angle}`);
  return L.join("\n");
}

// ─── find reply targets, enqueue (queue-then-drain, IIM pattern) ───
async function harvestTargets(env,s){
  const qs=["count binface","clacton by-election","99p flake","binface farage"];
  const found=[];
  for(const q of qs){
    const r=await fetch(`https://bsky.social/xrpc/app.bsky.feed.searchPosts?q=${encodeURIComponent(q)}&limit=8&sort=latest`,
      {headers:{"Authorization":`Bearer ${s.accessJwt}`,"User-Agent":UA}});
    if(!r.ok) continue;
    const d=await r.json();
    for(const p of (d.posts||[])){
      if(p.author.handle===HANDLE) continue;
      if((p.record?.text||"").length<12) continue;
      found.push({uri:p.uri,cid:p.cid,text:p.record.text,handle:p.author.handle,
        root:p.record?.reply?.root||{uri:p.uri,cid:p.cid}});
    }
  }
  return found;
}
async function enqueueReplies(env,targets){
  const now=Date.now();
  for(const t of targets){
    if(await env.BINFACE_KV.get("re:"+t.uri)) continue;           // already replied
    if(await env.BINFACE_KV.get("q:"+t.uri)) continue;            // already queued
    await env.BINFACE_KV.put("q:"+t.uri,JSON.stringify({...t,added:now,expires:now+QUEUE_TTL_MS}),{expirationTtl:Math.floor(QUEUE_TTL_MS/1000)});
  }
}
async function drainQueue(env,s,brain,c,max){
  // list queued keys
  const list=await env.BINFACE_KV.list({prefix:"q:"});
  const now=Date.now(); const items=[];
  for(const k of list.keys){
    const raw=await env.BINFACE_KV.get(k.name); if(!raw) continue;
    const it=JSON.parse(raw); if(it.expires<now){await env.BINFACE_KV.delete(k.name);continue;}
    items.push({key:k.name,it});
  }
  items.sort((a,b)=>a.it.added-b.it.added); // oldest first (human: you reply to things you saw earlier)
  const ctx=brainContext(brain); let fired=0;
  for(const {key,it} of items){
    if(fired>=max||c.replies>=MAX_REPLIES_DAY) break;
    // like-then-reply reciprocity (humans often like before replying)
    if(c.likes<MAX_LIKES_DAY && Math.random()<0.8){await like(env,s,it.uri,it.cid);c.likes++;await humanPause(2000,6000);}
    let rt=await ai(env,`${ctx}\n\nA Bluesky user (@${it.handle}) posted: "${it.text.slice(0,240)}"\nWrite a short witty in-character Count Binface reply (under 220 chars). Use real campaign awareness where relevant. Kind to supporters, pointed about the powerful. Output ONLY the reply.`,200);
    if(jsLen(rt)>295) rt=rt.slice(0,290);
    await humanPause(3000,15000);
    await post(env,s,rt,{root:it.root,parent:{uri:it.uri,cid:it.cid}});
    await env.BINFACE_KV.put("re:"+it.uri,"1",{expirationTtl:2592000});
    await env.BINFACE_KV.delete(key);
    c.replies++; fired++;
  }
  return fired;
}

// ─── daily feed post (news-aware) ───
async function maybeFeedPost(env,s,brain,c){
  if(c.feed) return null;                                  // once/day
  const h=new Date().getUTCHours();
  if(h<FEED_POST_HOUR||h>FEED_POST_HOUR+3) return null;    // ~09:00-12:00 UK window
  const ctx=brainContext(brain);
  let feed;
  if(brain&&brain.winner){
    feed=await ai(env,`${ctx}\n\nResult is IN. Write ONE in-character Count Binface post (<250 chars) reacting to the declared result — dignified and funny. Add 1-2 hashtags (#CountBinface #Clacton). Output ONLY the post.`);
  }else{
    const evergreen=["the 99p Flake cornerstone pledge","a sincere point about housing/homelessness wrapped in a gag","an absurd pledge (Ceefax, croissants, unicycles, speakerphones)","linking ministers' pay to nurses' pay"];
    const useNews=brain&&(Math.random()<0.7);
    const brief=useNews?`Post about TODAY'S real campaign situation using the angle/facts above.`:`Post about: ${evergreen[Math.floor(Math.random()*evergreen.length)]}.`;
    feed=await ai(env,`${ctx}\n\n${brief} Write ONE original Bluesky campaign post (<250 chars). Add 1-2 hashtags like #CountBinface #Clacton #99pFlake. Output ONLY the post.`);
  }
  if(jsLen(feed)>295) feed=feed.slice(0,290);
  await humanPause(2000,8000);
  const fr=await post(env,s,feed);
  c.feed=true;
  return {feed,uri:fr.uri};
}

// ─── MAIN TICK (called by cron several times/day) ───
async function runTick(env,{force=false}={}){
  if(await env.BINFACE_KV.get("killswitch")==="1") return {skipped:"killswitch"};
  if(!force && isQuietHour()) return {skipped:"quiet_hours"};
  const mode=(await env.BINFACE_KV.get("mode"))||"draft";
  const c=await counters(env);

  // refresh brain once/day (only on the first tick that has no brain for today, or feed window)
  let brain=null; const braw=await env.BINFACE_KV.get("brain:latest");
  const brainToday = braw && JSON.parse(braw)._date===today();
  brain = brainToday ? JSON.parse(braw) : await refreshBrain(env);

  const s=await session(env);
  const acted={feed:null,replies:0,likes_start:c.likes};

  // probabilistic engagement — breaks mechanical cadence (skip ~40% of ticks)
  const engage = force || Math.random()<REPLY_TICK_PROB;

  // 1) daily feed post attempt (news-aware, in its window)
  const fp=await maybeFeedPost(env,s,brain,c); if(fp) acted.feed=fp;

  // 2) harvest + enqueue targets (cheap; always safe)
  try{const tg2=await harvestTargets(env,s);await enqueueReplies(env,tg2);}catch(e){}

  // 3) drain a few replies (only if engaging this tick)
  if(engage && mode==="auto"){
    acted.replies=await drainQueue(env,s,brain,c,MAX_ACT_PER_TICK);
  } else if(engage && mode==="draft"){
    // draft mode: build 1-2 reply drafts, telegram Pete, don't post
    const list=await env.BINFACE_KV.list({prefix:"q:"}); const drafts=[];
    for(const k of list.keys.slice(0,2)){const raw=await env.BINFACE_KV.get(k.name);if(!raw)continue;const it=JSON.parse(raw);
      let rt=await ai(env,`${brainContext(brain)}\n\nUser @${it.handle} posted: "${it.text.slice(0,220)}"\nShort in-character Binface reply (<220 chars). Output ONLY the reply.`,200);
      drafts.push({to:it.handle,on:it.text.slice(0,90),reply:rt});}
    if(drafts.length||acted.feed){
      let m=`\u{1F5D1}\uFE0F <b>Binface drafts</b> (${today()}) \u00B7 phase ${brain?.phase||"?"}\n`;
      if(acted.feed) m+=`\n<b>FEED:</b> ${acted.feed.feed}\n`;
      drafts.forEach((d,i)=>{m+=`\n<b>REPLY ${i+1}</b> @${d.to}: ${d.reply}`;});
      m+=`\n\nAuto-mode will post these itself. Flip: /mode?v=auto`;
      await tg(env,m);
    }
  }

  await saveCounters(env,c);
  if(mode==="auto" && (acted.feed||acted.replies)){
    await tg(env,`\u{1F5D1}\uFE0F <b>Binface acted</b> (${today()}) \u00B7 phase ${brain?.phase||"?"}${acted.feed?`\nFEED: ${acted.feed.feed}`:""}\nReplies: ${acted.replies} \u00B7 today ${c.replies}/${MAX_REPLIES_DAY} likes ${c.likes}/${MAX_LIKES_DAY}`);
  }
  return {mode,engaged:engage,quiet:isQuietHour(),feed:!!acted.feed,replies:acted.replies,
    daily:{replies:c.replies,likes:c.likes,feed:c.feed},brain_phase:brain?.phase};
}

async function fireDraft(env,date){ // manual "post today's feed now" helper (legacy)
  const brain=JSON.parse((await env.BINFACE_KV.get("brain:latest"))||"null");
  const s=await session(env); const c=await counters(env);
  const fp=await maybeFeedPostForce(env,s,brain,c); await saveCounters(env,c);
  await tg(env,`\u2705 Binface feed posted (${date}). Bong.`);
  return {fired:true,feed:fp?.uri};
}
async function maybeFeedPostForce(env,s,brain,c){const ctx=brainContext(brain);
  let feed=await ai(env,`${ctx}\n\nWrite ONE original in-character Count Binface Bluesky campaign post (<250 chars), news-aware if possible. 1-2 hashtags (#CountBinface #Clacton). Output ONLY the post.`);
  if(jsLen(feed)>295) feed=feed.slice(0,290); const fr=await post(env,s,feed); c.feed=true; return {feed,uri:fr.uri};}


// ─── one-shot manifesto/curator helper (admin) ───
async function getProfileRecord(env,s){
  const r=await fetch(`https://bsky.social/xrpc/com.atproto.repo.getRecord?repo=${s.did}&collection=app.bsky.actor.profile&rkey=self`,
    {headers:{"Authorization":`Bearer ${s.accessJwt}`,"User-Agent":UA}});
  return r.ok?r.json():null;
}
async function setPinned(env,s,uri,cid){
  const cur=await getProfileRecord(env,s);
  const val=(cur&&cur.value)?cur.value:{$type:"app.bsky.actor.profile"};
  val.pinnedPost={uri,cid};
  const r=await fetch("https://bsky.social/xrpc/com.atproto.repo.putRecord",
    {method:"POST",headers:{"Authorization":`Bearer ${s.accessJwt}`,"Content-Type":"application/json","User-Agent":UA},
     body:JSON.stringify({repo:s.did,collection:"app.bsky.actor.profile",rkey:"self",record:val,swapRecord:cur?cur.cid:undefined})});
  return r.json();
}
async function deletePost(env,s,uri){
  const [repo,collection,rkey]=uri.replace("at://","").split("/");
  const r=await fetch("https://bsky.social/xrpc/com.atproto.repo.deleteRecord",
    {method:"POST",headers:{"Authorization":`Bearer ${s.accessJwt}`,"Content-Type":"application/json","User-Agent":UA},
     body:JSON.stringify({repo,collection,rkey})});
  return r.ok;
}
async function publishManifesto(env,text,deleteOldPinned){
  const s=await session(env);
  let deleted=null;
  if(deleteOldPinned){
    const cur=await getProfileRecord(env,s);
    const oldPin=cur&&cur.value&&cur.value.pinnedPost&&cur.value.pinnedPost.uri;
    if(oldPin){ deleted=oldPin; await deletePost(env,s,oldPin); }
  }
  const fr=await post(env,s,text);          // creates manifesto with facets
  if(!fr.uri) return {error:"post failed",detail:fr};
  await setPinned(env,s,fr.uri,fr.cid);
  await tg(env,`\u{1F5D1}\uFE0F <b>Manifesto pinned.</b>${deleted?" Old thread root deleted.":""}\n\n${text}`);
  return {ok:true,uri:fr.uri,cid:fr.cid,deleted_old:deleted};
}


async function setAvatar(env,imgUrl){
  const s=await session(env);
  const ir=await fetch(imgUrl,{headers:{"User-Agent":UA}});
  const buf=await ir.arrayBuffer();
  const up=await fetch("https://bsky.social/xrpc/com.atproto.repo.uploadBlob",
    {method:"POST",headers:{"Authorization":`Bearer ${s.accessJwt}`,"Content-Type":"image/jpeg","User-Agent":UA},body:buf});
  const ud=await up.json(); if(!ud.blob) return {error:"upload failed",detail:ud};
  const cur=await getProfileRecord(env,s);
  const val=(cur&&cur.value)?cur.value:{$type:"app.bsky.actor.profile"};
  val.avatar=ud.blob;
  const r=await fetch("https://bsky.social/xrpc/com.atproto.repo.putRecord",
    {method:"POST",headers:{"Authorization":`Bearer ${s.accessJwt}`,"Content-Type":"application/json","User-Agent":UA},
     body:JSON.stringify({repo:s.did,collection:"app.bsky.actor.profile",rkey:"self",record:val,swapRecord:cur?cur.cid:undefined})});
  return {ok:r.ok,blob:ud.blob.ref};
}

export default {
  async fetch(req,env){
    const u=new URL(req.url);
    if(u.pathname==="/health") return Response.json({ok:true,handle:HANDLE,model:MODEL,mode:(await env.BINFACE_KV.get("mode"))||"draft",kill:(await env.BINFACE_KV.get("killswitch"))==="1",quiet:isQuietHour(),brain_fails:(await env.BINFACE_KV.get("brain:fail_count"))||"0",today:await counters(env)});
    if(u.pathname==="/brain"){const b=await env.BINFACE_KV.get("brain:latest");return new Response(b||"{}",{headers:{"content-type":"application/json"}});}
    if(u.pathname==="/queue"){const l=await env.BINFACE_KV.list({prefix:"q:"});return Response.json({queued:l.keys.length,keys:l.keys.map(k=>k.name)});}
    const auth=u.searchParams.get("k")||req.headers.get("x-admin");
    if(auth!==env.ADMIN_SECRET) return new Response("unauthorized",{status:401});
    if(u.pathname==="/tick") return Response.json(await runTick(env,{force:u.searchParams.get("force")==="1"}));
    if(u.pathname==="/refresh-brain") return Response.json(await refreshBrain(env));
    if(u.pathname==="/fire") return Response.json(await fireDraft(env,u.searchParams.get("date")||today()));
    if(u.pathname==="/set-avatar"){const bb=await req.json().catch(()=>({}));return Response.json(await setAvatar(env,bb.url));}
    if(u.pathname==="/manifesto"){const b=await req.json().catch(()=>({}));return Response.json(await publishManifesto(env,b.text,b.delete_old_pinned!==false));}
    if(u.pathname==="/mode"){await env.BINFACE_KV.put("mode",u.searchParams.get("v")||"draft");return Response.json({mode:await env.BINFACE_KV.get("mode")});}
    if(u.pathname==="/kill"){await env.BINFACE_KV.put("killswitch",u.searchParams.get("v")||"1");return Response.json({kill:await env.BINFACE_KV.get("killswitch")});}
    return new Response("binface-bot v2",{status:200});
  },
  async scheduled(event,env,ctx){ ctx.waitUntil(runTick(env)); }
};
