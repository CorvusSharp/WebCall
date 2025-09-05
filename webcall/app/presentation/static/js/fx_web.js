// fx_web.js - Futuristic spiderweb / particle connection cursor effect
// Lightweight, no external deps. Uses off-main scheduling via requestAnimationFrame.
// Can be disabled by adding data-no-webfx to <body>.

(function(){
  if (typeof window === 'undefined') return;
  const body = document.body;
  if (!body || body.hasAttribute('data-no-webfx')) return;

  const canvas = document.createElement('canvas');
  canvas.id = 'fx-web-canvas';
  canvas.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:0;mix-blend-mode:screen;';
  document.body.appendChild(canvas);
  const ctx = canvas.getContext('2d');

  let w = canvas.width = window.innerWidth;
  let h = canvas.height = window.innerHeight;
  window.addEventListener('resize', ()=>{ w = canvas.width = window.innerWidth; h = canvas.height = window.innerHeight; });

  // Config
  const MAX_POINTS = 160;              // base particle count
  const MOUSE_PULL = 0.12;             // attraction toward cursor
  const SPRING = 0.025;                // inter-particle soft spring when close
  const FRICTION = 0.96;               // velocity damping
  const LINK_DIST = 170;               // base distance for connecting lines
  const CURSOR_FIELD = 260;            // radius of strong cursor influence
  const GLOW_COLOR_1 = 'rgba(124,58,237,'; // violet base
  const GLOW_COLOR_2 = 'rgba(6,182,212,';  // cyan base

  const mouse = { x: w/2, y: h/2, moving:false };
  let lastMove = performance.now();
  window.addEventListener('pointermove', e=>{ mouse.x = e.clientX; mouse.y = e.clientY; mouse.moving = true; lastMove = performance.now(); });
  window.addEventListener('pointerdown', e=>{ mouse.x = e.clientX; mouse.y = e.clientY; burst(mouse.x, mouse.y); });

  // Particle model
  class P{ constructor(){ this.reset(); } reset(){ this.x=Math.random()*w; this.y=Math.random()*h; this.vx=(Math.random()*2-1)*0.2; this.vy=(Math.random()*2-1)*0.2; this.fx=0; this.fy=0; this.sz=1+Math.random()*2; this.life= 4000 + Math.random()*6000; this.birth=performance.now(); } step(dt){ // mild wander
      const age = performance.now() - this.birth; if (age>this.life){ this.reset(); return; }
      // Attraction to cursor
      const dx = mouse.x - this.x; const dy = mouse.y - this.y; const dist = Math.hypot(dx,dy)||1;
      if (dist < CURSOR_FIELD){ const m = (1 - dist/CURSOR_FIELD); this.vx += dx/dist * MOUSE_PULL * m; this.vy += dy/dist * MOUSE_PULL * m; }
      // Soft confinement
      if (this.x<0||this.x>w) this.vx*=-1, this.x=Math.max(0,Math.min(w,this.x));
      if (this.y<0||this.y>h) this.vy*=-1, this.y=Math.max(0,Math.min(h,this.y));
      // Velocity & position
      this.vx*=FRICTION; this.vy*=FRICTION; this.x+=this.vx; this.y+=this.vy; }
  }

  const pts = Array.from({length:MAX_POINTS}, ()=> new P());

  function burst(x,y){
    for(let i=0;i<14;i++){
      const p = pts[(Math.random()*pts.length)|0];
      const a = Math.random()*Math.PI*2; const s = 3+Math.random()*4;
      p.vx += Math.cos(a)*s; p.vy += Math.sin(a)*s;
    }
  }

  // Connection pass
  function draw(){
    ctx.clearRect(0,0,w,h);
    // subtle background haze gradient
    const g = ctx.createRadialGradient(mouse.x, mouse.y, 40, mouse.x, mouse.y, Math.min(w,h)*0.8);
    g.addColorStop(0, 'rgba(124,58,237,0.05)');
    g.addColorStop(1, 'rgba(6,182,212,0.02)');
    ctx.fillStyle = g; ctx.fillRect(0,0,w,h);

    // Update + draw particles
    for (const p of pts){ p.step(); }

    // Connections (optimized by only checking next few)
    for (let i=0;i<pts.length;i++){
      const a = pts[i];
      for (let j=i+1;j<pts.length;j++){
        const b = pts[j];
        const dx = a.x-b.x; const dy = a.y-b.y; const d2 = dx*dx+dy*dy;
        if (d2 < LINK_DIST*LINK_DIST){
          const d = Math.sqrt(d2);
          // spring force
          const f = (1 - d/LINK_DIST) * SPRING;
          const nx = dx/d || 0; const ny = dy/d || 0;
          a.vx += nx * f; a.vy += ny * f; b.vx -= nx * f; b.vy -= ny * f;
          const alpha = 0.12 * (1 - d/LINK_DIST);
          const mix = ( (a.x+b.x)*0.5 / w );
          ctx.strokeStyle = (mix<0.5?GLOW_COLOR_1:GLOW_COLOR_2) + alpha + ')';
          ctx.lineWidth = 1.1;
          ctx.beginPath(); ctx.moveTo(a.x,a.y); ctx.lineTo(b.x,b.y); ctx.stroke();
          if (alpha>0.05){
            // luminous midpoint node
            const mx = (a.x+b.x)/2, my=(a.y+b.y)/2;
            const r = 2 + 8*alpha;
            const rg = ctx.createRadialGradient(mx,my,0,mx,my,r);
            rg.addColorStop(0,(mix<0.5?GLOW_COLOR_1:GLOW_COLOR_2)+ (0.8*alpha)+')');
            rg.addColorStop(1,'rgba(0,0,0,0)');
            ctx.fillStyle = rg; ctx.beginPath(); ctx.arc(mx,my,r,0,Math.PI*2); ctx.fill();
          }
        }
      }
    }

    // Foreground particles
    for (const p of pts){
      const ageRatio = (performance.now()-p.birth)/p.life;
      const a = 0.25 * (1 - ageRatio);
      ctx.fillStyle = (p.x/w <0.5?GLOW_COLOR_1:GLOW_COLOR_2) + a + ')';
      ctx.beginPath(); ctx.arc(p.x,p.y,p.sz,0,Math.PI*2); ctx.fill();
    }

    // fade mouse.moving flag
    if (performance.now()-lastMove > 1400) mouse.moving=false;
    requestAnimationFrame(draw);
  }
  requestAnimationFrame(draw);
})();
