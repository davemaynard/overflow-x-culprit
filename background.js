// Toolbar click -> inject (or re-inject) the content script into the active
// tab. The first injection installs and activates the scanner; every later
// injection toggles it. activeTab keeps this permission-light: nothing runs
// on any page until the user clicks the button there.

chrome.action.onClicked.addListener(async (tab) => {
  if (tab.id == null || !/^(https?|file):/.test(tab.url ?? '')) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content.js'],
    });
  } catch (err) {
    console.warn('overflow-x-culprit: cannot run on this page:', err.message);
  }
});

// The content script reports its culprit count; mirror it into the badge.
// count === null means the scanner was turned off.
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type !== 'overflow-x-culprit:badge' || sender.tab?.id == null) return;
  chrome.action.setBadgeText({
    tabId: sender.tab.id,
    text: msg.count == null ? '' : String(msg.count),
  });
  if (msg.count != null) {
    chrome.action.setBadgeBackgroundColor({ tabId: sender.tab.id, color: '#d93025' });
  }
});
