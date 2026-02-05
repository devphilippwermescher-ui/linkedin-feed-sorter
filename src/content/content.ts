let isAutoScrolling = false;
let scrollTimeout: ReturnType<typeof setTimeout> | null = null;
let checkInterval: ReturnType<typeof setInterval> | null = null;
let lastScrollHeight = 0;
let noChangeCount = 0;
let overlayElement: HTMLDivElement | null = null;

const SCROLL_DELAY = 3000;
const MAX_NO_CHANGE = 4;
const MAX_NO_NEW_POSTS = 8;
const MAX_BUTTON_ATTEMPTS = 3;
const CHECK_INTERVAL = 1500;

let lastPostCount = 0;
let noNewPostsCount = 0;
let buttonAttempts = 0;

console.log('[LinkedIn Analyzer] Content script loaded');

function parsePostElement(postEl: Element): any | null {
  try {
    const activityUrn = postEl.getAttribute('data-urn') || postEl.getAttribute('data-id') || '';
    if (!activityUrn) return null;
    
    const activityMatch = activityUrn.match(/activity:(\d+)/);
    if (!activityMatch) return null;
    
    let authorName = 'Unknown';
    const authorEl = postEl.querySelector('.update-components-actor__title span[dir="ltr"] span[aria-hidden="true"]');
    if (authorEl) {
      authorName = authorEl.textContent?.trim() || 'Unknown';
    }
    
    let text = '';
    const textEl = postEl.querySelector('.update-components-text span[dir="ltr"]');
    if (textEl) {
      text = textEl.textContent?.trim() || '';
    }
    
    const parseNumberWithSpaces = (text: string): number => {
      const cleaned = text.replace(/[\s\u00A0\u202F]+/g, '');
      const num = parseInt(cleaned, 10);
      return isNaN(num) ? 0 : num;
    };
    
    let numLikes = 0;
    const reactionsBtn = postEl.querySelector('[data-reaction-details]');
    if (reactionsBtn) {
      const ariaLabel = reactionsBtn.getAttribute('aria-label') || '';
      const match = ariaLabel.match(/([\d\s\u00A0]+)/);
      if (match) {
        numLikes = parseNumberWithSpaces(match[1]);
      }
    }
    
    if (numLikes === 0) {
      const likesCountEl = postEl.querySelector('.social-details-social-counts__reactions-count');
      if (likesCountEl) {
        const likesText = likesCountEl.textContent?.trim() || '';
        numLikes = parseNumberWithSpaces(likesText);
      }
    }
    
    if (numLikes === 0) {
      const socialCountsContainer = postEl.querySelector('.social-details-social-counts__reactions');
      if (socialCountsContainer) {
        const fullText = socialCountsContainer.textContent || '';
        const moreMatch = fullText.match(/(?:и еще|and)\s*([\d\s\u00A0]+)/i);
        if (moreMatch) {
          const additionalCount = parseNumberWithSpaces(moreMatch[1]);
          if (additionalCount > 0) {
            numLikes = 1 + additionalCount;
          }
        }
      }
    }
    
    let numComments = 0;
    const commentsLink = postEl.querySelector('.social-details-social-counts__comments button');
    if (commentsLink) {
      const ariaLabel = commentsLink.getAttribute('aria-label') || '';
      const match = ariaLabel.match(/([\d\s\u00A0]+)/);
      if (match) {
        numComments = parseNumberWithSpaces(match[1]);
      }
      
      if (numComments === 0) {
        const text = commentsLink.textContent?.trim() || '';
        numComments = parseNumberWithSpaces(text);
      }
    }
    
    if (numComments === 0) {
      const commentBtn = postEl.querySelector('button[aria-label*="комментар"], button[aria-label*="comment"]');
      if (commentBtn) {
        const ariaLabel = commentBtn.getAttribute('aria-label') || '';
        const match = ariaLabel.match(/([\d\s\u00A0]+)/);
        if (match) {
          numComments = parseNumberWithSpaces(match[1]);
        }
      }
    }
    
    let numShares = 0;
    const allButtons = postEl.querySelectorAll('.social-details-social-counts button');
    for (const btn of allButtons) {
      const ariaLabel = btn.getAttribute('aria-label') || '';
      const btnText = btn.textContent?.toLowerCase() || '';
      
      const isRepostButton = 
        ariaLabel.includes('репост') || 
        ariaLabel.includes('repost') ||
        btnText.includes('репост') ||
        btnText.includes('repost');
      
      if (isRepostButton) {
        const match = ariaLabel.match(/([\d\s\u00A0]+)/);
        if (match) {
          numShares = parseNumberWithSpaces(match[1]);
        }
        
        if (numShares === 0) {
          const textMatch = btnText.match(/([\d\s\u00A0]+)/);
          if (textMatch) {
            numShares = parseNumberWithSpaces(textMatch[1]);
          }
        }
        break;
      }
    }
    
    const isSponsored = activityUrn.includes('sponsored') || 
      !!postEl.querySelector('[data-ad-banner]') ||
      postEl.textContent?.toLowerCase().includes('promoted') ||
      postEl.textContent?.toLowerCase().includes('реклама');
    
    return {
      activityUrn: `urn:li:activity:${activityMatch[1]}`,
      authorName,
      authorUrn: '',
      text,
      numLikes,
      numComments,
      numShares,
      isSponsored,
    };
  } catch (e) {
    console.log('[LinkedIn Analyzer] Error parsing DOM post:', e);
    return null;
  }
}

