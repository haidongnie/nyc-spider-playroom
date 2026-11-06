// Only the local driver's vehicle starts the radio. Keep the media URL off the
// initial loading path, including on a restored save, until playback is possible.
export function createVehicleRadio(sound) {
  let mode = 'person', ready = false, player = null, attempt = null;
  function sync() {
    if (!ready || mode === 'person' || !sound.enabled || document.hidden) {
      if (player) {
        player.pause();
        if (mode === 'person' && player.readyState > 0) player.currentTime = 0;
      }
      return;
    }
    if (!player) {
      player = new Audio();
      player.id = 'vehicle-radio';
      player.preload = 'none';
      player.loop = true;
      player.volume = 0.40;
      player.src = new URL('../audio/empire-state-of-mind.m4a', import.meta.url).href;
      document.body.append(player);
    }
    if (player.paused && !attempt) {
      // Browsers may require a fresh gesture after a saved game or background tab.
      attempt = Promise.resolve(player.play()).catch(() => {}).finally(() => { attempt = null; });
    }
  }
  document.addEventListener('pointerup', sync);
  document.addEventListener('keydown', sync);
  document.addEventListener('visibilitychange', sync);
  window.addEventListener('pageshow', sync);
  window.addEventListener('pagehide', () => player?.pause());
  window.addEventListener('nyc-playable', () => { ready = true; sync(); }, {once:true});
  return { sync, setMode(next) { mode = next; sync(); } };
}
