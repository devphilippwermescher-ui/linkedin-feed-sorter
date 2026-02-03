let isAutoScrolling = false;
let scrollTimeout: ReturnType<typeof setTimeout> | null = null;
let checkInterval: ReturnType<typeof setInterval> | null = null;
let lastScrollHeight = 0;
let noChangeCount = 0;
let overlayElement: HTMLDivElement | null = null;

const SCROLL_DELAY = 2000;
const MAX_NO_CHANGE = 3;
const MAX_NO_NEW_POSTS = 5;  // Stop after this many scroll attempts with no new posts
const CHECK_INTERVAL = 1000;

let lastPostCount = 0;
let noNewPostsCount = 0;

console.log('[LinkedIn Analyzer] Content script loaded');

function initializeAfterLoad() {
  console.log('[LinkedIn Analyzer] Page ready, checking collection state...');
  
  chrome.runtime.sendMessage({ type: "GET_COLLECTION_STATE" }, (response) => {
    console.log('[LinkedIn Analyzer] Initial state:', response);
    // targetCount can be a number > 0 or 'all' for profile pages
    const hasValidTarget = response?.targetCount === 'all' || (response?.targetCount > 0);
    if (response?.isCollecting && hasValidTarget) {
      console.log('[LinkedIn Analyzer] Active collection found, resuming...');
      showOverlay(response.currentCount, response.targetCount);
      setTimeout(() => {
        startAutoScroll();
      }, 2000);
    }
  });
}

if (document.readyState === 'complete') {
  setTimeout(initializeAfterLoad, 1000);
} else {
  window.addEventListener('load', () => {
    setTimeout(initializeAfterLoad, 1000);
  });
}

