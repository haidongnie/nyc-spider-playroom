import { createRoomRendezvous } from './room-rendezvous.js';
import { createPlayroomSession } from './playroom-session.js';
import { createRemotePlayers } from './remote-players.js';
import { createSharedTraffic } from './shared-traffic.js';

const TIME_IDS = new Set(['golden','midday','twilight','midnight']);
const $ = id => document.getElementById(id);
const round = value => Math.round((Number.isFinite(value) ? value : 0)*100)/100;

function playerSnapshot(controllers, name, day, camera) {
  const e=controllers.getActiveEntity(), person=controllers.entities.person, web=person.web;
  const airborne=web.state==='air', onFoot=e.type==='person';
  const pose=!onFoot ? 'idle' : web.anchor ? (web.swingTime<.14?'webshoot':'swing') :
    airborne ? (e.verticalVel>0?'jump':'fall') : Math.abs(e.speed)>4?'run':Math.abs(e.speed)>.25?'walk':'idle';
  const pivot=e.leanPivot || e.chassisPivot || e.tiltPivot;
  camera.updateWorldMatrix(true, false);
  const matrix = camera.matrixWorld.elements;
  const viewYaw = Math.atan2(-matrix[8], -matrix[10]);
  return {name,viewYaw:round(viewYaw),mode:e.type,x:round(e.position.x),y:round(e.position.y),z:round(e.position.z),heading:round(e.heading),
    pitch:round(pivot?.rotation.x),roll:round(pivot?.rotation.z),speed:round(e.speed),phase:round(e.pedalPhase),
    pose,side:web.side,suited:controllers.spiderSuited,suitProgress:round(person.avatar.suitProgress),
    web:onFoot&&web.anchor ? [round(web.anchor.x),round(web.anchor.y),round(web.anchor.z)] : null,day};
}

function playerName(id) {
  let hash=0;
  for (const c of id) hash=(hash*31+c.charCodeAt(0))>>>0;
  return '玩家 '+String(hash%1000).padStart(3,'0');
}

