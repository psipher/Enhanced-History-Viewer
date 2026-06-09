let lastFetchedTime = new Date().getTime()
let isLoading = false
const ITEMS_PER_PAGE = 50
let searchQuery = ''
let selectedUrls = new Set() // Track selected URLs for bulk actions

let searchTimeout
let currentSearchRequestId = 0
let hasMoreHistory = true
let lastCheckedCheckbox = null


function formatDate(date) {
  // Create date objects with time set to midnight for proper day comparison
  const itemDate = new Date(date.getFullYear(), date.getMonth(), date.getDate())

  const now = new Date()
  const todayDate = new Date(now.getFullYear(), now.getMonth(), now.getDate())

  const yesterday = new Date(todayDate)
  yesterday.setDate(yesterday.getDate() - 1)

  const formattedFullDate = date.toLocaleDateString(undefined, {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })

  if (itemDate.getTime() === todayDate.getTime()) {
    return `Today - ${formattedFullDate}`
  } else if (itemDate.getTime() === yesterday.getTime()) {
    return `Yesterday - ${formattedFullDate}`
  } else {
    return formattedFullDate
  }
}

function formatTime(date) {
  return date.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  })
}

function getHostname(urlStr) {
  try {
    return new URL(urlStr).hostname
  } catch {
    return urlStr || ''
  }
}