window.addEventListener("message", (event) => {
  if (event.data && event.data.type === "LINKEDIN_FEED_DATA_FROM_PAGE") {
    chrome.runtime
      .sendMessage({
        type: "LINKEDIN_FEED_DATA",
        data: event.data.data,
        url: event.data.url,
        feedType: event.data.feedType,
        timestamp: event.data.timestamp,
      })
      .then(() => {
        updateOverlayCount();
        checkIfComplete();
      })
      .catch((e) => console.log('[LinkedIn Analyzer] Error:', e));
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('[LinkedIn Analyzer] Message received:', message.type);
  
  if (message.type === "START_AUTO_SCROLL") {
    startAutoScroll();
    sendResponse({ success: true });
    return true;
  }

  if (message.type === "STOP_AUTO_SCROLL") {
    stopAutoScroll();
    sendResponse({ success: true });
    return true;
  }

  return false;
});

function showOverlay(currentCount: number = 0, targetCount: number | 'all' = 0) {
  console.log('[LinkedIn Analyzer] Showing overlay');
  
  if (overlayElement) {
    console.log('[LinkedIn Analyzer] Overlay already exists');
    return;
  }
  
  overlayElement = document.createElement('div');
  overlayElement.id = 'linkedin-analyzer-overlay';
  overlayElement.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    width: 100vw;
    height: 100vh;
    background: rgba(0, 0, 0, 0.75);
    z-index: 999999;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  `;
  
  const card = document.createElement('div');
  card.style.cssText = `
    background: white;
    padding: 40px 60px;
    border-radius: 16px;
    text-align: center;
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
  `;
  
  const countText = targetCount === 'all' ? `${currentCount} Posts` : `${currentCount} / ${targetCount} Posts`;
  const subText = targetCount === 'all' ? 'collecting all posts...' : 'collecting data...';
  
  card.innerHTML = `
    <div style="
      width: 50px;
      height: 50px;
      border: 4px solid #e5e7eb;
      border-top-color: #034C9D;
      border-radius: 50%;
      margin: 0 auto 20px;
      animation: la-spin 1s linear infinite;
    "></div>
    <div id="la-overlay-count" style="
      font-size: 32px;
      font-weight: 700;
      color: #034C9D;
      margin-bottom: 8px;
    ">${countText}</div>
    <div style="
      font-size: 16px;
      color: #6b7280;
      margin-bottom: 4px;
    ">${subText}</div>
    <div style="
      font-size: 14px;
      color: #9ca3af;
    ">don't scroll manually</div>
  `;
  
  const style = document.createElement('style');
  style.textContent = `
    @keyframes la-spin {
      to { transform: rotate(360deg); }
    }
  `;
  
  overlayElement.appendChild(card);
  overlayElement.appendChild(style);
  document.body.appendChild(overlayElement);
  
  console.log('[LinkedIn Analyzer] Overlay created and added to body');
}

function updateOverlayText(currentCount: number, targetCount: number | 'all') {
  const countEl = document.getElementById('la-overlay-count');
  if (countEl) {
    if (targetCount === 'all') {
      countEl.textContent = `${currentCount} Posts`;
    } else {
      countEl.textContent = `${currentCount} / ${targetCount} Posts`;
    }
  }
}

function updateOverlayCount() {
  chrome.runtime.sendMessage({ type: "GET_COLLECTION_STATE" }, (response) => {
    if (response) {
      updateOverlayText(response.currentCount, response.targetCount);
    }
  });
}

function hideOverlay() {
  console.log('[LinkedIn Analyzer] Hiding overlay');
  const el = document.getElementById('linkedin-analyzer-overlay');
  if (el) {
    el.remove();
  }
  overlayElement = null;
}

function startAutoScroll() {
  if (isAutoScrolling) {
    console.log('[LinkedIn Analyzer] Already scrolling');
    return;
  }
  
  isAutoScrolling = true;
  lastScrollHeight = 0;
  noChangeCount = 0;
  noNewPostsCount = 0;
  lastPostCount = 0;
  
  console.log('[LinkedIn Analyzer] *** Starting auto-scroll ***');
  
  chrome.runtime.sendMessage({ type: "GET_COLLECTION_STATE" }, (response) => {
    if (response) {
      showOverlay(response.currentCount, response.targetCount);
    }
  });
  
  checkInterval = setInterval(() => {
    if (!isAutoScrolling) {
      if (checkInterval) clearInterval(checkInterval);
      return;
    }
    updateOverlayCount();
    checkIfComplete();
  }, CHECK_INTERVAL);
  
  doScroll();
}

function doScroll() {
  if (!isAutoScrolling) {
    console.log('[LinkedIn Analyzer] Scroll stopped');
    return;
  }
  
  const currentScrollHeight = document.body.scrollHeight;
  
  console.log('[LinkedIn Analyzer] Scrolling to:', currentScrollHeight);
  
  window.scrollTo({
    top: currentScrollHeight,
    behavior: "instant",
  });
  
  if (currentScrollHeight === lastScrollHeight) {
    noChangeCount++;
    console.log('[LinkedIn Analyzer] No new content, attempt:', noChangeCount);
    
    if (noChangeCount >= MAX_NO_CHANGE) {
      const clicked = clickLoadMoreButton();
      if (clicked) {
        noChangeCount = 0;
      }
    }
  } else {
    noChangeCount = 0;
    lastScrollHeight = currentScrollHeight;
  }
  
  scrollTimeout = setTimeout(() => {
    doScroll();
  }, SCROLL_DELAY);
}

function clickLoadMoreButton(): boolean {
  const buttons = document.querySelectorAll('button');
  
  for (const button of buttons) {
    const text = button.textContent?.toLowerCase() || '';
    if (text.includes('показать') || 
        text.includes('show') || 
        text.includes('load') || 
        text.includes('more') ||
        text.includes('ещё') ||
        text.includes('еще') ||
        text.includes('результат')) {
      console.log('[LinkedIn Analyzer] Clicking button:', text.trim().substring(0, 50));
      button.click();
      return true;
    }
  }
  
  return false;
}

function checkIfComplete() {
  chrome.runtime.sendMessage({ type: "GET_COLLECTION_STATE" }, (response) => {
    if (response) {
      console.log('[LinkedIn Analyzer] State:', response.currentCount, '/', response.targetCount, 'isCollecting:', response.isCollecting, 'collectAll:', response.collectAll);
      
      if (!response.isCollecting) {
        console.log('[LinkedIn Analyzer] Collection complete');
        stopAutoScroll();
        return;
      }
      
      // For "collect all" mode, check if we've stopped getting new posts
      if (response.collectAll || response.targetCount === 'all') {
        if (response.currentCount === lastPostCount) {
          noNewPostsCount++;
          console.log('[LinkedIn Analyzer] No new posts, attempt:', noNewPostsCount);
          
          if (noNewPostsCount >= MAX_NO_NEW_POSTS) {
            console.log('[LinkedIn Analyzer] All posts collected (no new content)');
            // Stop the collection
            chrome.runtime.sendMessage({ type: "STOP_COLLECTION" });
            stopAutoScroll();
          }
        } else {
          noNewPostsCount = 0;
          lastPostCount = response.currentCount;
        }
      }
    }
  });
}

function stopAutoScroll() {
  console.log('[LinkedIn Analyzer] Stopping auto-scroll');
  isAutoScrolling = false;
  if (scrollTimeout) {
    clearTimeout(scrollTimeout);
    scrollTimeout = null;
  }
  if (checkInterval) {
    clearInterval(checkInterval);
    checkInterval = null;
  }
  hideOverlay();
}
