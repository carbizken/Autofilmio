/**
 * AutoFilm Chrome Extension — Background Service Worker
 *
 * Handles:
 * - Push notification relay from AutoFilm API
 * - Badge count for unwatched video notifications
 * - Context menu integration
 */

// Listen for installation
chrome.runtime.onInstalled.addListener(() => {
  console.log('[AutoFilm] Extension installed');

  // Create context menu item
  chrome.contextMenus?.create({
    id: 'autofilm-record',
    title: 'Record AutoFilm Video',
    contexts: ['page', 'selection'],
  });
});

// Context menu handler
chrome.contextMenus?.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'autofilm-record') {
    chrome.storage.local.get(['af_rep_id', 'af_rooftop_id'], (data) => {
      const url = `https://autofilm.io/autofilm-record.html?rep_id=${data.af_rep_id || ''}&rooftop_id=${data.af_rooftop_id || ''}`;
      chrome.tabs.create({ url });
    });
  }
});

// Listen for messages from content scripts
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'videoWatched') {
    // Show notification
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon-128.png',
      title: 'Video Watched!',
      message: `${msg.customerName} watched ${msg.watchPct}% of your video`,
    });
  }
});
