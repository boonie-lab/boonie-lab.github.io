// ひらがじゃん 中継サーバー（Cloudflare Workers + Durable Objects）
// 役目：同じ部屋番号の「ホスト」と「ゲスト」の間で、メッセージを右から左へ渡すだけ。ゲームの中身は見ない。
// 部屋番号の形：hrgj-1234（2人対戦）／hrgj-r1234（みんなで競争）。部屋ごとにDurable Objectが1つ。
import { DurableObject } from "cloudflare:workers";

// ==CORE-START==（ここから下は、テスト用サーバーにも同じものを使う。Cloudflare固有の物は入れない）
// 方針：iPhone は、アプリを切り替えたり画面をロックすると、ページ（と通信）が止まる。
//   → 通信が切れても、すぐ「退出」にしない。ホストが落ちてもゲストの接続は残し、戻ってきたら同じ部屋に復帰させる。
// サーバー → ホスト：open{resumed,gids} / join{gid} / d{gid,d} / away{gid} / back{gid} / leave{gid} / err{type}
// サーバー → ゲスト：open{gid,resumed} / d{d} / hostaway / hostback / hostgone / kicked / err{type}
// ホスト → サーバー：d{gid,d} / kick{gid} / bye   ゲスト → サーバー：d{d} / bye
const MAX_GUESTS = 8;      // 1部屋のゲストの上限（アプリ側の上限は別にある）
const MAX_MSG = 30000;     // 1通の長さの上限（文字数）
const J = o => JSON.stringify(o);
// room.all() → ソケット（アダプタ）の配列。ソケットは send(str) / close(code, reason) / getMeta() / setMeta(obj) を持つ
function coreHost(room){ return room.all().find(w => { const m = w.getMeta(); return m && m.role === "host"; }); }
function coreGuests(room){ return room.all().filter(w => { const m = w.getMeta(); return m && m.role === "guest"; }); }
function coreGuest(room, gid){ return room.all().find(w => { const m = w.getMeta(); return m && m.role === "guest" && m.gid === gid; }); }
function coreRetire(w, reason){ try{ w.setMeta({retired:true}); }catch(e){} try{ w.close(1000, reason); }catch(e){} }   // 古いソケットを、通知なしで閉じる
function coreConnect(room, ws, role, opt, rand){
  opt = opt || {};
  if(role === "host"){
    const old = coreHost(room);
    if(old && !opt.resume){ ws.send(J({t:"err", type:"unavailable-id"})); ws.close(1000, "taken"); return; }
    if(old) coreRetire(old, "replaced");                // 戻ってきたホストが、止まったままの古い接続を置き換える
    ws.setMeta({role:"host"});
    const gs = coreGuests(room);
    ws.send(J({t:"open", resumed:!!opt.resume, gids:gs.map(w => w.getMeta().gid)}));
    if(opt.resume) gs.forEach(w => { try{ w.send(J({t:"hostback"})); }catch(e){} });
  }else{
    const h = coreHost(room), gid = opt.gid && /^g[a-z0-9]{3,12}$/.test(opt.gid) ? opt.gid : "";
    if(gid && opt.resume){                              // 席に戻ってきたゲスト
      const old = coreGuest(room, gid); if(old) coreRetire(old, "replaced");
      ws.setMeta({role:"guest", gid}); ws.send(J({t:"open", gid, resumed:true}));
      if(h) h.send(J({t:"back", gid})); else ws.send(J({t:"hostaway"}));
      return;
    }
    if(!h){ ws.send(J({t:"err", type:"peer-unavailable"})); ws.close(1000, "nohost"); return; }
    if(coreGuests(room).length >= MAX_GUESTS){ ws.send(J({t:"err", type:"full"})); ws.close(1000, "full"); return; }
    const g = "g" + rand();
    ws.setMeta({role:"guest", gid:g}); ws.send(J({t:"open", gid:g, resumed:false})); h.send(J({t:"join", gid:g}));
  }
}
function coreMessage(room, ws, raw){
  if(typeof raw !== "string" || raw.length > MAX_MSG) return;
  if(raw === "ping"){ ws.send("pong"); return; }
  let m; try{ m = JSON.parse(raw); }catch(e){ return; }
  const me = ws.getMeta(); if(!me || !m || typeof m !== "object") return;
  if(m.t === "bye"){ ws.setMeta(Object.assign({}, me, {bye:true})); return; }
  if(me.role === "guest"){
    if(m.t === "d"){ const h = coreHost(room); if(h) h.send(J({t:"d", gid:me.gid, d:m.d})); }
  }else if(me.role === "host"){
    if(m.t === "d"){ const g = coreGuest(room, m.gid); if(g) g.send(J({t:"d", d:m.d})); }
    else if(m.t === "kick"){ const g = coreGuest(room, m.gid); if(g){ g.setMeta(Object.assign({}, g.getMeta(), {bye:true})); g.send(J({t:"kicked"})); g.close(1000, "kick"); } }
  }
}
function coreClose(room, ws){
  const me = ws.getMeta(); if(!me || !me.role) return;   // 置き換えられた古いソケットなど：何もしない
  if(me.role === "host"){
    coreGuests(room).forEach(w => {
      try{
        if(me.bye){ w.setMeta(Object.assign({}, w.getMeta(), {bye:true})); w.send(J({t:"hostgone"})); w.close(1000, "hostgone"); }
        else w.send(J({t:"hostaway"}));
      }catch(e){}
    });
  }else if(me.role === "guest"){
    const h = coreHost(room); if(h){ try{ h.send(J({t: me.bye ? "leave" : "away", gid:me.gid})); }catch(e){} }
  }
}
// ==CORE-END==

