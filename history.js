let lastFetchedTime = new Date().getTime()
let isLoading = false
const ITEMS_PER_PAGE = 50
let searchQuery = ''
let searchTimeout

// Check if chrome is defined, if not, mock it for testing purposes
if (typeof chrome === 'undefined') {
  globalThis.chrome = {
    history: {
      search: (query, callback) => {
        // Mock implementation for testing
        console.warn('Mock chrome.history.search called.  Returning empty array.')
        callback([])
      },
      deleteUrl: (details, callback) => {
        // Mock implementation for testing
        console.warn('Mock chrome.history.deleteUrl called.')
        callback()
      },
    },
    tabs: {
      create: (options) => {
        // Mock implementation for testing
        console.warn('Mock chrome.tabs.create called with URL:', options.url)
      },
    },
    runtime: {
      lastError: null, // Initialize lastError to null
    },
  }
}

function formatDate(date) {
  // Create date objects with time set to midnight for proper day comparison
  const itemDate = new Date(date.getFullYear(), date.getMonth(), date.getDate())

  const now = new Date()
  const todayDate = new Date(now.getFullYear(), now.getMonth(), now.getDate())

  const yesterday = new Date(todayDate)
  yesterday.setDate(yesterday.getDate() - 1)

  if (itemDate.getTime() === todayDate.getTime()) {
    return 'Today'
  } else if (itemDate.getTime() === yesterday.getTime()) {
    return 'Yesterday'
  } else {
    return date.toLocaleDateString(undefined, {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    })
  }
}

function formatTime(date) {
  return date.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  })
}

function getFaviconUrl(url) {
  return `https://www.google.com/s2/favicons?domain=${new URL(url).hostname}&sz=32`
}

function showNotification(message) {
  // Remove any existing notifications
  const existingNotifications = document.querySelectorAll('.notification')
  existingNotifications.forEach((notification) => notification.remove())

  // Create and show the notification
  const notification = document.createElement('div')
  notification.className = 'notification'
  notification.textContent = message
  document.body.appendChild(notification)

  // Remove the notification after 2 seconds
  setTimeout(() => {
    notification.remove()
  }, 2000)
}

function closeAllDropdowns() {
  document.querySelectorAll('.dropdown-menu.show').forEach((menu) => {
    menu.classList.remove('show')
  })
}

// Create a single dropdown menu that will be reused
let globalDropdownMenu = null

function createGlobalDropdownMenu() {
  if (globalDropdownMenu) return globalDropdownMenu

  const dropdownMenu = document.createElement('div')
  dropdownMenu.className = 'dropdown-menu'
  document.body.appendChild(dropdownMenu)

  globalDropdownMenu = dropdownMenu
  return dropdownMenu
}

