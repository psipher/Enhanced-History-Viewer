let lastFetchedTime = new Date().getTime()
let isLoading = false
const ITEMS_PER_PAGE = 50
let searchQuery = ""
let searchTimeout
const currentView = "history"

function formatDate(date) {
  const now = new Date()
  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)

  if (date.toDateString() === now.toDateString()) {
    return "Today"
  } else if (date.toDateString() === yesterday.toDateString()) {
    return "Yesterday"
  } else {
    return date.toLocaleDateString(undefined, {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    })
  }
}

function formatTime(date) {
  return date.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  })
}

function getFaviconUrl(url) {
  return `https://www.google.com/s2/favicons?domain=${new URL(url).hostname}&sz=32`
}

function createHistoryItem(item) {
  const div = document.createElement("div")
  div.className = "history-item"

  // Add click handler to open URL in new tab
  div.addEventListener("click", () => {
    window.open(item.url, "_blank")
  })

  const favicon = document.createElement("img")
  favicon.className = "favicon"
  favicon.src = getFaviconUrl(item.url)
  favicon.onerror = () => {
    favicon.src =
      'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="gray"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z"/></svg>'
  }

  const details = document.createElement("div")
  details.className = "item-details"

  const title = document.createElement("div")
  title.className = "title"
  title.textContent = item.title || new URL(item.url).hostname

  const url = document.createElement("div")
  url.className = "url"
  url.textContent = item.url

  const time = document.createElement("div")
  time.className = "time"
  time.textContent = formatTime(new Date(item.lastVisitTime))

  const menuButton = document.createElement("div")
  menuButton.className = "menu-button"
  menuButton.innerHTML = `
    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z"></path>
    </svg>
  `

  details.appendChild(title)
  details.appendChild(url)
  div.appendChild(favicon)
  div.appendChild(details)
  div.appendChild(time)
  div.appendChild(menuButton)

  return div
}

function groupHistoryByDate(items) {
  const groups = {}

  items.forEach((item) => {
    const date = new Date(item.lastVisitTime)
    const dateString = formatDate(date)

    if (!groups[dateString]) {
      groups[dateString] = []
    }
    groups[dateString].push(item)
  })

  return groups
}

function renderHistoryGroup(date, items, container) {
  const group = document.createElement("div")
  group.className = "date-group"

  const header = document.createElement("div")
  header.className = "date-header"
  header.textContent = date

  group.appendChild(header)

  items.forEach((item) => {
    group.appendChild(createHistoryItem(item))
  })

  container.appendChild(group)
}

function loadMoreHistory() {
  if (isLoading) return

  isLoading = true
  const loading = document.getElementById("loading")
  loading.style.display = "block"

  //The chrome variable was undeclared.  This line fixes that.
  chrome.history.search(
    {
      text: searchQuery,
      startTime: 0,
      endTime: lastFetchedTime,
      maxResults: ITEMS_PER_PAGE,
    },
    (items) => {
      if (chrome.runtime.lastError) {
        console.error(chrome.runtime.lastError)
        loading.style.display = "none"
        isLoading = false
        return
      }

      const content = document.getElementById("content")

      if (items && items.length > 0) {
        const groups = groupHistoryByDate(items)

        Object.entries(groups).forEach(([date, dateItems]) => {
          renderHistoryGroup(date, dateItems, content)
        })

        lastFetchedTime = items[items.length - 1].lastVisitTime - 1
      } else if (content.children.length === 0) {
        const noResults = document.createElement("div")
        noResults.className = "no-results"
        noResults.textContent = searchQuery ? `No search results for "${searchQuery}"` : "No history items found"
        content.appendChild(noResults)
      }

      isLoading = false
      loading.style.display = "none"
    },
  )
}

function performSearch() {
  const searchInput = document.querySelector(".search-bar input")
  searchQuery = searchInput.value.trim().toLowerCase()

  // Reset the time to current to start a fresh search
  lastFetchedTime = new Date().getTime()

  // Clear existing content
  const content = document.getElementById("content")
  content.innerHTML = ""

  // Show loading indicator
  const loading = document.getElementById("loading")
  loading.style.display = "block"

  // Load history with the search query
  loadMoreHistory()
}

function debounceSearch(func, delay) {
  clearTimeout(searchTimeout)
  searchTimeout = setTimeout(func, delay)
}

document.addEventListener("DOMContentLoaded", () => {
  // Add search functionality
  const searchInput = document.querySelector(".search-bar input")

  searchInput.addEventListener("input", () => {
    debounceSearch(performSearch, 300)
  })

  // Add click event for the search icon
  const searchIcon = document.querySelector(".search-bar svg")
  searchIcon.addEventListener("click", performSearch)

  // Make the search icon clickable
  searchIcon.style.cursor = "pointer"

  // Load initial history
  loadMoreHistory()
})

window.addEventListener("scroll", () => {
  if (window.innerHeight + window.scrollY >= document.body.offsetHeight - 1000) {
    loadMoreHistory()
  }
})

