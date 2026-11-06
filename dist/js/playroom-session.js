// Playroom's browser SDK owns one connection per window. A same-origin frame
// lets a player exit/rejoin without reloading the city or rewriting its URL.
const CAPACITY = 10;
const SCENE_KEY = 'nyc_room_v1';
const POSE_KEY = 'nyc_pose_v1';
const WORLD_KEY = 'nyc_world_v1';
const HOST_RPC = 'nyc_authority_v1';
const SCENE = 'slop-new-york-multiplayer/v1';
const SEND_INTERVAL = 65;
const WORLD_INTERVAL = 240;
const WORLD_LIMIT = 12 * 1024;
const noop = () => {};

function uuid() {
  return (
    globalThis.crypto?.randomUUID?.() ||
    Array.from(crypto.getRandomValues(new Uint32Array(4)), (n) => n.toString(16)).join('-')
  );
}

function roomCode(value) {
  const code = String(value || '')
    .trim()
    .toUpperCase();
  if (!/^[A-Z0-9]{4}$/.test(code)) throw new Error('Enter the four-character Playroom room code.');
  return code;
}

function errorReason(error) {
  const text = String(error?.reason || error?.message || error || 'Connection failed');
  if (/ROOM_LIMIT_EXCEEDED|room.*full/i.test(text)) return ['full', 'This room already has 10 players.'];
  if (/QUOTA_EXCEEDED|quota/i.test(text))
    return [
      'quota',
      'Playroom reached its usage limit. Use the game’s own Playroom project ID or retry when the quota resets.'
    ];
  if (/PLAYER_KICKED/i.test(text)) return ['removed', 'Playroom removed this player from the room.'];
  if (/not found|no active|unrecognized|invalid room/i.test(text))
    return ['not-found', 'No active New York room matches that code.'];
  if (/four-character/i.test(text)) return ['bad-code', text];
  if (/game.?id/i.test(text))
    return ['game-id', 'Playroom rejected the project ID. Check the game’s Playroom project configuration.'];
  if (/offline/i.test(text)) return ['offline', 'The browser is offline. Reconnect and try again.'];
  if (/time.?out|timed out/i.test(text))
    return ['unreachable', 'Playroom did not respond. Check the connection and room code, then retry.'];
  return ['connection', text.slice(0, 180)];
}

// Values arrive from other browsers. Copy a small JSON tree; never accept JS
// objects/prototype keys, NaN/Infinity or a sender ID from the payload.
function cleanPose(value) {
  let budget = 150;
  function copy(item, depth) {
    if (--budget < 0 || depth > 6) throw new Error('Pose is too large');
    if (item === null || typeof item === 'boolean') return item;
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    if (typeof item === 'string' && item.length <= 96) return item;
    if (!item || typeof item !== 'object') throw new Error('Invalid pose value');
    if (Array.isArray(item)) {
      if (item.length > 32) throw new Error('Pose array is too large');
      return item.map((entry) => copy(entry, depth + 1));
    }
    const prototype = Object.getPrototypeOf(item);
    if (prototype !== null && Object.getPrototypeOf(prototype) !== null) throw new Error('Invalid pose object');
    const output = {};
    for (const [key, entry] of Object.entries(item)) {
      if (!/^[a-zA-Z][\w]{0,31}$/.test(key) || key === 'constructor' || key === 'prototype')
        throw new Error('Invalid pose field');
      output[key] = copy(entry, depth + 1);
    }
    return output;
  }
  try {
    return value && typeof value === 'object' && !Array.isArray(value) ? copy(value, 0) : null;
  } catch {
    return null;
  }
}

