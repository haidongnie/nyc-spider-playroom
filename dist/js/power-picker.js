// The selected ability is local to this player; the room transmits its ID with the pose.
export function createPowerPicker(portrait, controllers, {onChoose, onToggle}) {
  const zh = /^zh/i.test(navigator.language);
  const words = zh
    ? {title:'选择超能力', spider:'蜘蛛侠', flash:'闪电侠', web:'R · 射丝摆荡', speed:'10 倍跑速 · 闪电残影', on:'变身', off:'变回便装', close:'关闭'}
    : {title:'Choose a power', spider:'Spider-Man', flash:'The Flash', web:'R · Web swing', speed:'10× speed · Lightning trail', on:'Suit up', off:'Civilian clothes', close:'Close'};
  const dialog = document.createElement('dialog');
  dialog.id = 'power-picker';
  dialog.setAttribute('aria-labelledby','power-heading');
  const bolt = '<svg viewBox="0 0 48 48" aria-hidden="true"><circle cx="24" cy="24" r="20" fill="#fff2d9"/><path fill="#d79b14" d="m31 4-15 18h9l-9 22 21-26h-11z"/></svg>';
  dialog.innerHTML = '<header><strong id="power-heading"></strong><button type="button" data-close>×</button></header><div class="power-choices"></div><button type="button" data-transform></button>';
  dialog.querySelector('strong').textContent = words.title;
  const close = dialog.querySelector('[data-close]');
  close.setAttribute('aria-label',words.close);
  close.onclick = () => dialog.close();
  const spiderPortrait = portrait.querySelector('.portrait-suited').cloneNode();
  spiderPortrait.removeAttribute('class');
  const flashPortrait = document.createElement('span');
  flashPortrait.className='portrait-flash'; flashPortrait.innerHTML=bolt; portrait.append(flashPortrait);
  function returnToStreet() {
    dialog.close();
    document.querySelector('#canvas-container canvas')?.focus({preventScroll:true});
  }
  for (const [id,detail] of [['spider',words.web],['flash',words.speed]]) {
    const button = document.createElement('button');
    button.type='button'; button.dataset.powerChoice=id;
    const icon = document.createElement('span');
    icon.className = 'power-icon '+id;
    if (id==='spider') icon.append(spiderPortrait); else icon.innerHTML=bolt;
    const caption=document.createElement('span'), title=document.createElement('b'), hint=document.createElement('small');
    title.textContent=words[id]; hint.textContent=detail; caption.append(title,hint); button.append(icon,caption);
    button.onclick = () => { onChoose(id); returnToStreet(); };
    dialog.querySelector('.power-choices').append(button);
  }
  const toggle = dialog.querySelector('[data-transform]');
  toggle.onclick=()=>{onToggle();returnToStreet();};
  dialog.addEventListener('keydown',e=>{
    e.stopPropagation();
    if(e.code==='KeyQ' && !e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey) {e.preventDefault();toggle.click();}
  });
  dialog.addEventListener('keyup',e=>e.stopPropagation());
  dialog.addEventListener('click',e=>{if(e.target===dialog)dialog.close();});
  document.body.append(dialog);
  portrait.setAttribute('aria-haspopup','dialog');
  portrait.setAttribute('aria-controls',dialog.id);
  portrait.onclick=()=>{ controllers.resetInput(); sync(); if(!dialog.open) dialog.showModal(); };
  function sync() {
    const selected=controllers.selectedPower;
    portrait.dataset.power=selected;
    portrait.title=words.title+' · '+words[selected]+' (Q)';
    portrait.setAttribute('aria-label',portrait.title);
    for(const b of dialog.querySelectorAll('[data-power-choice]')) b.setAttribute('aria-pressed',String(selected===b.dataset.powerChoice));
    toggle.textContent=(controllers.spiderSuited?words.off:words.on)+'  ·  Q';
  }
  sync();
  return {sync};
}
