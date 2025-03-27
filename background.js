// Listen for messages from the extension
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "openSyncedTabs") {
    // Add a query parameter to force a fresh load
    chrome.tabs.create({
      url: "chrome://history/syncedTabs?refresh=" + Date.now(),
    })
  }
})

chrome.runtime.onInstalled.addListener(() => {
  console.log("Enhanced History Viewer installed")
})