function getFaviconUrl(url) {
  try {
    const chromeFaviconUrl = new URL(chrome.runtime.getURL('/_favicon/'))
    chromeFaviconUrl.searchParams.set('pageUrl', url)
    chromeFaviconUrl.searchParams.set('size', '32')
    return chromeFaviconUrl.toString()
  } catch {
    const domain = getHostname(url)
    return `https://www.google.com/s2/favicons?domain=${domain}&sz=32`
  }
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

function updateActionBar() {
  const actionBar = document.getElementById('selection-action-bar')
  const searchBar = document.getElementById('search-bar-wrapper')
  const countSpan = document.getElementById('selected-count')

  if (selectedUrls.size > 0) {
    actionBar.style.display = 'flex'
    searchBar.style.display = 'none'
    countSpan.textContent = `${selectedUrls.size} selected`
  } else {
    actionBar.style.display = 'none'
    searchBar.style.display = 'flex'
  }
}

function clearSelection() {
  selectedUrls.clear()
  document.querySelectorAll('.history-item-checkbox').forEach((cb) => {
    cb.checked = false
  })
  lastCheckedCheckbox = null
  updateActionBar()
}

function deleteSelectedItems() {
  if (selectedUrls.size === 0) return

  const urlsToDelete = Array.from(selectedUrls)
  const deletePromises = urlsToDelete.map((url) => {
    return new Promise((resolve) => {
      chrome.history.deleteUrl({ url }, resolve)
    })
  })

  Promise.all(deletePromises).then(() => {
    // Remove items from DOM
    urlsToDelete.forEach((url) => {
      document.querySelectorAll(`.history-item[data-url="${url}"]`).forEach((el) => {
        el.remove()
      })
    })

    // Clean up empty date groups
    document.querySelectorAll('.date-group').forEach((group) => {
      if (group.querySelectorAll('.history-item').length === 0) {
        group.remove()
      }
    })

    showNotification(`Deleted ${urlsToDelete.length} item(s)`)
    clearSelection()

    // If page is empty, load more
    const content = document.getElementById('content')
    if (content.children.length === 0) {
      hasMoreHistory = true
      loadMoreHistory(currentSearchRequestId)
    }
  })
}

function handleCheckboxClick(e, checkbox, url) {
  if (e.shiftKey && lastCheckedCheckbox) {
    const checkboxes = Array.from(document.querySelectorAll('.history-item-checkbox'))
    const start = checkboxes.indexOf(lastCheckedCheckbox)
    const end = checkboxes.indexOf(checkbox)

    if (start !== -1 && end !== -1) {
      const min = Math.min(start, end)
      const max = Math.max(start, end)
      const targetCheckedState = checkbox.checked

      for (let i = min; i <= max; i++) {
        const cb = checkboxes[i]
        const parentRow = cb.closest('.history-item')
        if (parentRow) {
          const itemUrl = parentRow.getAttribute('data-url')
          cb.checked = targetCheckedState
          if (targetCheckedState) {
            selectedUrls.add(itemUrl)
          } else {
            selectedUrls.delete(itemUrl)
          }
        }
      }
    }
  } else {
    if (checkbox.checked) {
      selectedUrls.add(url)
    } else {
      selectedUrls.delete(url)
    }
  }

  lastCheckedCheckbox = checkbox
  updateActionBar()
}

function createHistoryItem(item) {
  const div = document.createElement('div')
  div.className = 'history-item'
  div.setAttribute('data-url', item.url)

  // Prepend Checkbox
  const checkbox = document.createElement('input')
  checkbox.type = 'checkbox'
  checkbox.className = 'history-item-checkbox'
  checkbox.checked = selectedUrls.has(item.url)
  checkbox.addEventListener('click', (e) => {
    e.stopPropagation()
    handleCheckboxClick(e, checkbox, item.url)
  })
  div.appendChild(checkbox)

  // Add click handler to toggle selection or open URL
  div.addEventListener('click', (e) => {
    // Don't open the URL if clicking on the menu button, menu items, or checkbox
    if (e.target.closest('.menu-button') ||
      e.target.closest('.dropdown-menu') ||
      e.target.closest('.history-item-checkbox')) {
      return
    }

    // If clicking details or time, open the link; otherwise toggle the checkbox
    if (e.target.closest('.item-details') || e.target.closest('.time')) {
      window.open(item.url, '_blank')
    } else {
      checkbox.dispatchEvent(new MouseEvent('click', {
        shiftKey: e.shiftKey,
        bubbles: true
      }))
    }
  })

  const favicon = document.createElement('img')
  favicon.className = 'favicon'
  favicon.src = getFaviconUrl(item.url)
  favicon.onerror = () => {
    const domain = getHostname(item.url)
    const fallbackUrl = `https://www.google.com/s2/favicons?domain=${domain}&sz=32`
    if (favicon.src !== fallbackUrl) {
      favicon.src = fallbackUrl
    } else {
      favicon.src =
        'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="gray"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z"/></svg>'
    }
  }

  const details = document.createElement('div')
  details.className = 'item-details'

  const title = document.createElement('div')
  title.className = 'title'

  const titleText = document.createElement('span')
  titleText.className = 'title-text'
  titleText.textContent = item.title || getHostname(item.url)
  title.appendChild(titleText)

  chrome.history.getVisits({ url: item.url }, (visits) => {
    if (visits && visits.length > 0) {
      // Sort visits by time to get the most recent one (newest first)
      visits.sort((a, b) => b.visitTime - a.visitTime)
      const mostRecentVisit = visits[0]
      if (mostRecentVisit.isLocal === false) {
        const syncedBadge = document.createElement('span')
        syncedBadge.className = 'synced-badge'
        syncedBadge.innerHTML = `
          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" fill-rule="evenodd" style="vertical-align: middle;">
            <path fill-rule="evenodd" d="M4 6h13v9H4V6zm15 2h3v10h-3V8zM2 4c0-1.1.9-2 2-2h13c1.1 0 2 .9 2 2v2h3c1.1 0 2 .9 2 2v10c0 1.1-.9 2-2 2h-3c-1.1 0-2-.9-2-2v-1H4c-1.1 0-2-.9-2-2V4z"/>
          </svg>
        `
        title.appendChild(syncedBadge)
      }
    }
  })

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
      const hostname = getHostname(item.url)
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

    // Position the dropdown below the clicked menu button, aligned to its right
    const menuRect = menuButton.getBoundingClientRect()
    const dropdownRect = dropdownMenu.getBoundingClientRect()

    dropdownMenu.style.top = `${menuRect.bottom + 4}px`
    dropdownMenu.style.left = `${menuRect.right - dropdownRect.width}px`

    // Make sure the dropdown doesn't go off-screen
    const viewportWidth = window.innerWidth
    const viewportHeight = window.innerHeight

    const currentLeft = parseFloat(dropdownMenu.style.left)

    if (currentLeft < 0) {
      dropdownMenu.style.left = '10px'
    } else if (currentLeft + dropdownRect.width > viewportWidth) {
      dropdownMenu.style.left = `${viewportWidth - dropdownRect.width - 10}px`
    }

    if (menuRect.bottom + dropdownRect.height > viewportHeight) {
      dropdownMenu.style.top = `${menuRect.top - dropdownRect.height - 4}px`
    }
  })

  details.appendChild(title)
  details.appendChild(url)
  div.appendChild(time)
  div.appendChild(favicon)
  div.appendChild(details)
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

  let targetGroup
  if (existingGroup) {
    targetGroup = existingGroup
  } else {
    // Create new group
    targetGroup = document.createElement('div')
    targetGroup.className = 'date-group'

    const header = document.createElement('div')
    header.className = 'date-header'
    header.textContent = date

    targetGroup.appendChild(header)
    container.appendChild(targetGroup)
  }

  items.forEach((item) => {
    // Deduplication check: Do not append if this URL already exists in the view
    if (document.querySelector(`.history-item[data-url="${item.url}"]`)) {
      return
    }
    targetGroup.appendChild(createHistoryItem(item))
  })
}

