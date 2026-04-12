/**
 * AutoFilm Website Video Overlay Widget
 *
 * Dealers drop this script on their website to show a floating
 * personal video bubble (like a video chat widget).
 *
 * Usage:
 *   <script src="https://autofilm.io/autofilm-widget.js"
 *     data-rooftop="ROOFTOP_UUID"
 *     data-rep="REP_UUID"
 *     data-video="SHORT_CODE"
 *     data-position="bottom-right"
 *     data-delay="3"
 *     data-cta="Watch Video"
 *     data-color="#D94F00">
 *   </script>
 */

(function () {
  'use strict';

  const script = document.currentScript;
  if (!script) return;

  const config = {
    rooftopId: script.dataset.rooftop || '',
    repId: script.dataset.rep || '',
    videoCode: script.dataset.video || '',
    position: script.dataset.position || 'bottom-right',
    delay: parseInt(script.dataset.delay) || 3,
    cta: script.dataset.cta || 'Watch Video',
    color: script.dataset.color || '#D94F00',
    playerBase: 'https://autofilm.io/autofilm-player.html',
    apiBase: 'https://api.autofilm.io',
  };

  if (!config.videoCode) return;

  // Styles
  const style = document.createElement('style');
  style.textContent = `
    #af-widget-wrap {
      position: fixed;
      ${config.position.includes('bottom') ? 'bottom: 24px;' : 'top: 24px;'}
      ${config.position.includes('right') ? 'right: 24px;' : 'left: 24px;'}
      z-index: 99998;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      display: none;
    }
    #af-widget-wrap.visible { display: block; animation: afWidgetIn .4s ease both; }
    @keyframes afWidgetIn {
      from { opacity: 0; transform: translateY(20px) scale(.9); }
      to { opacity: 1; transform: none; }
    }

    #af-widget-bubble {
      width: 72px; height: 72px; border-radius: 50%;
      background: ${config.color};
      box-shadow: 0 6px 28px rgba(0,0,0,.35), 0 0 0 3px rgba(255,255,255,.1);
      cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      transition: transform .2s, box-shadow .2s;
      position: relative;
      overflow: hidden;
    }
    #af-widget-bubble:hover {
      transform: scale(1.08);
      box-shadow: 0 10px 36px rgba(0,0,0,.45), 0 0 0 3px rgba(255,255,255,.15);
    }
    #af-widget-bubble video {
      width: 100%; height: 100%; object-fit: cover;
      border-radius: 50%;
    }
    #af-widget-play {
      position: absolute; inset: 0;
      display: flex; align-items: center; justify-content: center;
      background: rgba(0,0,0,.25);
      border-radius: 50%;
      transition: background .2s;
    }
    #af-widget-bubble:hover #af-widget-play { background: rgba(0,0,0,.15); }
    #af-widget-play svg { width: 24px; height: 24px; }

    #af-widget-label {
      position: absolute;
      ${config.position.includes('right') ? 'right: 82px;' : 'left: 82px;'}
      top: 50%; transform: translateY(-50%);
      background: #fff;
      color: #1a1a1a;
      padding: 8px 16px;
      border-radius: 10px;
      font-size: 13px;
      font-weight: 700;
      white-space: nowrap;
      box-shadow: 0 4px 16px rgba(0,0,0,.12);
      animation: afLabelIn .3s ease .5s both;
    }
    @keyframes afLabelIn { from { opacity: 0; transform: translateY(-50%) translateX(10px); } to { opacity: 1; transform: translateY(-50%); } }
    #af-widget-label::after {
      content: '';
      position: absolute;
      top: 50%; transform: translateY(-50%);
      ${config.position.includes('right') ? 'right: -6px;' : 'left: -6px;'}
      width: 12px; height: 12px;
      background: #fff;
      transform: translateY(-50%) rotate(45deg);
      box-shadow: 2px -2px 4px rgba(0,0,0,.06);
    }

    #af-widget-close {
      position: absolute;
      top: -6px; right: -6px;
      width: 22px; height: 22px;
      border-radius: 50%;
      background: #333; border: 2px solid #fff;
      color: #fff; font-size: 11px; font-weight: 700;
      display: flex; align-items: center; justify-content: center;
      cursor: pointer;
      opacity: 0; transition: opacity .2s;
      z-index: 2;
    }
    #af-widget-wrap:hover #af-widget-close { opacity: 1; }

    #af-widget-expanded {
      display: none;
      width: 340px;
      background: #0a0a0d;
      border-radius: 16px;
      overflow: hidden;
      box-shadow: 0 20px 60px rgba(0,0,0,.5);
      border: 1px solid rgba(255,255,255,.09);
    }
    #af-widget-expanded.open { display: block; animation: afExpandIn .3s ease both; }
    @keyframes afExpandIn { from { opacity: 0; transform: scale(.95); } to { opacity: 1; transform: none; } }
    #af-widget-expanded video {
      width: 100%; display: block;
    }
    #af-widget-expanded .af-w-bar {
      padding: 12px 16px;
      display: flex; align-items: center; justify-content: space-between;
      background: #111116;
      border-top: 1px solid rgba(255,255,255,.05);
    }
    #af-widget-expanded .af-w-info {
      display: flex; align-items: center; gap: 8px;
    }
    #af-widget-expanded .af-w-name {
      font-size: 12px; font-weight: 700; color: rgba(255,255,255,.9);
    }
    #af-widget-expanded .af-w-title {
      font-size: 10px; color: rgba(255,255,255,.4); margin-top: 1px;
    }
    #af-widget-expanded .af-w-cta {
      padding: 8px 16px; border-radius: 8px;
      background: ${config.color}; color: #fff;
      font-size: 11px; font-weight: 700;
      border: none; cursor: pointer;
      font-family: inherit;
    }
    #af-widget-powered {
      text-align: center; padding: 8px;
      font-size: 9px; color: rgba(255,255,255,.2);
      background: #111116;
    }
    #af-widget-powered span { color: ${config.color}; font-weight: 700; }
  `;
  document.head.appendChild(style);

  // Widget HTML
  const wrap = document.createElement('div');
  wrap.id = 'af-widget-wrap';
  wrap.innerHTML = `
    <div id="af-widget-close" onclick="event.stopPropagation();this.parentElement.style.display='none'">&times;</div>
    <div id="af-widget-label">${escHtml(config.cta)}</div>
    <div id="af-widget-bubble" onclick="afWidgetToggle()">
      <div id="af-widget-play">
        <svg viewBox="0 0 24 24" fill="none">
          <path d="M8 5.5l11 6.5-11 6.5V5.5z" fill="#fff"/>
        </svg>
      </div>
    </div>
    <div id="af-widget-expanded">
      <video id="af-widget-video" playsinline controls></video>
      <div class="af-w-bar">
        <div class="af-w-info">
          <div>
            <div class="af-w-name" id="af-w-rep-name">Your Rep</div>
            <div class="af-w-title" id="af-w-rep-title">Sales Consultant</div>
          </div>
        </div>
        <button class="af-w-cta" onclick="afWidgetFullPlayer()">Full Player &rarr;</button>
      </div>
      <div id="af-widget-powered">Powered by <span>AutoFilm</span></div>
    </div>
  `;
  document.body.appendChild(wrap);

  // Show after delay
  setTimeout(() => {
    wrap.classList.add('visible');
  }, config.delay * 1000);

  // Toggle expanded/collapsed
  let expanded = false;
  window.afWidgetToggle = function () {
    const exp = document.getElementById('af-widget-expanded');
    const bubble = document.getElementById('af-widget-bubble');
    const label = document.getElementById('af-widget-label');

    if (expanded) {
      exp.classList.remove('open');
      bubble.style.display = 'flex';
      label.style.display = '';
      expanded = false;
    } else {
      exp.classList.add('open');
      bubble.style.display = 'none';
      label.style.display = 'none';
      expanded = true;

      // Start playing
      const vid = document.getElementById('af-widget-video');
      if (!vid.src) {
        // Load from Mux via short code lookup
        // For now use a placeholder — in production this gets the playback URL
        vid.src = `https://stream.mux.com/${config.videoCode}.m3u8`;
      }
      vid.play().catch(() => {});

      // Ping the watch endpoint
      fetch(`${config.apiBase}/v/${config.videoCode}/ping?pct=0`).catch(() => {});
    }
  };

  window.afWidgetFullPlayer = function () {
    const url = `${config.playerBase}?code=${config.videoCode}`;
    window.open(url, '_blank');
  };

  function escHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
})();