export function createMultiplayer({scene,controllerManager,trafficSystem,highwayTraffic,airTraffic,hijack,getDay,changeDay,selectMode,onRendezvous}) {
  const peers=createRemotePlayers({scene,controllerManager,streetCars:trafficSystem.cars});
  const shared=createSharedTraffic({controllerManager,trafficSystem,highwayTraffic,airTraffic});
  const names=new Map(), positions=new Map();
  const rendezvous=createRoomRendezvous({controllerManager,selectMode,onArrival:onRendezvous});
  let dismissCreateOnGuest=false, retryMeetAt=0;

  const button=$('room-button'), panel=$('room-panel'), nickname=$('room-nickname'), codeInput=$('room-code-input');
  const statusLine=$('room-status'), timeButtons=[...document.querySelectorAll('[data-time]')];
  let meetHost=false, lastWorld=0, lastPose=0, lastFlags='', started=false, name='';
  try { nickname.value=localStorage.getItem('nyc-room-name') || ''; } catch {}
  const inviteURL=code=>{const u=new URL(location.href);u.searchParams.set('room',code);return u.href;};
  function writeURL(code) {
    const u=new URL(location.href);
    if (code) u.searchParams.set('room',code); else u.searchParams.delete('room');
    if(u.href!==location.href) history.replaceState(history.state,'',u);
  }
  function renderRoster(s) {
    const rows=[];
    for(const id of [s.playerId,...names.keys()]) {
      if(!id)continue;
      const row=document.createElement('li');
      const member=document.createElement('span');
      const display=id===s.playerId?(name||playerName(id)):(names.get(id)||playerName(id));
      member.textContent=display+(id===s.playerId?' · 你':'')+(id===s.hostId?' · 房主':'');
      row.append(member);
      if(id!==s.playerId){
        const visit=document.createElement('button');
        visit.type='button';
        visit.disabled=!positions.has(id);
        visit.textContent=visit.disabled?'等待位置':'前往队友';
        visit.setAttribute('aria-label',visit.disabled?'正在等待 '+display+' 的位置':'前往队友 '+display);
        visit.addEventListener('click',()=>visitPlayer(id));
        row.append(visit);
      }
      rows.push(row);
    }
    $('room-players').replaceChildren(...rows);
  }
  function onStatus(s) {
    const online=s.state==='online', busy=s.state==='connecting';
    hijack.setNetwork(s);
    shared.setRole(online?(s.isHost?'host':'guest'):'local');
    button.dataset.online=String(online);
    $('room-badge').textContent=online?s.count+' / 10':busy?'连接中':'联机';
    $('room-setup').hidden=online;
    $('room-connected').hidden=!online;
    $('room-create').disabled=$('room-join').disabled=busy;
    for(const btn of timeButtons) btn.disabled=online&&!s.isHost;
    if(online) {
      writeURL(s.code);
      $('room-code-value').textContent=s.code;
      statusLine.textContent=s.isHost?'你是房主，可切换房间时段。':'房间时段跟随房主。';
      renderRoster(s);
    } else {
      names.clear(); positions.clear(); peers.clear(); lastFlags='';
      if(s.state==='error' && ['not-found','bad-code','removed'].includes(s.error)) writeURL('');
      for(const entity of Object.values(controllerManager.entities)){
        entity.mesh.visible=entity.type==='person' ? controllerManager.activeMode==='person'
          : entity.type==='skycar' ? entity.launched : true;
      }
      const messages={full:'房间已满（10 人）。', 'not-found':'房间不存在或已关闭。', 'bad-code':'请输入四位房间码。', quota:'Playroom 服务额度已用完，请稍后再试。'};
      statusLine.textContent=busy?'正在连接 Playroom…':s.state==='error'?(messages[s.error]||s.message):'每个房间最多 10 人。';
    }
  }
  function visitPlayer(id) {
    const target=positions.get(id);
    if(!target)return false;
    const others=[...positions.entries()].filter(([peerId])=>peerId!==id).map(([,pose])=>pose);
    if(!rendezvous.meet(target,others,session.status.playerId)){
      statusLine.textContent='队友周围暂无安全的会合点，请稍后再试。';
      return false;
    }
    statusLine.textContent='已到达 '+(names.get(id)||playerName(id))+' 附近。';
    if(panel.open)panel.close();
    return true;
  }
  function tryMeetingHost() {
    if(!meetHost || performance.now()<retryMeetAt)return;
    const host=session.status.hostId;
    if(!host || session.status.isHost || !positions.has(host))return;
    retryMeetAt=performance.now()+1500;
    if(visitPlayer(host))meetHost=false;
  }
  const session=createPlayroomSession({
    gameId:document.querySelector('meta[name="playroom-game-id"]')?.content || '',
    onPeerJoin(id){names.set(id,'');},
    onPeerLeave(id){hijack.remove(id);names.delete(id);positions.delete(id);peers.remove(id);},
    onStatus,
    onSharedState(id,s) {
      hijack.receive(id,s);
      if(!peers.receive(id,{...s,street:hijack.approvedSlot(id,s.street)})) return;
      const first=!positions.has(id);
      positions.set(id,s);
      const display=typeof s.name==='string'?s.name.slice(0,18):'';
      if(first || names.get(id)!==display){names.set(id,display);renderRoster(session.status);}
      if(first && session.status.isHost && dismissCreateOnGuest){
        dismissCreateOnGuest=false;
        if(panel.open)panel.close();
      }
      if(id===session.status.hostId && !session.status.isHost) {
        tryMeetingHost();
        if(TIME_IDS.has(s.day) && getDay()!==s.day) changeDay(s.day);
      }
    },
    onWorld(id,data){shared.ingest(data,id);}
  });
  function openPanel() {
    if(!panel.open){controllerManager.resetInput();panel.showModal();}
  }
  button.addEventListener('click',openPanel);
  $('room-close').addEventListener('click',()=>panel.close());
  panel.addEventListener('keydown',e=>e.stopPropagation());
  panel.addEventListener('keyup',e=>e.stopPropagation());
  panel.addEventListener('close',()=>{controllerManager.resetInput();dismissCreateOnGuest=false;});
  async function connect(code) {
    if(session.status.state==='connecting'||session.status.state==='online')return;
    name=nickname.value.trim().slice(0,18);
    try {localStorage.setItem('nyc-room-name',name);} catch {}
    meetHost=Boolean(code); retryMeetAt=0; dismissCreateOnGuest=!code&&panel.open; lastWorld=lastPose=0; lastFlags='';
    try {
      if(code) await session.join(code); else await session.create();
    } catch(err) {if(session.status.state!=='error')statusLine.textContent=err.message;openPanel();}
  }
  $('room-create').addEventListener('click',()=>connect(null));
  $('room-join-form').addEventListener('submit',e=>{e.preventDefault();const code=codeInput.value.trim().toUpperCase();
    if(!/^[A-Z0-9]{4}$/.test(code)){statusLine.textContent='请输入四位房间码。';codeInput.focus();return;}
    connect(code);
  });
  $('room-invite').addEventListener('click',async ()=>{
    const url=inviteURL(session.status.code);
    try {await navigator.clipboard.writeText(url);statusLine.textContent='邀请链接已复制。';}
    catch {const field=$('room-manual-link');field.hidden=false;field.value=url;field.focus();field.select();}
  });
  $('room-leave').addEventListener('click',()=>{
    session.leave();meetHost=false;writeURL('');$('room-manual-link').hidden=true;panel.close();
  });
  window.addEventListener('pagehide',()=>session.leave());
  function startInvite() {
    if(started)return;started=true;
    const code=new URL(location.href).searchParams.get('room');
    if(code){codeInput.value=code.toUpperCase();connect(code);}
  }
  function before(dt,elapsed) {
    session.update();tryMeetingHost();shared.update(dt);
    return shared.getClock(elapsed);
  }
  function after(dt,camera,now) {
    const s=session.status;
    if(s.state!=='online') return;
    for(const e of Object.values(controllerManager.entities)) e.mesh.visible=e.type===controllerManager.activeMode;
    const flags=controllerManager.activeMode+'/'+controllerManager.spiderSuited+'/'+Boolean(controllerManager.entities.person.web.anchor)+'/'+getDay()+'/'+hijack.revision;
    if(now-lastPose>=66 || flags!==lastFlags) {
      const pose=playerSnapshot(controllerManager,name||playerName(s.playerId),getDay(),camera);
      Object.assign(pose,hijack.packet());
      session.sendPose(pose,flags!==lastFlags);
      lastPose=now;lastFlags=flags;
    }
    if(s.isHost && now-lastWorld>=250) {
      const packet=shared.collectSnapshot();
      if(packet) session.sendWorld(packet);
      lastWorld=now;
    }
    peers.update(dt,camera);
  }
  return {startInvite,before,after,updateAir:shared.updateAir};
}