function loadMoreHistory(requestId) {
  if (isLoading || !hasMoreHistory) return

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
      // Check if this request is stale
      if (requestId !== currentSearchRequestId) {
        return
      }

      if (chrome.runtime.lastError) {
        console.error(chrome.runtime.lastError)
        loading.style.display = 'none'
        isLoading = false
        return
      }

      if (!items || items.length < ITEMS_PER_PAGE) {
        hasMoreHistory = false
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

  // Increment request ID to invalidate any conflicting previous searches
  currentSearchRequestId++

  // Reset loading, paging, and selection states so we can immediately start the new search
  isLoading = false
  hasMoreHistory = true
  lastCheckedCheckbox = null

  // Clear existing content
  const content = document.getElementById('content')
  content.innerHTML = ''

  // Show loading indicator
  const loading = document.getElementById('loading')
  loading.style.display = 'block'

  // Load history with the search query and passing the ID
  loadMoreHistory(currentSearchRequestId)
}

function loadOtherDevices() {
  const otherDevicesDiv = document.getElementById('other-devices-view')
  otherDevicesDiv.innerHTML = '<div class="loading">Loading synced devices...</div>'

  if (!chrome.sessions || !chrome.sessions.getDevices) {
    otherDevicesDiv.innerHTML = '<div class="no-results">Sync and Sessions API are not available.</div>'
    return
  }

  chrome.sessions.getDevices({ maxResults: 10 }, (devices) => {
    if (chrome.runtime.lastError) {
      console.error(chrome.runtime.lastError)
      otherDevicesDiv.innerHTML = '<div class="no-results">Error loading synced devices. Make sure Chrome Sync is enabled.</div>'
      return
    }

    otherDevicesDiv.innerHTML = ''

    if (!devices || devices.length === 0) {
      otherDevicesDiv.innerHTML = '<div class="no-results">No synced devices found. Make sure you are signed in and Sync is turned on.</div>'
      return
    }

    devices.forEach((device) => {
      const deviceCard = document.createElement('div')
      deviceCard.className = 'device-card'

      const header = document.createElement('div')
      header.className = 'device-card-header'

      // Select icon based on device type info or name
      const nameLower = (device.info || device.deviceName || '').toLowerCase()
      let iconSvg = `
        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
          <path d="M4 6h18V4H4c-1.1 0-2 .9-2 2v11H0v3h24v-3h-2V6c0-1.1-.9-2-2-2zM2 17V6h18v11H2zm10 1.5c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5z" />
        </svg>
      ` // Default laptop
      if (nameLower.includes('phone') || nameLower.includes('mobile') || nameLower.includes('android') || nameLower.includes('iphone')) {
        iconSvg = `
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <path d="M17 1.01L7 1c-1.1 0-2 .9-2 2v18c0 1.1.9 2 2 2h10c1.1 0 2-.9 2-2V3c0-1.1-.9-1.99-2-1.99zM17 19H7V5h10v14z"/>
          </svg>
        ` // Phone
      } else if (nameLower.includes('tablet') || nameLower.includes('ipad')) {
        iconSvg = `
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <path d="M18.5 0h-13C3.57 0 2 1.57 2 3.5v17C2 22.43 3.57 24 5.5 24h13c1.93 0 3.5-1.57 3.5-3.5v-17C22 1.57 20.43 0 18.5 0zm-13 2h13c.83 0 1.5.67 1.5 1.5v13.5H4V3.5C4 2.67 4.67 2 5.5 2zm13 20h-13c-.83 0-1.5-.67-1.5-1.5V19h16v1.5c0 .83-.67 1.5-1.5 1.5z"/>
          </svg>
        ` // Tablet
      }

      header.innerHTML = `${iconSvg} <span>${device.info || device.deviceName || 'Other Device'}</span>`
      deviceCard.appendChild(header)

      // Collect all tabs from sessions
      const tabs = []
      device.sessions.forEach((session) => {
        if (session.tab) {
          tabs.push(session.tab)
        } else if (session.window && session.window.tabs) {
          session.window.tabs.forEach((tab) => {
            tabs.push(tab)
          })
        }
      })

      if (tabs.length === 0) {
        const emptyMsg = document.createElement('div')
        emptyMsg.className = 'no-results'
        emptyMsg.style.padding = '10px'
        emptyMsg.textContent = 'No open tabs'
        deviceCard.appendChild(emptyMsg)
      } else {
        tabs.forEach((tab) => {
          if (!tab.url || tab.url.trim() === '') return // Skip tabs with empty URLs

          const tabItem = document.createElement('a')
          tabItem.className = 'device-tab-item'
          tabItem.href = tab.url
          tabItem.target = '_blank'

          const favicon = document.createElement('img')
          favicon.className = 'favicon'
          favicon.src = getFaviconUrl(tab.url)
          favicon.onerror = () => {
            const domain = getHostname(tab.url)
            const fallbackUrl = `https://www.google.com/s2/favicons?domain=${domain}&sz=32`
            if (favicon.src !== fallbackUrl) {
              favicon.src = fallbackUrl
            } else {
              favicon.src =
                'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="gray"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z"/></svg>'
            }
          }

          const details = document.createElement('div')
          details.className = 'device-tab-details'

          const title = document.createElement('div')
          title.className = 'device-tab-title'
          title.textContent = tab.title || getHostname(tab.url)

          const url = document.createElement('div')
          url.className = 'device-tab-url'
          url.textContent = tab.url

          details.appendChild(title)
          details.appendChild(url)
          tabItem.appendChild(favicon)
          tabItem.appendChild(details)

          if (tab.lastActiveTime) {
            const time = document.createElement('div')
            time.className = 'device-tab-time'
            time.textContent = formatTime(new Date(tab.lastActiveTime))
            tabItem.appendChild(time)
          }

          deviceCard.appendChild(tabItem)
        })
      }

      otherDevicesDiv.appendChild(deviceCard)
    })
  })
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
  const clearSearchBtn = document.getElementById('clear-search')

  searchInput.addEventListener('input', () => {
    if (searchInput.value.length > 0) {
      clearSearchBtn.style.display = 'flex'
    } else {
      clearSearchBtn.style.display = 'none'
    }
    debounceSearch(performSearch, 300)
  })

  clearSearchBtn.addEventListener('click', () => {
    searchInput.value = ''
    clearSearchBtn.style.display = 'none'
    performSearch()
    searchInput.focus()
  })

  // Add click event for the search icon
  const searchIcon = document.querySelector('.search-bar svg')
  searchIcon.addEventListener('click', performSearch)
  searchIcon.style.cursor = 'pointer'

  // Load initial history with initial ID
  loadMoreHistory(currentSearchRequestId)

  // Sidebar navigation switching
  const navHistory = document.getElementById('nav-history')
  const navOtherDevices = document.getElementById('nav-other-devices')
  const contentDiv = document.getElementById('content')
  const otherDevicesDiv = document.getElementById('other-devices-view')
  const searchContainer = document.querySelector('.search-container')

  navHistory.addEventListener('click', () => {
    navHistory.classList.add('active')
    navOtherDevices.classList.remove('active')
    contentDiv.style.display = 'block'
    otherDevicesDiv.style.display = 'none'
    searchContainer.style.display = 'flex'
    // Refresh history
    performSearch()
  })

  navOtherDevices.addEventListener('click', () => {
    navHistory.classList.remove('active')
    navOtherDevices.classList.add('active')
    contentDiv.style.display = 'none'
    otherDevicesDiv.style.display = 'block'
    searchContainer.style.display = 'none'
    clearSelection()
    loadOtherDevices()
  })

  // Action Bar event listeners
  document.getElementById('cancel-selection').addEventListener('click', clearSelection)
  document.getElementById('delete-selected').addEventListener('click', deleteSelectedItems)

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
  const content = document.getElementById('content')
  if (content.style.display !== 'none' && window.innerHeight + window.scrollY >= document.body.offsetHeight - 1000) {
    loadMoreHistory(currentSearchRequestId)
  }
})