const ROOM_RE = /^\/room\/(hrgj-r?\d{4})$/;

export default {
  async fetch(request, env){
    const url = new URL(request.url);
    if(url.pathname === "/") return new Response("hiragajan relay ok", {headers:{"content-type":"text/plain; charset=utf-8"}});
    const m = url.pathname.match(ROOM_RE);
    if(!m) return new Response("not found", {status:404});
    if(request.headers.get("Upgrade") !== "websocket") return new Response("websocket only", {status:426});
    // 悪用よけ：許可したページ（Origin）からの接続だけ受ける。ALLOWED_ORIGINS は「,」区切りで変更できる
    const allowed = String(env.ALLOWED_ORIGINS || "https://boonie-lab.github.io").split(",").map(s => s.trim());
    if(!allowed.includes(request.headers.get("Origin"))) return new Response("forbidden", {status:403});
    const id = env.ROOM.idFromName(m[1]);
    return env.ROOM.get(id).fetch(request);
  }
};

function adapt(ws){
  return {
    send: s => ws.send(s),
    close: (c, r) => { try{ ws.close(c || 1000, r || ""); }catch(e){} },
    getMeta: () => { try{ return ws.deserializeAttachment(); }catch(e){ return null; } },
    setMeta: o => ws.serializeAttachment(o)
  };
}

export class Room extends DurableObject {
  constructor(ctx, env){
    super(ctx, env);
    // 生存確認の "ping" には、起こさずに "pong" で返す（無料枠のリクエストに数えられない）
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    this.room = { all: () => this.ctx.getWebSockets().map(adapt) };
  }
  async fetch(request){
    const q = new URL(request.url).searchParams;
    const role = q.get("role") === "host" ? "host" : "guest";
    const opt = {resume: q.get("resume") === "1", gid: q.get("gid") || ""};
    const pair = new WebSocketPair(); const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    coreConnect(this.room, adapt(server), role, opt, () => Math.random().toString(36).slice(2, 8));
    return new Response(null, {status:101, webSocket:client});
  }
  webSocketMessage(ws, message){ coreMessage(this.room, adapt(ws), message); }
  webSocketClose(ws, code, reason, wasClean){ try{ ws.close(1000, "bye"); }catch(e){} coreClose(this.room, adapt(ws)); }
  webSocketError(ws, error){ coreClose(this.room, adapt(ws)); }
}
