/**
 * AutoFilm Chrome Extension — Content Script
 *
 * Injected into CRM pages (Elead, VinSolutions, DealerSocket)
 * and email clients (Gmail, Outlook).
 *
 * Adds an "AutoFilm" button to compose areas and CRM action bars.
 */

(function () {
  'use strict';

  const AUTOFILM_BTN_CLASS = 'autofilm-ext-btn';

  // Avoid double-injection
  if (document.querySelector('.' + AUTOFILM_BTN_CLASS)) return;

  /**
   * Create the floating AutoFilm action button.
   */
  function createButton() {
    const btn = document.createElement('div');
    btn.className = AUTOFILM_BTN_CLASS;
    btn.innerHTML = `
      <div style="
        position:fixed;bottom:24px;right:24px;z-index:99999;
        display:flex;align-items:center;gap:8px;
        padding:12px 18px;border-radius:12px;
        background:#D94F00;color:#fff;
        font-family:-apple-system,BlinkMacSystemFont,sans-serif;
        font-size:13px;font-weight:700;
        cursor:pointer;
        box-shadow:0 6px 24px rgba(217,79,0,.4);
        transition:all .2s;
        user-select:none;
      " onmouseover="this.style.transform='translateY(-2px)';this.style.boxShadow='0 10px 32px rgba(217,79,0,.5)'"
         onmouseout="this.style.transform='';this.style.boxShadow='0 6px 24px rgba(217,79,0,.4)'"
      >
        <svg width="16" height="16" viewBox="0 0 14 14" fill="none" style="flex-shrink:0">
          <path d="M1.5 10.5L7 2 12.5 10.5" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        Record AutoFilm
      </div>
    `;

    btn.addEventListener('click', () => {
      chrome.storage.local.get(['af_rep_id', 'af_rooftop_id'], (data) => {
        // Try to detect customer info from the CRM page
        const customerName = detectCustomerName();
        const vehicle = detectVehicle();

        const url = `https://autofilm.io/autofilm-record.html?rep_id=${data.af_rep_id || ''}&rooftop_id=${data.af_rooftop_id || ''}&customer_name=${encodeURIComponent(customerName)}&vehicle=${encodeURIComponent(vehicle)}`;
        window.open(url, '_blank', 'width=480,height=720');
      });
    });

    document.body.appendChild(btn);
  }

  /**
   * Detect customer name from common CRM DOM patterns.
   */
  function detectCustomerName() {
    const selectors = [
      // Elead
      '[data-field="customer_name"]',
      '.customer-name',
      '#customerName',
      // VinSolutions
      '.contact-name',
      '[data-bind*="ContactName"]',
      // DealerSocket
      '.ds-customer-name',
      // Gmail - To field
      '.vR .vN',
      // Outlook
      '[aria-label*="To"]',
      // Generic
      'h1', 'h2',
    ];

    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el?.textContent?.trim()) {
        const text = el.textContent.trim();
        // Basic validation: looks like a name (2+ words, no super long strings)
        if (text.split(' ').length >= 2 && text.length < 60) {
          return text;
        }
      }
    }
    return '';
  }

  /**
   * Detect vehicle info from CRM page.
   */
  function detectVehicle() {
    const selectors = [
      '[data-field="vehicle"]',
      '.vehicle-info',
      '.stock-vehicle',
      '[data-bind*="Vehicle"]',
      '.ds-vehicle-name',
    ];

    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el?.textContent?.trim()) {
        return el.textContent.trim();
      }
    }
    return '';
  }

  /**
   * Listen for messages from the popup.
   */
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === 'insertVideoLink') {
      insertLink();
    }
  });

  /**
   * Insert a video link into the active compose area.
   */
  function insertLink() {
    // Find active text input or contenteditable
    const activeEl = document.activeElement;
    const composeAreas = [
      // Gmail compose
      '.Am.Al.editable',
      '[role="textbox"][contenteditable="true"]',
      // Outlook compose
      '[aria-label="Message body"]',
      // CRM text areas
      'textarea:focus',
      'input[type="text"]:focus',
    ];

    let target = null;

    if (activeEl && (activeEl.isContentEditable || activeEl.tagName === 'TEXTAREA' || activeEl.tagName === 'INPUT')) {
      target = activeEl;
    } else {
      for (const sel of composeAreas) {
        const el = document.querySelector(sel);
        if (el) { target = el; break; }
      }
    }

    if (target) {
      const placeholder = 'https://links.autofilm.io/v/YOUR_CODE';
      if (target.isContentEditable) {
        document.execCommand('insertText', false, placeholder);
      } else {
        const start = target.selectionStart || target.value.length;
        target.value = target.value.slice(0, start) + placeholder + target.value.slice(start);
      }
    }
  }

  // Initialize
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', createButton);
  } else {
    createButton();
  }
})();