export function createPlayroomSession({
  gameId = '',
  frameUrl,
  onPeerJoin = noop,
  onPeerLeave = noop,
  onSharedState = noop,
  onWorld = noop,
  onStatus = noop
} = {}) {
  let active = null;
  let status = Object.freeze({
    state: 'offline',
    code: '',
    roomCode: '',
    playerId: '',
    count: 0,
    capacity: CAPACITY,
    isHost: false,
    hostId: '',
    message: '',
    error: ''
  });

  function announce(state, extra = {}) {
    status = Object.freeze({ ...status, state, ...extra });
    onStatus(status);
  }
  function summarize(s) {
    if (s !== active || !s.ready) return;
    const count = Math.min(CAPACITY, 1 + s.peers.size),
      host = Boolean(s.sdk.isHost());
    if (status.count !== count || status.isHost !== host || status.hostId !== s.hostId)
      announce('online', { count, isHost: host, hostId: s.hostId });
  }
  function removePeer(s, id) {
    const peer = s.peers.get(id);
    if (!peer) return;
    peer.off?.();
    s.peers.delete(id);
    onPeerLeave(id);
    summarize(s);
  }
  function addPeer(s, player) {
    const id = player?.id;
    if (s !== active || !s.ready || !id || id === s.me?.id) return;
    const previous = s.peers.get(id);
    if (previous) {
      // Playroom may replace PlayerState objects while migrating the host.
      if (previous.player !== player) {
        previous.off?.();
        previous.player = player;
        previous.off = player.onQuit(() => {
          if (s.peers.get(id)?.player === player) removePeer(s, id);
        });
      }
      return;
    }
    if (s.peers.size >= CAPACITY - 1) {
      // The service enforces maxPlayersPerRoom. This also protects admission
      // if an outdated client tries to join with a different requested limit.
      if (s.sdk.isHost()) Promise.resolve(player.kick()).catch(noop);
      return;
    }
    const record = { player, seq: 0, off: null };
    s.peers.set(id, record);
    record.off = player.onQuit(() => removePeer(s, id));
    onPeerJoin(id);
    // A newcomer should see a stationary or backgrounded player before their next frame.
    if (s.lastPose) sendPose(s.lastPose, true);
    summarize(s);
  }
  function authority(s, id) {
    if (s !== active || typeof id !== 'string' || id.length > 96 || id === s.hostId) return;
    s.hostId = id;
    s.worldRxSeq = 0;
    s.authorityRevision++;
    s.worldTerm = id === s.me.id ? uuid() : '';
    s.worldTxSeq = 0;
    s.pendingWorld = null;
    s.nextAuthorityProbe = 0;
    s.unknownReplies = 0;
    summarize(s);
  }
  function confirmAuthority(s) {
    if (s.worldTerm || s.sdk.isHost() || performance.now() < s.nextAuthorityProbe) return;
    s.nextAuthorityProbe = performance.now() + 1800;
    const challenge = uuid(),
      revision = s.authorityRevision;
    s.sdk.RPC.call(HOST_RPC, { room: s.token, challenge }, s.sdk.RPC.Mode.HOST)
      .then((reply) => {
        if (
          s !== active ||
          revision !== s.authorityRevision ||
          reply?.room !== s.token ||
          reply.challenge !== challenge ||
          typeof reply.term !== 'string' ||
          !reply.term ||
          (s.hostId && reply.id !== s.hostId)
        )
          return;
        authority(s, reply.id);
        if (!reply.known) {
          // A freshly elected SDK host can lack players that joined just before
          // the old host left. Rejoining produces a real admission on its server
          // connection. Allow a normal roster sync first; never invent a player.
          if (++s.unknownReplies >= 2) repairMembership(s);
          return;
        }
        s.worldTerm = reply.term;
      })
      .catch(noop);
  }
  function observeAuthority(s) {
    // The public API exposes isHost() locally. For changes, the pinned SDK
    // consumes the relay's hostUpdate control frame and keeps only a boolean.
    // Read the same trusted relay event, never a claimed ID in a player's data.
    const socket = s.sdk.Multiplayer().connection?.ws;
    if (!socket || socket === s.authoritySocket) return;
    s.detachAuthority?.();
    s.authoritySocket = socket;
    const handle = (e) => {
      if (!e.isTrusted || typeof e.data !== 'string' || e.data.length > 512 || !e.data.includes('"hostUpdate"'))
        return;
      try {
        const msg = JSON.parse(e.data);
        if (typeof msg.hostUpdate === 'string') authority(s, msg.hostUpdate);
      } catch {}
    };
    socket.addEventListener('message', handle);
    s.detachAuthority = () => socket.removeEventListener('message', handle);
  }
  function initializeAuthority(s) {
    s.listeners.push(
      s.sdk.RPC.register(HOST_RPC, (request, sender) => {
        if (s.sdk.isHost() && request?.room === s.token && typeof request.challenge === 'string') {
          authority(s, s.me.id);
          return {
            room: s.token,
            challenge: request.challenge,
            id: s.me.id,
            term: s.worldTerm,
            known: Boolean(sender?.id)
          };
        }
      })
    );
    observeAuthority(s);
    if (s.sdk.isHost()) {
      authority(s, s.me.id);
      return;
    }
    // Initial guest sockets need not receive a hostUpdate until ownership
    // changes. Ask the current host by Playroom's host-routed RPC.
    confirmAuthority(s);
  }
  function release(s) {
    if (!s || s.closed) return;
    s.closed = true;
    s.ready = false;
    s.cancel?.(new Error('Connection attempt canceled.'));
    if (s.frame) s.frame.onload = s.frame.onerror = null;
    s.detachAuthority?.();
    clearTimeout(s.deadline);
    clearInterval(s.checkTimer);
    for (const off of s.listeners) {
      try {
        off();
      } catch {}
    }
    for (const id of [...s.peers.keys()]) removePeer(s, id);
    // Tell the service immediately; removing the frame also closes its socket,
    // heartbeat, React tree and listeners even during a failed handshake.
    try {
      Promise.resolve(s.me?.leaveRoom()).catch(noop);
    } catch {}
    s.frame?.remove();
  }
  function fail(s, error) {
    if (s !== active) return;
    const [kind, message] = errorReason(error);
    active = null;
    release(s);
    announce('error', {
      code: '',
      roomCode: '',
      playerId: '',
      count: 0,
      isHost: false,
      hostId: '',
      error: kind,
      message
    });
  }
  function leave() {
    const s = active;
    active = null;
    release(s);
    announce('offline', {
      code: '',
      roomCode: '',
      playerId: '',
      count: 0,
      isHost: false,
      hostId: '',
      message: '',
      error: ''
    });
  }
  function repairMembership(s) {
    if (active !== s || !s.ready) return;
    if (s.repairAttempts >= 2) {
      fail(s, new Error('Playroom could not restore your membership after the host changed. Rejoin the room.'));
      return;
    }
    const code = status.code,
      pose = s.lastPose;
    active = null;
    release(s);
    connect(code, s.repairAttempts + 1)
      .then(() => {
        if (pose) sendPose(pose, true);
      })
      .catch(noop);
  }
  async function connect(code, repairAttempts = 0) {
    if (active) throw new Error('Leave the active room or cancel the connection before starting another.');
    if (code !== null) {
      try {
        code = roomCode(code);
      } catch (error) {
        const [kind, message] = errorReason(error);
        announce('error', { error: kind, message });
        throw error;
      }
    }
    const s = {
      frame: null,
      sdk: null,
      me: null,
      token: '',
      ready: false,
      closed: false,
      peers: new Map(),
      listeners: [],
      txSeq: 0,
      lastSend: -Infinity,
      lastReliable: -Infinity,
      pending: null,
      lastPose: null,
      hostId: '',
      worldTerm: '',
      nextAuthorityProbe: 0,
      authorityRevision: 0,
      worldTxSeq: 0,
      worldRxSeq: 0,
      unknownReplies: 0,
      repairAttempts,
      worldSend: -Infinity,
      worldReliable: -Infinity,
      pendingWorld: null,
      nextRoster: 0
    };
    active = s;
    announce('connecting', {
      code: code || '',
      roomCode: code || '',
      playerId: '',
      count: 0,
      isHost: false,
      hostId: '',
      error: '',
      message: repairAttempts
        ? 'Playroom host changed. Restoring your connection…'
        : code
          ? 'Joining Playroom…'
          : 'Creating a Playroom room…'
    });
    let rejectCanceled;
    const canceled = new Promise((_, reject) => {
      rejectCanceled = reject;
    });
    s.cancel = rejectCanceled;
    s.deadline = setTimeout(() => rejectCanceled(new Error('Playroom connection timed out.')), 24000);
    async function start() {
      if (navigator.onLine === false) throw new Error('Browser offline.');
      const frame = (s.frame = document.createElement('iframe'));
      frame.hidden = true;
      frame.tabIndex = -1;
      frame.setAttribute('aria-hidden', 'true');
      frame.title = 'Playroom connection';
      const loaded = new Promise((resolve, reject) => {
        frame.onload = resolve;
        frame.onerror = () => reject(new Error('Cannot load the Playroom SDK.'));
      });
      frame.src = String(frameUrl || new URL('./vendor/playroom-frame.html', import.meta.url));
      document.body.appendChild(frame);
      await loaded;
      if (s !== active) throw new Error('Connection canceled.');
      const sdk = (s.sdk = frame.contentWindow?.Playroom);
      if (!sdk?.insertCoin) throw new Error('Playroom SDK is unavailable. Serve the game over HTTP or HTTPS.');
      frame.onload = () => {
        if (s !== active) return;
        const error = new Error('Playroom disconnected or restarted. Rejoin to continue.');
        if (s.ready) fail(s, error);
        else s.cancel?.(error);
      };
      // No borrowed project identifiers. Version 0.0.97 supports anonymous
      // rooms; register a real ID with Playroom for a production allowance.
      const options = {
        skipLobby: true,
        maxPlayersPerRoom: CAPACITY,
        ...(code ? { roomCode: code } : {}),
        ...(gameId ? { gameId } : {})
      };
      await sdk.insertCoin(options);
      if (s !== active) throw new Error('Connection canceled.');
      s.me = sdk.myPlayer();
      const actualCode = sdk.getRoomCode();
      if (!s.me?.id || !actualCode || (code && actualCode !== code)) throw new Error('Invalid room connection.');
      s.listeners.push(
        sdk.onDisconnect((ev) => {
          if (s !== active) return;
          if (s.ready) fail(s, ev);
          else s.cancel(ev);
        })
      );
      if (!code) {
        if (!sdk.isHost()) throw new Error('Playroom could not assign ownership of the new room.');
        s.token = uuid();
        sdk.setState(SCENE_KEY, { app: SCENE, token: s.token }, true);
      } else {
        // Without the host's room marker, a mistyped code must never become a
        // new room or attach to a different game in the anonymous namespace.
        await new Promise((resolve, reject) => {
          const until = performance.now() + 7000;
          const check = () => {
            const marker = sdk.getState(SCENE_KEY);
            if (marker?.app === SCENE && typeof marker.token === 'string') {
              s.token = marker.token;
              clearInterval(s.checkTimer);
              resolve();
            } else if (s !== active || performance.now() > until) {
              clearInterval(s.checkTimer);
              reject(new Error('No active New York room found.'));
            }
          };
          s.checkTimer = setInterval(check, 75);
          check();
        });
      }
      if (s !== active) throw new Error('Connection canceled.');
      s.ready = true;
      const offline = () => fail(s, new Error('Browser offline.'));
      window.addEventListener('offline', offline);
      s.listeners.push(() => window.removeEventListener('offline', offline));
      window.addEventListener('pagehide', leave);
      s.listeners.push(() => window.removeEventListener('pagehide', leave));
      s.listeners.push(sdk.onPlayerJoin((player) => addPeer(s, player)));
      announce('online', {
        code: actualCode,
        roomCode: actualCode,
        playerId: s.me.id,
        count: 1,
        isHost: Boolean(sdk.isHost()),
        hostId: '',
        message: '',
        error: ''
      });
      for (const p of Object.values(sdk.getParticipants())) addPeer(s, p);
      initializeAuthority(s);
      clearTimeout(s.deadline);
      s.cancel = null;
      return status;
    }
    try {
      return await Promise.race([start(), canceled]);
    } catch (error) {
      if (active === s) fail(s, error);
      throw new Error(errorReason(error)[1]);
    }
  }
  function flush(s, now, reliable = false) {
    if (!s.pending || !s.ready || (!reliable && now - s.lastSend < SEND_INTERVAL)) return;
    const force = reliable || now - s.lastReliable >= 1000;
    s.me.setState(POSE_KEY, { room: s.token, seq: ++s.txSeq, p: s.pending }, force);
    s.pending = null;
    s.lastSend = now;
    if (force) s.lastReliable = now;
  }
  function sendPose(pose, reliable = false) {
    const s = active;
    if (!s?.ready) return false;
    const clean = cleanPose(pose);
    if (!clean) return false;
    s.pending = s.lastPose = clean;
    try {
      flush(s, performance.now(), reliable);
    } catch (error) {
      fail(s, error);
      return false;
    }
    return true;
  }
  function worldPacket(value) {
    return (
      typeof value === 'string' &&
      value.length > 0 &&
      value.length <= WORLD_LIMIT &&
      /^[A-Za-z0-9+/=_-]+$/.test(value)
    );
  }
  function flushWorld(s, now) {
    if (!s.pendingWorld || !s.sdk.isHost() || now - s.worldSend < WORLD_INTERVAL) return;
    const reliable = now - s.worldReliable >= 1000;
    s.me.setState(
      WORLD_KEY,
      { room: s.token, term: s.worldTerm, seq: ++s.worldTxSeq, data: s.pendingWorld },
      reliable
    );
    s.pendingWorld = null;
    s.worldSend = now;
    if (reliable) s.worldReliable = now;
  }
  function sendWorld(data) {
    const s = active;
    if (!s?.ready || !s.sdk.isHost() || !worldPacket(data)) return false;
    authority(s, s.me.id);
    s.pendingWorld = data;
    try {
      flushWorld(s, performance.now());
    } catch (error) {
      fail(s, error);
      return false;
    }
    return true;
  }
  function update() {
    const s = active;
    if (!s?.ready) return;
    try {
      const now = performance.now();
      if (now >= s.nextRoster) {
        s.nextRoster = now + 700;
        s.me = s.sdk.myPlayer() || s.me;
        for (const player of Object.values(s.sdk.getParticipants())) addPeer(s, player);
        observeAuthority(s);
        if (s.sdk.isHost()) authority(s, s.me.id);
        else confirmAuthority(s);
      }
      flush(s, now);
      flushWorld(s, now);
      for (const [id, peer] of s.peers) {
        if (id === s.hostId && !s.sdk.isHost()) {
          const world = peer.player.getState(WORLD_KEY);
          if (
            s.worldTerm &&
            world?.room === s.token &&
            world.term === s.worldTerm &&
            Number.isSafeInteger(world.seq) &&
            world.seq > s.worldRxSeq &&
            worldPacket(world.data)
          ) {
            s.worldRxSeq = world.seq;
            onWorld(id, world.data, world.seq);
          }
        }
        const message = peer.player.getState(POSE_KEY);
        if (!message || message.room !== s.token || !Number.isSafeInteger(message.seq) || message.seq <= peer.seq)
          continue;
        const pose = cleanPose(message.p);
        if (!pose) continue;
        peer.seq = message.seq;
        onSharedState(id, pose, message.seq);
      }
      summarize(s);
    } catch (error) {
      fail(s, error);
    }
  }
  return {
    create: () => connect(null),
    join: (code) => connect(code ?? ''),
    sendPose,
    sendWorld,
    update,
    leave,
    get status() {
      return status;
    }
  };
}
