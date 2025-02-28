// Listen for messages from the extension
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "openSyncedTabs") {
    // Remove the history override temporarily
    chrome.tabs.create({ url: "chrome://history/syncedTabs" }, (tab) => {
      // After a short delay, reload the tab to ensure it loads the native UI
      setTimeout(() => {
        chrome.tabs.reload(tab.id)
      }, 100)
    })
  }
})

chrome.runtime.onInstalled.addListener(() => {
  console.log("Enhanced History Viewer installed")
})