function parsePostsFromDOM(): void {
  console.log('[LinkedIn Analyzer] Parsing posts from DOM...');
  
  const postElements = document.querySelectorAll('[data-urn^="urn:li:activity:"], [data-id^="urn:li:activity:"]');
  const posts: any[] = [];
  
  postElements.forEach((postEl) => {
    const post = parsePostElement(postEl);
    if (post) {
      console.log('[LinkedIn Analyzer] DOM post:', post.authorName, 'likes:', post.numLikes, 'comments:', post.numComments);
      posts.push(post);
    }
  });
  
  if (posts.length > 0) {
    console.log('[LinkedIn Analyzer] Sending', posts.length, 'DOM posts to background');
    chrome.runtime.sendMessage({
      type: "DOM_POSTS",
      posts: posts,
    });
  }
}

function syncPostsWithDOM(): void {
  const postElements = document.querySelectorAll('[data-urn^="urn:li:activity:"], [data-id^="urn:li:activity:"]');
  const domUpdates: any[] = [];
  
  postElements.forEach((postEl) => {
    const post = parsePostElement(postEl);
    if (post && (post.numLikes > 0 || post.numComments > 0 || post.numShares > 0)) {
      domUpdates.push({
        activityUrn: post.activityUrn,
        numLikes: post.numLikes,
        numComments: post.numComments,
        numShares: post.numShares,
        authorName: post.authorName,
      });
    }
  });
  
  if (domUpdates.length > 0) {
    console.log('[LinkedIn Analyzer] Syncing', domUpdates.length, 'posts with DOM metrics');
    chrome.runtime.sendMessage({
      type: "SYNC_DOM_METRICS",
      updates: domUpdates,
    });
  }
}