function createHistoryItem(item) {
  const div = document.createElement('div')
  div.className = 'history-item'
  div.setAttribute('data-url', item.url)

  // Add click handler to open URL in new tab
  div.addEventListener('click', (e) => {
    // Don't open the URL if clicking on the menu button or menu items
    if (e.target.closest('.menu-button') || e.target.closest('.dropdown-menu')) {
      return
    }
    window.open(item.url, '_blank')
  })

  const favicon = document.createElement('img')
  favicon.className = 'favicon'
  favicon.src = getFaviconUrl(item.url)
  favicon.onerror = () => {
    favicon.src =
      'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="gray"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z"/></svg>'
  }

  const details = document.createElement('div')
  details.className = 'item-details'

  const title = document.createElement('div')
  title.className = 'title'
  title.textContent = item.title || new URL(item.url).hostname

  const url = document.createElement('div')
  url.className = 'url'
  url.textContent = item.url

  const time = document.createElement('div')
  time.className = 'time'
  time.textContent = formatTime(new Date(item.lastVisitTime))

  const menuButton = document.createElement('div')
  menuButton.className = 'menu-button'
  menuButton.innerHTML = `
    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z"></path>
    </svg>
  `

  // Toggle dropdown on menu button click
  menuButton.addEventListener('click', (e) => {
    e.stopPropagation()

    // Get or create the global dropdown menu
    const dropdownMenu = createGlobalDropdownMenu()

    // Clear previous content
    dropdownMenu.innerHTML = ''

    // Add menu items
    const moreFromSite = document.createElement('div')
    moreFromSite.className = 'dropdown-item'
    moreFromSite.textContent = 'More from this site'
    moreFromSite.addEventListener('click', (e) => {
      e.stopPropagation()
      const hostname = new URL(item.url).hostname
      const searchInput = document.querySelector('.search-bar input')
      searchInput.value = hostname
      performSearch()
      closeAllDropdowns()
    })

    const removeFromHistory = document.createElement('div')
    removeFromHistory.className = 'dropdown-item'
    removeFromHistory.textContent = 'Remove from history'
    removeFromHistory.addEventListener('click', (e) => {
      e.stopPropagation()
      chrome.history.deleteUrl({ url: item.url }, () => {
        // Find all history items with this URL and remove them
        document.querySelectorAll(`.history-item[data-url="${item.url}"]`).forEach((el) => {
          el.remove()
        })

        // Show notification
        showNotification('Removed from history')

        // Check if the date group is now empty and remove it if so
        document.querySelectorAll('.date-group').forEach((group) => {
          if (group.querySelectorAll('.history-item').length === 0) {
            group.remove()
          }
        })
      })
      closeAllDropdowns()
    })

    const copyUrl = document.createElement('div')
    copyUrl.className = 'dropdown-item'
    copyUrl.textContent = 'Copy URL'
    copyUrl.addEventListener('click', (e) => {
      e.stopPropagation()
      navigator.clipboard
        .writeText(item.url)
        .then(() => {
          showNotification('URL copied to clipboard')
        })
        .catch((err) => {
          console.error('Could not copy URL: ', err)
          showNotification('Failed to copy URL')
        })
      closeAllDropdowns()
    })

    dropdownMenu.appendChild(moreFromSite)
    dropdownMenu.appendChild(removeFromHistory)
    dropdownMenu.appendChild(copyUrl)

    // Close any open dropdowns
    closeAllDropdowns()

    // Show the dropdown
    dropdownMenu.classList.add('show')

    // Position the dropdown next to the clicked item
    const rect = div.getBoundingClientRect()

    // Position at the same level as the history item
    dropdownMenu.style.top = `${rect.top}px`
    dropdownMenu.style.left = `${rect.right + 10}px`

    // Make sure the dropdown doesn't go off-screen
    const dropdownRect = dropdownMenu.getBoundingClientRect()
    const viewportWidth = window.innerWidth
    const viewportHeight = window.innerHeight

    if (dropdownRect.right > viewportWidth) {
      dropdownMenu.style.left = `${viewportWidth - dropdownRect.width - 20}px`
    }

    if (dropdownRect.bottom > viewportHeight) {
      dropdownMenu.style.top = `${rect.top - (dropdownRect.bottom - viewportHeight)}px`
    }
  })

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
  // Check if a group with this date already exists
  const existingGroup = Array.from(container.children).find(
    (el) => el.querySelector('.date-header')?.textContent === date
  )

  if (existingGroup) {
    // Add items to existing group
    items.forEach((item) => {
      existingGroup.appendChild(createHistoryItem(item))
    })
    return
  }

  // Create new group
  const group = document.createElement('div')
  group.className = 'date-group'

  const header = document.createElement('div')
  header.className = 'date-header'
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
  const loading = document.getElementById('loading')
  loading.style.display = 'block'

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
        loading.style.display = 'none'
        isLoading = false
        return
      }

      const content = document.getElementById('content')

      if (items && items.length > 0) {
        // Sort items by date (newest first)
        items.sort((a, b) => b.lastVisitTime - a.lastVisitTime)

        const groups = groupHistoryByDate(items)

        // Sort date groups - Today, Yesterday, then other dates in reverse chronological order
        const sortedDates = Object.keys(groups).sort((a, b) => {
          if (a === 'Today') return -1
          if (b === 'Today') return 1
          if (a === 'Yesterday') return -1
          if (b === 'Yesterday') return 1

          // For other dates, convert to date objects and compare
          const dateA = new Date(a)
          const dateB = new Date(b)
          return dateB - dateA
        })

        sortedDates.forEach((date) => {
          renderHistoryGroup(date, groups[date], content)
        })

        lastFetchedTime = items[items.length - 1].lastVisitTime - 1
      } else if (content.children.length === 0) {
        const noResults = document.createElement('div')
        noResults.className = 'no-results'
        noResults.textContent = searchQuery
          ? `No search results for "${searchQuery}"`
          : 'No history items found'
        content.appendChild(noResults)
      }

      isLoading = false
      loading.style.display = 'none'
    }
  )
}

function performSearch() {
  const searchInput = document.querySelector('.search-bar input')
  searchQuery = searchInput.value.trim().toLowerCase()

  // Reset the time to current to start a fresh search
  lastFetchedTime = new Date().getTime()

  // Clear existing content
  const content = document.getElementById('content')
  content.innerHTML = ''

  // Show loading indicator
  const loading = document.getElementById('loading')
  loading.style.display = 'block'

  // Load history with the search query
  loadMoreHistory()
}

function debounceSearch(func, delay) {
  clearTimeout(searchTimeout)
  searchTimeout = setTimeout(func, delay)
}

document.addEventListener('DOMContentLoaded', () => {
  // Create the global dropdown menu
  createGlobalDropdownMenu()

  // Add search functionality
  const searchInput = document.querySelector('.search-bar input')

  searchInput.addEventListener('input', () => {
    debounceSearch(performSearch, 300)
  })

  // Add click event for the search icon
  const searchIcon = document.querySelector('.search-bar svg')
  searchIcon.addEventListener('click', performSearch)

  // Make the search icon clickable
  searchIcon.style.cursor = 'pointer'

  // Load initial history
  loadMoreHistory()

  // Add click handler for "Delete browsing data"
  const deleteDataButton = document.getElementById('delete-data')
  deleteDataButton.addEventListener('click', () => {
    chrome.tabs.create({ url: 'chrome://settings/clearBrowserData' })
  })

  // Close dropdowns when clicking outside
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.menu-button') && !e.target.closest('.dropdown-menu')) {
      closeAllDropdowns()
    }
  })
})

window.addEventListener('scroll', () => {
  if (window.innerHeight + window.scrollY >= document.body.offsetHeight - 1000) {
    loadMoreHistory()
  }
})
