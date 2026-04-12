/**
 * AutoFilm Website Video Overlay Widget v2
 *
 * A premium floating video bubble for dealer websites.
 * Dealers drop a single script tag and get:
 *  - Animated circular bubble with rep's face
 *  - Expandable player with branded wrapper
 *  - "Call Now" button for live video call (WebRTC)
 *  - Smart page targeting (homepage, VDP, SRP)
 *  - Watch tracking + lead capture
 *  - Mobile responsive
 *  - Dismissible with cookie memory (won't re-annoy)
 *
 * Usage:
 *   <script src="https://autofilm.io/autofilm-widget.js"
 *     data-rooftop="ROOFTOP_UUID"
 *     data-rep="REP_UUID"
 *     data-video="SHORT_CODE"
 *     data-playback="MUX_PLAYBACK_ID"
 *     data-rep-name="Kenny"
 *     data-rep-title="Sales Consultant"
 *     data-rep-photo="https://..."
 *     data-dealer="Harte Hyundai"
 *     data-position="bottom-right"
 *     data-delay="3"
 *     data-cta="Watch Video"
 *     data-color="#D94F00"
 *     data-pages="*"
 *     data-live-call="true">
 *   </script>
 */

(function () {
  'use strict';

  const script = document.currentScript;
  if (!script) return;

  const C = {
    rooftopId:   script.dataset.rooftop || '',
    repId:       script.dataset.rep || '',
    videoCode:   script.dataset.video || '',
    playbackId:  script.dataset.playback || '',
    repName:     script.dataset.repName || 'Your Rep',
    repTitle:    script.dataset.repTitle || 'Sales Consultant',
    repPhoto:    script.dataset.repPhoto || '',
    dealer:      script.dataset.dealer || '',
    position:    script.dataset.position || 'bottom-right',
    delay:       parseInt(script.dataset.delay) || 3,
    cta:         script.dataset.cta || 'Watch My Video',
    color:       script.dataset.color || '#D94F00',
    pages:       script.dataset.pages || '*',
    liveCall:    script.dataset.liveCall === 'true',
    apiBase:     'https://api.autofilm.io',
    playerBase:  'https://autofilm.io/autofilm-player.html',
  };

  if (!C.videoCode && !C.playbackId) return;

  // Page matching
  if (C.pages !== '*') {
    const patterns = C.pages.split(',').map(p => p.trim());
    const path = location.pathname;
    const matched = patterns.some(p => {
      if (p.endsWith('*')) return path.startsWith(p.slice(0, -1));
      return path === p;
    });
    if (!matched) return;
  }

  // Check if user dismissed recently
  const dismissed = localStorage.getItem('af_widget_dismissed');
  if (dismissed && Date.now() - parseInt(dismissed) < 86400000) return;

  // Thumbnail URL from Mux
  const thumbUrl = C.playbackId
    ? `https://image.mux.com/${C.playbackId}/animated.gif?width=160&fps=10&start=1&end=3`
    : C.repPhoto || '';
  const staticThumb = C.playbackId
    ? `https://image.mux.com/${C.playbackId}/thumbnail.jpg?width=160&height=160&fit_mode=smartcrop`
    : C.repPhoto || '';

  // Color helpers
  const colorRgb = hexToRgb(C.color);
  const colorAlpha = (a) => `rgba(${colorRgb.r},${colorRgb.g},${colorRgb.b},${a})`;

  // ── STYLES ──────────────────────────────────────────────────
  const css = document.createElement('style');
  css.textContent = `
    @keyframes afIn{from{opacity:0;transform:translateY(24px) scale(.85)}to{opacity:1;transform:none}}
    @keyframes afPulse{0%,100%{box-shadow:0 0 0 0 ${colorAlpha(.4)}}70%{box-shadow:0 0 0 12px ${colorAlpha(0)}}}
    @keyframes afExpand{from{opacity:0;transform:scale(.92) translateY(12px)}to{opacity:1;transform:none}}
    @keyframes afLabelSlide{from{opacity:0;transform:translateY(-50%) translateX(${C.position.includes('right') ? '12px' : '-12px'})}to{opacity:1;transform:translateY(-50%)}}

    #af-w{position:fixed;${C.position.includes('bottom')?'bottom:20px':'top:20px'};${C.position.includes('right')?'right:20px':'left:20px'};z-index:99999;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;display:none}
    #af-w.on{display:block;animation:afIn .45s cubic-bezier(.34,1.56,.64,1) both}

    /* ── BUBBLE ─────────────────────── */
    #af-bub{width:68px;height:68px;border-radius:50%;cursor:pointer;position:relative;transition:transform .22s;animation:afPulse 2.5s ease infinite}
    #af-bub:hover{transform:scale(1.1)}
    #af-bub-bg{position:absolute;inset:0;border-radius:50%;border:3px solid ${C.color};overflow:hidden;background:#111}
    #af-bub-bg img{width:100%;height:100%;object-fit:cover;display:block}
    #af-bub-play{position:absolute;inset:0;border-radius:50%;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.2);transition:background .2s}
    #af-bub:hover #af-bub-play{background:rgba(0,0,0,.08)}
    #af-bub-play svg{width:22px;height:22px;filter:drop-shadow(0 1px 3px rgba(0,0,0,.4))}
    #af-bub-dot{position:absolute;top:2px;right:2px;width:14px;height:14px;border-radius:50%;background:#22c55e;border:2.5px solid #0a0a0d;z-index:2}

    /* ── DISMISS ────────────────────── */
    #af-close{position:absolute;top:-5px;${C.position.includes('right')?'left:-5px':'right:-5px'};width:20px;height:20px;border-radius:50%;background:#333;border:2px solid rgba(255,255,255,.15);color:#fff;font-size:10px;display:none;align-items:center;justify-content:center;cursor:pointer;z-index:3;line-height:1}
    #af-w:hover #af-close{display:flex}

    /* ── LABEL ──────────────────────── */
    #af-label{position:absolute;top:50%;${C.position.includes('right')?'right:78px':'left:78px'};transform:translateY(-50%);background:#fff;color:#1a1a1a;padding:9px 16px;border-radius:12px;font-size:13px;font-weight:600;white-space:nowrap;box-shadow:0 4px 20px rgba(0,0,0,.12);animation:afLabelSlide .35s ease .6s both;line-height:1.3}
    #af-label::after{content:'';position:absolute;top:50%;${C.position.includes('right')?'right:-5px':'left:-5px'};transform:translateY(-50%) rotate(45deg);width:10px;height:10px;background:#fff;box-shadow:2px -2px 4px rgba(0,0,0,.06)}
    #af-label small{display:block;font-size:10px;color:#888;font-weight:400;margin-top:2px}

    /* ── EXPANDED PLAYER ───────────── */
    #af-exp{display:none;width:360px;max-width:calc(100vw - 40px);border-radius:16px;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,.55);border:1px solid rgba(255,255,255,.09);background:#0a0a0d}
    #af-exp.on{display:block;animation:afExpand .3s ease both}
    #af-exp-hdr{display:flex;align-items:center;gap:10px;padding:12px 14px;background:#111116;border-bottom:1px solid rgba(255,255,255,.06)}
    #af-exp-av{width:36px;height:36px;border-radius:50%;border:2px solid ${C.color};overflow:hidden;flex-shrink:0}
    #af-exp-av img{width:100%;height:100%;object-fit:cover}
    #af-exp-info{flex:1;min-width:0}
    #af-exp-name{font-size:13px;font-weight:700;color:rgba(255,255,255,.92)}
    #af-exp-title{font-size:10px;color:rgba(255,255,255,.4)}
    #af-exp-x{width:28px;height:28px;border-radius:50%;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.09);color:rgba(255,255,255,.5);font-size:13px;display:flex;align-items:center;justify-content:center;cursor:pointer;flex-shrink:0}
    #af-exp-x:hover{background:rgba(255,255,255,.1);color:#fff}
    #af-vid-wrap{position:relative;background:#000;aspect-ratio:16/9}
    #af-vid{width:100%;height:100%;display:block}
    #af-exp-bar{display:flex;gap:6px;padding:10px 14px;background:#111116;border-top:1px solid rgba(255,255,255,.06)}
    .af-exp-btn{flex:1;padding:9px;border-radius:8px;font-size:11px;font-weight:700;text-align:center;cursor:pointer;border:none;font-family:inherit;transition:all .14s}
    .af-btn-full{background:${C.color};color:#fff;box-shadow:0 2px 10px ${colorAlpha(.3)}}
    .af-btn-full:hover{filter:brightness(1.1);transform:translateY(-1px)}
    .af-btn-call{background:rgba(34,197,94,.12);border:1px solid rgba(34,197,94,.25);color:#22c55e}
    .af-btn-call:hover{background:rgba(34,197,94,.2)}
    .af-btn-trade{background:rgba(56,189,248,.1);border:1px solid rgba(56,189,248,.2);color:#38bdf8}
    .af-btn-trade:hover{background:rgba(56,189,248,.18)}
    #af-pwr{text-align:center;padding:6px;font-size:9px;color:rgba(255,255,255,.18);background:#111116}
    #af-pwr span{color:${C.color};font-weight:700}

    @media(max-width:480px){
      #af-exp{width:calc(100vw - 32px)}
      #af-label{display:none !important}
      #af-bub{width:58px;height:58px}
    }
  `;
  document.head.appendChild(css);

  // ── HTML ────────────────────────────────────────────────────
  const wrap = document.createElement('div');
  wrap.id = 'af-w';
  wrap.innerHTML = `
    <div id="af-close" onclick="event.stopPropagation();afWDismiss()">&times;</div>

    <div id="af-label" onclick="afWExpand()">
      ${esc(C.cta)}
      <small>${esc(C.repName)} &middot; ${esc(C.dealer)}</small>
    </div>

    <div id="af-bub" onclick="afWExpand()">
      <div id="af-bub-bg">
        <img src="${esc(staticThumb)}" alt="${esc(C.repName)}" loading="lazy">
      </div>
      <div id="af-bub-play">
        <svg viewBox="0 0 24 24" fill="none"><path d="M8 5.5l11 6.5-11 6.5V5.5z" fill="#fff"/></svg>
      </div>
      <div id="af-bub-dot"></div>
    </div>

    <div id="af-exp">
      <div id="af-exp-hdr">
        <div id="af-exp-av"><img src="${esc(staticThumb)}" alt=""></div>
        <div id="af-exp-info">
          <div id="af-exp-name">${esc(C.repName)}</div>
          <div id="af-exp-title">${esc(C.repTitle)} &middot; ${esc(C.dealer)}</div>
        </div>
        <div id="af-exp-x" onclick="afWCollapse()">&times;</div>
      </div>
      <div id="af-vid-wrap">
        <video id="af-vid" playsinline preload="none" poster="${esc(staticThumb)}"></video>
      </div>
      <div id="af-exp-bar">
        <button class="af-exp-btn af-btn-full" onclick="afWFullPlayer()">Full Player &rarr;</button>
        ${C.liveCall ? '<button class="af-exp-btn af-btn-call" onclick="afWLiveCall()">📞 Live Call</button>' : ''}
      </div>
      <div id="af-pwr">Powered by <span>AutoFilm</span></div>
    </div>
  `;
  document.body.appendChild(wrap);

  let expanded = false;
  let watchPinged = false;

  // Show after delay
  setTimeout(() => wrap.classList.add('on'), C.delay * 1000);

  // ── ACTIONS ─────────────────────────────────────────────────

  window.afWExpand = function () {
    if (expanded) return;
    expanded = true;
    document.getElementById('af-bub').style.display = 'none';
    document.getElementById('af-label').style.display = 'none';
    document.getElementById('af-exp').classList.add('on');

    const vid = document.getElementById('af-vid');
    if (!vid.src && C.playbackId) {
      // Use Mux HLS stream
      vid.src = `https://stream.mux.com/${C.playbackId}.m3u8`;
    }
    vid.play().catch(() => {});

    // Ping watch start
    if (!watchPinged && C.videoCode) {
      fetch(`${C.apiBase}/v/${C.videoCode}/ping?pct=0`).catch(() => {});
      watchPinged = true;
    }

    // Track watch progress
    vid.addEventListener('timeupdate', function onTime() {
      if (!vid.duration) return;
      const pct = Math.round((vid.currentTime / vid.duration) * 100);
      if (pct > 0 && pct % 25 === 0 && C.videoCode) {
        fetch(`${C.apiBase}/v/${C.videoCode}/ping?pct=${pct}`).catch(() => {});
      }
    });
  };

  window.afWCollapse = function () {
    expanded = false;
    document.getElementById('af-exp').classList.remove('on');
    document.getElementById('af-bub').style.display = '';
    document.getElementById('af-label').style.display = '';
    const vid = document.getElementById('af-vid');
    vid.pause();
  };

  window.afWDismiss = function () {
    wrap.style.display = 'none';
    localStorage.setItem('af_widget_dismissed', String(Date.now()));
  };

  window.afWFullPlayer = function () {
    const url = `${C.playerBase}?code=${C.videoCode}&rep=${encodeURIComponent(C.repName)}&dealer=${encodeURIComponent(C.dealer)}`;
    window.open(url, '_blank');
  };

  window.afWLiveCall = function () {
    // Open live video call in a new window
    const url = `https://autofilm.io/autofilm-call.html?rep_id=${C.repId}&rooftop_id=${C.rooftopId}&caller=website_widget`;
    window.open(url, 'af-call', 'width=480,height=680,scrollbars=no');
  };

  // ── HELPERS ─────────────────────────────────────────────────
  function esc(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function hexToRgb(hex) {
    hex = hex.replace('#', '');
    return {
      r: parseInt(hex.substring(0, 2), 16) || 0,
      g: parseInt(hex.substring(2, 4), 16) || 0,
      b: parseInt(hex.substring(4, 6), 16) || 0,
    };
  }
})();