function initializeAfterLoad() {
  console.log('[LinkedIn Analyzer] Page ready, checking collection state...');
  
  chrome.runtime.sendMessage({ type: "GET_COLLECTION_STATE" }, (response) => {
    console.log('[LinkedIn Analyzer] Initial state:', response);
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

function waitForFeedToLoad(): Promise<void> {
  return new Promise((resolve) => {
    let attempts = 0;
    const maxAttempts = 20;
    
    const check = () => {
      attempts++;
      const feedContainer = document.querySelector('.scaffold-finite-scroll, [data-finite-scroll-hotkey-context]');
      const pageHeight = document.body.scrollHeight;
      const hasContent = pageHeight > 1500;
      
      console.log('[LinkedIn Analyzer] Waiting for feed... attempt:', attempts, 'height:', pageHeight, 'feedFound:', !!feedContainer);
      
      if ((feedContainer && hasContent) || attempts >= maxAttempts) {
        console.log('[LinkedIn Analyzer] Feed ready or max attempts reached');
        resolve();
      } else {
        setTimeout(check, 500);
      }
    };
    
    check();
  });
}

async function startAutoScroll() {
  if (isAutoScrolling) {
    console.log('[LinkedIn Analyzer] Already scrolling');
    return;
  }
  
  console.log('[LinkedIn Analyzer] *** Starting auto-scroll ***');
  
  chrome.runtime.sendMessage({ type: "GET_COLLECTION_STATE" }, (response) => {
    if (response) {
      showOverlay(response.currentCount, response.targetCount);
    }
  });
  
  await waitForFeedToLoad();
  
  isAutoScrolling = true;
  lastScrollHeight = 0;
  noChangeCount = 0;
  noNewPostsCount = 0;
  lastPostCount = 0;
  buttonAttempts = 0;
  
  parsePostsFromDOM();
  
  checkInterval = setInterval(() => {
    if (!isAutoScrolling) {
      if (checkInterval) clearInterval(checkInterval);
      return;
    }
    updateOverlayCount();
    checkIfComplete();
    syncPostsWithDOM();
  }, CHECK_INTERVAL);
  
  doScroll();
}

function getScrollContainer(): Element | null {
  // LinkedIn uses different scroll containers
  const selectors = [
    '.scaffold-layout__main',
    '.scaffold-finite-scroll__content', 
    '.core-rail',
    'main',
  ];
  
  for (const selector of selectors) {
    const el = document.querySelector(selector);
    if (el && el.scrollHeight > el.clientHeight) {
      return el;
    }
  }
  return null;
}

function doScroll() {
  if (!isAutoScrolling) {
    console.log('[LinkedIn Analyzer] Scroll stopped');
    return;
  }
  
  const scrollContainer = getScrollContainer();
  const currentScrollHeight = scrollContainer?.scrollHeight || document.body.scrollHeight;
  const currentScrollTop = scrollContainer?.scrollTop || window.scrollY || 0;
  
  console.log('[LinkedIn Analyzer] Scrolling to:', currentScrollHeight, 'current:', currentScrollTop, 'container:', scrollContainer?.className || 'window');
  
  // Scroll using multiple methods
  try {
    if (scrollContainer) {
      scrollContainer.scrollTop = currentScrollHeight;
    }
    window.scrollTo({ top: currentScrollHeight, behavior: 'auto' });
    document.documentElement.scrollTop = currentScrollHeight;
    document.body.scrollTop = currentScrollHeight;
  } catch (e) {
    console.log('[LinkedIn Analyzer] Scroll error:', e);
  }
  
  if (currentScrollHeight === lastScrollHeight) {
    noChangeCount++;
    console.log('[LinkedIn Analyzer] No scroll change, attempt:', noChangeCount);
    
    if (noChangeCount >= MAX_NO_CHANGE) {
      tryClickLoadMoreButton();
    }
  } else {
    noChangeCount = 0;
    lastScrollHeight = currentScrollHeight;
  }
  
  scrollTimeout = setTimeout(() => {
    doScroll();
  }, SCROLL_DELAY);
}

function tryClickLoadMoreButton() {
  const clicked = clickLoadMoreButton();
  if (clicked) {
    console.log('[LinkedIn Analyzer] Button clicked, resetting counters');
    noChangeCount = 0;
    buttonAttempts++;
    
    if (buttonAttempts >= MAX_BUTTON_ATTEMPTS) {
      console.log('[LinkedIn Analyzer] Button attempts exhausted');
    }
  } else {
    console.log('[LinkedIn Analyzer] No button found to click');
  }
}

function clickLoadMoreButton(): boolean {
  const buttons = document.querySelectorAll('button');
  
  for (const btn of buttons) {
    const text = btn.textContent?.toLowerCase() || '';
    const isVisible = (btn as HTMLElement).offsetParent !== null;
    if (!isVisible) continue;
    
    // Russian: "Показать еще результаты для «Обновления в ленте»"
    const isRussianFeedButton = 
      text.includes('показать') && 
      text.includes('результат') && 
      (text.includes('ленте') || text.includes('ленты') || text.includes('обновлен'));
    
    if (isRussianFeedButton) {
      console.log('[LinkedIn Analyzer] Clicking Russian feed button:', text.trim().substring(0, 100));
      btn.click();
      return true;
    }
    
    // English: "show new posts" or "see new posts"
    if ((text.includes('show') || text.includes('see')) && text.includes('new') && text.includes('post')) {
      console.log('[LinkedIn Analyzer] Clicking new posts button:', text.trim().substring(0, 100));
      btn.click();
      return true;
    }
  }
  
  // Commented out other button variants to avoid redirects
  // TODO: Re-enable after testing
  /*
  for (const btn of buttons) {
    const text = btn.textContent?.toLowerCase() || '';
    const isVisible = (btn as HTMLElement).offsetParent !== null;
    if (!isVisible) continue;
    
    if (btn.getAttribute('data-view-name') === 'feed-end-of-feed') {
      console.log('[LinkedIn Analyzer] Clicking feed-end-of-feed button');
      btn.click();
      return true;
    }
    
    const isEnglishFeedButton = 
      text.includes('show') && text.includes('more') && text.includes('result') && 
      (text.includes('feed') || text.includes('update'));
    
    if (isEnglishFeedButton) {
      console.log('[LinkedIn Analyzer] Clicking:', text.trim().substring(0, 100));
      btn.click();
      return true;
    }
    
    if ((text.includes('показать') && (text.includes('еще') || text.includes('ещё'))) ||
        (text.includes('show') && text.includes('more')) ||
        (text.includes('load') && text.includes('more')) ||
        text.includes('загрузить ещё') ||
        text.includes('загрузить еще')) {
      console.log('[LinkedIn Analyzer] Clicking:', text.trim().substring(0, 100));
      btn.click();
      return true;
    }
  }
  */
  
  console.log('[LinkedIn Analyzer] No matching button found');
  return false;
}

function checkIfComplete() {
  chrome.runtime.sendMessage({ type: "GET_COLLECTION_STATE" }, (response) => {
    if (response) {
      console.log('[LinkedIn Analyzer] State:', response.currentCount, '/', response.targetCount, 'isCollecting:', response.isCollecting);
      
      if (!response.isCollecting) {
        console.log('[LinkedIn Analyzer] Collection complete');
        stopAutoScroll();
        return;
      }
      
      if (response.currentCount === lastPostCount) {
        noNewPostsCount++;
        console.log('[LinkedIn Analyzer] No new posts, attempt:', noNewPostsCount);
        
        if (noNewPostsCount >= 2 && noNewPostsCount < MAX_NO_NEW_POSTS) {
          console.log('[LinkedIn Analyzer] Trying button due to no new posts');
          tryClickLoadMoreButton();
        }
        
        if (response.collectAll || response.targetCount === 'all') {
          if (noNewPostsCount >= MAX_NO_NEW_POSTS) {
            console.log('[LinkedIn Analyzer] All posts collected');
            chrome.runtime.sendMessage({ type: "STOP_COLLECTION" });
            stopAutoScroll();
          }
        }
      } else {
        noNewPostsCount = 0;
        buttonAttempts = 0;
        lastPostCount = response.currentCount;
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
