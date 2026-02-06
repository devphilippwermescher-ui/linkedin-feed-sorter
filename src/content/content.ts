import * as XLSX from 'xlsx';

type CollectionMode = 'lite' | 'synced' | 'precision';

interface PostData {
  activityUrn: string;
  authorName: string;
  text?: string;
  numLikes: number;
  numComments: number;
  numShares: number;
}

let isAutoScrolling = false;
let scrollTimeout: ReturnType<typeof setTimeout> | null = null;
let checkInterval: ReturnType<typeof setInterval> | null = null;
let lastScrollHeight = 0;
let noChangeCount = 0;
let overlayElement: HTMLDivElement | null = null;
let currentCollectionMode: CollectionMode = 'precision';

// Cache for DOM elements by URN for reordering
const domElementsCache = new Map<string, Element>();
let originalFeedOrder: string[] = [];
let isReordered = false;

const SCROLL_DELAY = 3000;
const MAX_NO_CHANGE = 4;
const MAX_NO_NEW_POSTS = 8;
const MAX_BUTTON_ATTEMPTS = 3;
const CHECK_INTERVAL = 1500;

let lastPostCount = 0;
let noNewPostsCount = 0;
let buttonAttempts = 0;

console.log('[LinkedIn Analyzer] Content script loaded');

// Cache all visible post elements for later reordering
function cachePostElements(): void {
  const postElements = document.querySelectorAll('[data-id^="urn:li:activity:"], [data-urn^="urn:li:activity:"]');
  
  postElements.forEach((el) => {
    const urn = el.getAttribute('data-id') || el.getAttribute('data-urn');
    const activityMatch = urn?.match(/urn:li:activity:(\d+)/);
    if (activityMatch) {
      const normalizedUrn = `urn:li:activity:${activityMatch[1]}`;
      if (!domElementsCache.has(normalizedUrn)) {
        domElementsCache.set(normalizedUrn, el);
        originalFeedOrder.push(normalizedUrn);
      }
    }
  });
  
  console.log('[LinkedIn Analyzer] Cached', domElementsCache.size, 'post elements');
}

// Get the feed container element
function getFeedContainer(): Element | null {
  // Try main feed container first
  const selectors = [
    '.scaffold-finite-scroll__content[data-finite-scroll-hotkey-context="FEED"]',
    '.scaffold-finite-scroll__content',
    '.core-rail .scaffold-finite-scroll__content',
  ];
  
  for (const selector of selectors) {
    const container = document.querySelector(selector);
    if (container) return container;
  }
  
  return null;
}

// Full-screen reorder overlay
function showReorderOverlay(stage: string, progress: string, detail?: string): void {
  let overlay = document.getElementById('linkedin-analyzer-reorder-overlay');
  
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'linkedin-analyzer-reorder-overlay';
    overlay.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      width: 100vw;
      height: 100vh;
      background: rgba(0, 0, 0, 0.8);
      z-index: 999999;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      backdrop-filter: blur(4px);
    `;
    
    const style = document.createElement('style');
    style.id = 'linkedin-analyzer-reorder-styles';
    style.textContent = `
      @keyframes la-reorder-spin {
        to { transform: rotate(360deg); }
      }
      @keyframes la-reorder-pulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.5; }
      }
    `;
    document.head.appendChild(style);
    document.body.appendChild(overlay);
  }
  
  overlay.innerHTML = `
    <div style="
      background: white;
      padding: 40px 60px;
      border-radius: 20px;
      text-align: center;
      box-shadow: 0 25px 80px rgba(0, 0, 0, 0.4);
      max-width: 400px;
    ">
      <div style="
        width: 60px;
        height: 60px;
        border: 4px solid #e5e7eb;
        border-top-color: #034C9D;
        border-radius: 50%;
        margin: 0 auto 24px;
        animation: la-reorder-spin 1s linear infinite;
      "></div>
      <div style="
        font-size: 14px;
        font-weight: 600;
        color: #034C9D;
        text-transform: uppercase;
        letter-spacing: 1px;
        margin-bottom: 8px;
      ">${stage}</div>
      <div id="la-reorder-progress" style="
        font-size: 28px;
        font-weight: 700;
        color: #1a1a1a;
        margin-bottom: 8px;
      ">${progress}</div>
      ${detail ? `<div id="la-reorder-detail" style="
        font-size: 13px;
        color: #6b7280;
        animation: la-reorder-pulse 2s ease-in-out infinite;
      ">${detail}</div>` : ''}
    </div>
  `;
}

function updateReorderOverlay(stage?: string, progress?: string, detail?: string): void {
  const overlay = document.getElementById('linkedin-analyzer-reorder-overlay');
  if (!overlay) return;
  
  if (stage) {
    const stageEl = overlay.querySelector('div > div:nth-child(2)');
    if (stageEl) stageEl.textContent = stage;
  }
  if (progress) {
    const progressEl = overlay.querySelector('#la-reorder-progress');
    if (progressEl) progressEl.textContent = progress;
  }
  if (detail !== undefined) {
    const detailEl = overlay.querySelector('#la-reorder-detail');
    if (detailEl) detailEl.textContent = detail;
  }
}

function hideReorderOverlay(): void {
  const overlay = document.getElementById('linkedin-analyzer-reorder-overlay');
  const style = document.getElementById('linkedin-analyzer-reorder-styles');
  if (overlay) overlay.remove();
  if (style) style.remove();
}

// Create a post card for posts not found in DOM
function createPostCard(post: PostData, index: number): Element {
  const activityId = post.activityUrn.replace('urn:li:activity:', '');
  const postUrl = `https://www.linkedin.com/feed/update/urn:li:activity:${activityId}/`;
  
  // Truncate text if too long
  const displayText = post.text 
    ? (post.text.length > 300 ? post.text.substring(0, 300) + '...' : post.text)
    : '';
  
  const wrapper = document.createElement('div');
  wrapper.innerHTML = `
    <div data-id="urn:li:activity:${activityId}" class="relative" data-finite-scroll-hotkey-item="${index}">
      <div class="full-height" data-view-name="feed-full-update">
        <div class="full-height">
          <div class="feed-shared-update-v2 feed-shared-update-v2--minimal-padding full-height relative artdeco-card" 
               role="article" 
               data-urn="urn:li:activity:${activityId}"
               style="margin-bottom: 8px;">
            <div style="padding: 12px 16px;">
              <!-- Header -->
              <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 12px;">
                <div style="
                  width: 48px; 
                  height: 48px; 
                  background: linear-gradient(135deg, #034C9D 0%, #0066CC 100%);
                  border-radius: 50%;
                  display: flex;
                  align-items: center;
                  justify-content: center;
                  color: white;
                  font-weight: 700;
                  font-size: 18px;
                ">${post.authorName.charAt(0).toUpperCase()}</div>
                <div style="flex: 1;">
                  <a href="${postUrl}" target="_blank" style="
                    font-size: 14px;
                    font-weight: 600;
                    color: rgba(0,0,0,0.9);
                    text-decoration: none;
                  ">${post.authorName}</a>
                  <div style="
                    font-size: 12px;
                    color: rgba(0,0,0,0.6);
                    display: flex;
                    align-items: center;
                    gap: 4px;
                  ">
                    <span style="
                      background: #f0f7ff;
                      color: #034C9D;
                      padding: 2px 8px;
                      border-radius: 10px;
                      font-size: 10px;
                      font-weight: 600;
                    ">From Analyzer</span>
                  </div>
                </div>
                <a href="${postUrl}" target="_blank" style="
                  padding: 6px 12px;
                  background: #034C9D;
                  color: white;
                  border-radius: 16px;
                  font-size: 12px;
                  font-weight: 600;
                  text-decoration: none;
                ">Open Post</a>
              </div>
              
              <!-- Content -->
              ${displayText ? `
              <div style="
                font-size: 14px;
                color: rgba(0,0,0,0.9);
                line-height: 1.5;
                margin-bottom: 12px;
                white-space: pre-wrap;
              ">${displayText}</div>
              ` : ''}
              
              <!-- Stats -->
              <div style="
                display: flex;
                gap: 16px;
                padding-top: 12px;
                border-top: 1px solid #e5e7eb;
                font-size: 12px;
                color: rgba(0,0,0,0.6);
              ">
                <div style="display: flex; align-items: center; gap: 4px;">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"/>
                  </svg>
                  <span style="font-weight: 600; color: #034C9D;">${post.numLikes.toLocaleString()}</span>
                </div>
                <div style="display: flex; align-items: center; gap: 4px;">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
                  </svg>
                  <span style="font-weight: 600; color: #034C9D;">${post.numComments.toLocaleString()}</span>
                </div>
                <div style="display: flex; align-items: center; gap: 4px;">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M17 1l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/>
                    <path d="M7 23l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>
                  </svg>
                  <span style="font-weight: 600; color: #034C9D;">${post.numShares.toLocaleString()}</span>
                </div>
                <div style="margin-left: auto; display: flex; align-items: center; gap: 4px;">
                  <span style="
                    background: linear-gradient(135deg, #034C9D 0%, #0066CC 100%);
                    color: white;
                    padding: 4px 10px;
                    border-radius: 12px;
                    font-size: 11px;
                    font-weight: 600;
                  ">Engagement: ${(post.numLikes + post.numComments * 2 + post.numShares * 3).toLocaleString()}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
  
  return wrapper.firstElementChild!;
}

// Count posts currently in DOM
function countPostsInDOM(targetUrns: string[]): { found: Set<string>; missing: string[] } {
  const targetUrnSet = new Set(targetUrns);
  const found = new Set<string>();
  
  document.querySelectorAll('[data-id^="urn:li:activity:"], [data-urn^="urn:li:activity:"]').forEach((el) => {
    const urn = el.getAttribute('data-id') || el.getAttribute('data-urn');
    const match = urn?.match(/urn:li:activity:(\d+)/);
    if (match) {
      const normalizedUrn = `urn:li:activity:${match[1]}`;
      if (targetUrnSet.has(normalizedUrn)) {
        found.add(normalizedUrn);
      }
    }
  });
  
  const missing = targetUrns.filter(urn => !found.has(urn));
  return { found, missing };
}

// Ensure all posts are loaded in DOM by scrolling
async function ensurePostsLoadedInDOM(targetUrns: string[]): Promise<{ loaded: number; total: number }> {
  console.log('[LinkedIn Analyzer] Ensuring', targetUrns.length, 'posts are loaded in DOM');
  
  // Initial check
  let { found, missing } = countPostsInDOM(targetUrns);
  
  showReorderOverlay(
    'Step 1: Loading Posts',
    `${found.size} / ${targetUrns.length}`,
    `Checking for ${missing.length} missing posts...`
  );
  
  // If all found, we're done
  if (missing.length === 0) {
    console.log('[LinkedIn Analyzer] All posts already in DOM');
    return { loaded: found.size, total: targetUrns.length };
  }
  
  let lastFoundCount = found.size;
  let noChangeAttempts = 0;
  const maxScrollAttempts = 20;
  const scrollStep = 2000;
  
  // Scroll down to load missing posts
  for (let attempt = 0; attempt < maxScrollAttempts; attempt++) {
    // Scroll down
    const maxScroll = document.documentElement.scrollHeight - window.innerHeight;
    const currentScroll = window.scrollY || 0;
    const nextScroll = Math.min(currentScroll + scrollStep, maxScroll);
    
    window.scrollTo({ top: nextScroll, behavior: 'auto' });
    
    // Wait for content to load
    await new Promise(resolve => setTimeout(resolve, 600));
    
    // Recheck posts
    const result = countPostsInDOM(targetUrns);
    found = result.found;
    missing = result.missing;
    
    updateReorderOverlay(
      undefined,
      `${found.size} / ${targetUrns.length}`,
      missing.length > 0 ? `Scrolling to find ${missing.length} more posts...` : 'All posts found!'
    );
    
    console.log('[LinkedIn Analyzer] Scroll attempt', attempt + 1, '- Found:', found.size, 'Missing:', missing.length);
    
    // All found
    if (missing.length === 0) {
      console.log('[LinkedIn Analyzer] All posts loaded');
      break;
    }
    
    // No progress check
    if (found.size === lastFoundCount) {
      noChangeAttempts++;
      if (noChangeAttempts >= 4) {
        // Try clicking load more button
        updateReorderOverlay(undefined, undefined, 'Trying to load more posts...');
        const clicked = clickLoadMoreButton();
        if (clicked) {
          await new Promise(resolve => setTimeout(resolve, 1500));
          noChangeAttempts = 0;
        } else {
          // Reached end of feed
          console.log('[LinkedIn Analyzer] Cannot load more posts, proceeding with', found.size);
          break;
        }
      }
    } else {
      noChangeAttempts = 0;
      lastFoundCount = found.size;
    }
    
    // If we're at the bottom
    if (nextScroll >= maxScroll - 100) {
      // Try to load more
      const clicked = clickLoadMoreButton();
      if (clicked) {
        await new Promise(resolve => setTimeout(resolve, 1500));
      } else if (noChangeAttempts >= 2) {
        break;
      }
    }
  }
  
  // Final count
  const finalResult = countPostsInDOM(targetUrns);
  return { loaded: finalResult.found.size, total: targetUrns.length };
}

// Reorder feed posts based on sorted URN list
async function reorderFeedPosts(sortedUrns: string[], postsData: PostData[] = [], skipPlaceholders: boolean = false): Promise<{ success: boolean; reorderedCount: number; message: string }> {
  console.log('[LinkedIn Analyzer] Reordering feed with', sortedUrns.length, 'posts,', postsData.length, 'with data');
  
  // Create a map of post data for quick lookup
  const postsDataMap = new Map<string, PostData>();
  postsData.forEach(p => postsDataMap.set(p.activityUrn, p));
  
  try {
    // Step 1: Load all posts into DOM
    const loadResult = await ensurePostsLoadedInDOM(sortedUrns);
    console.log('[LinkedIn Analyzer] Loaded', loadResult.loaded, '/', loadResult.total, 'posts in DOM');
    
    // Step 2: Preparing to reorder
    updateReorderOverlay(
      'Step 2: Preparing',
      'Organizing posts...',
      'Scrolling back to top'
    );
    
    // Scroll back to top before reordering
    window.scrollTo({ top: 0, behavior: 'auto' });
    await new Promise(resolve => setTimeout(resolve, 500));
    
    // Cache all current post elements
    cachePostElements();
    
    const feedContainer = getFeedContainer();
    if (!feedContainer) {
      hideReorderOverlay();
      console.log('[LinkedIn Analyzer] Feed container not found');
      return { success: false, reorderedCount: 0, message: 'Feed container not found' };
    }
    
    // Step 3: Reordering
    updateReorderOverlay(
      'Step 3: Reordering',
      `${sortedUrns.length} posts`,
      'Applying your sort order...'
    );
    
    // Find all direct children that are post containers
    // LinkedIn structure: feedContainer > div (wrapper) > div[data-id] (post)
    const allChildren = Array.from(feedContainer.children);
    const postContainers: Map<string, Element> = new Map();
    const otherElements: Element[] = [];
    
    allChildren.forEach((child) => {
      // Check if this child contains a post
      const postElement = child.querySelector('[data-id^="urn:li:activity:"], [data-urn^="urn:li:activity:"]') ||
                         (child.getAttribute('data-id')?.includes('activity:') ? child : null);
      
      if (postElement) {
        const urn = postElement.getAttribute('data-id') || postElement.getAttribute('data-urn');
        const activityMatch = urn?.match(/urn:li:activity:(\d+)/);
        if (activityMatch) {
          const normalizedUrn = `urn:li:activity:${activityMatch[1]}`;
          
          // Check if this is a real post with content, not just an occludable placeholder
          const hasContent = child.querySelector('.feed-shared-update-v2, .update-components-actor, .feed-shared-text');
          const isOccludableHint = child.querySelector('.occludable-update-hint');
          const isEmpty = isOccludableHint && !hasContent;
          
          if (!isEmpty) {
            // Store the wrapper div (direct child of feed container)
            postContainers.set(normalizedUrn, child);
          } else {
            console.log('[LinkedIn Analyzer] Skipping empty placeholder:', normalizedUrn);
          }
        }
      } else {
        // Keep skip links and other non-post elements, but exclude empty post placeholders
        const hasEmptyPlaceholder = child.querySelector('.occludable-update-hint:empty') ||
          (child.querySelector('.occludable-update') && !child.querySelector('.feed-shared-update-v2'));
        
        if (!child.classList.contains('feed-skip-link__container') && !hasEmptyPlaceholder) {
          otherElements.push(child);
        }
      }
    });
    
    console.log('[LinkedIn Analyzer] Found', postContainers.size, 'post containers,', otherElements.length, 'other elements');
    
    if (postContainers.size === 0) {
      hideReorderOverlay();
      return { success: false, reorderedCount: 0, message: 'No posts found in feed' };
    }
    
    // Create a document fragment to build the new order
    const fragment = document.createDocumentFragment();
    let reorderedCount = 0;
    const processedUrns = new Set<string>();
    
    // First, add posts in the sorted order
    // IMPORTANT: Move original DOM nodes (not clone) to preserve Ember event listeners
    let createdCount = 0;
    for (const urn of sortedUrns) {
      const container = postContainers.get(urn);
      
      const hasRealContent = container && (
        container.querySelector('.feed-shared-update-v2__description') ||
        container.querySelector('.update-components-actor') ||
        container.querySelector('.feed-shared-text') ||
        container.querySelector('.update-components-text')
      );
      
      if (container && hasRealContent && !processedUrns.has(urn)) {
        // Move the original element (preserves all event listeners)
        const hotkeyEl = container.querySelector('[data-finite-scroll-hotkey-item]');
        if (hotkeyEl) {
          hotkeyEl.setAttribute('data-finite-scroll-hotkey-item', reorderedCount.toString());
        }
        fragment.appendChild(container);
        reorderedCount++;
        processedUrns.add(urn);
      } else if (!skipPlaceholders && postsDataMap.has(urn) && !processedUrns.has(urn)) {
        const postData = postsDataMap.get(urn)!;
        console.log('[LinkedIn Analyzer] Creating card for missing/empty post:', postData.authorName);
        const card = createPostCard(postData, reorderedCount);
        fragment.appendChild(card);
        reorderedCount++;
        createdCount++;
        processedUrns.add(urn);
      }
    }
    
    if (createdCount > 0) {
      console.log('[LinkedIn Analyzer] Created', createdCount, 'cards for missing posts');
    }
    
    // Add any remaining posts that weren't in the sorted list
    postContainers.forEach((container, urn) => {
      if (!processedUrns.has(urn)) {
        const hasRealContent = container.querySelector('.feed-shared-update-v2__description') ||
          container.querySelector('.update-components-actor') ||
          container.querySelector('.feed-shared-text') ||
          container.querySelector('.update-components-text');
        
        if (hasRealContent) {
          const hotkeyEl = container.querySelector('[data-finite-scroll-hotkey-item]');
          if (hotkeyEl) {
            hotkeyEl.setAttribute('data-finite-scroll-hotkey-item', reorderedCount.toString());
          }
          fragment.appendChild(container);
          reorderedCount++;
        }
      }
    });
    
    // Clear any remaining children from the feed container
    while (feedContainer.firstChild) {
      feedContainer.removeChild(feedContainer.firstChild);
    }
    
    // Append all reordered posts (original nodes with preserved event listeners)
    feedContainer.appendChild(fragment);
    
    // Move back other elements (not clone) to preserve their event listeners too
    otherElements.forEach((el) => {
      feedContainer.appendChild(el);
    });
  
    isReordered = true;
    
    // Hide reorder overlay
    hideReorderOverlay();
    
    // Small delay before scrolling to top
    await new Promise(resolve => setTimeout(resolve, 200));
    
    // Scroll to top to show reordered content
    window.scrollTo({ top: 0, behavior: 'smooth' });
    
    console.log('[LinkedIn Analyzer] Feed reordered,', reorderedCount, 'posts placed');
    
    // Show success notification
    showReorderNotification(reorderedCount);
    
    return { success: true, reorderedCount, message: `Successfully reordered ${reorderedCount} posts` };
    
  } catch (error) {
    hideReorderOverlay();
    console.log('[LinkedIn Analyzer] Reorder error:', error);
    return { success: false, reorderedCount: 0, message: (error as Error).message || 'Unknown error' };
  }
}

// Show notification after reordering
function showReorderNotification(count: number): void {
  const notification = document.createElement('div');
  notification.id = 'linkedin-analyzer-notification';
  notification.style.cssText = `
    position: fixed;
    top: 20px;
    left: 50%;
    transform: translateX(-50%);
    background: linear-gradient(135deg, #034C9D 0%, #0066CC 100%);
    color: white;
    padding: 16px 32px;
    border-radius: 12px;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    font-size: 16px;
    font-weight: 600;
    box-shadow: 0 8px 30px rgba(3, 76, 157, 0.4);
    z-index: 999999;
    display: flex;
    align-items: center;
    gap: 12px;
    animation: slideDown 0.3s ease;
  `;
  
  notification.innerHTML = `
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M9 12l2 2 4-4"/>
      <circle cx="12" cy="12" r="10"/>
    </svg>
    <span>Feed reordered: ${count} posts sorted by engagement</span>
  `;
  
  const style = document.createElement('style');
  style.textContent = `
    @keyframes slideDown {
      from { opacity: 0; transform: translateX(-50%) translateY(-20px); }
      to { opacity: 1; transform: translateX(-50%) translateY(0); }
    }
  `;
  
  document.head.appendChild(style);
  document.body.appendChild(notification);
  
  // Remove after 4 seconds
  setTimeout(() => {
    notification.style.animation = 'slideDown 0.3s ease reverse';
    setTimeout(() => notification.remove(), 300);
  }, 4000);
}

// Restore original feed order
function restoreOriginalOrder(): { success: boolean; message: string } {
  if (!isReordered) {
    return { success: false, message: 'Feed is not reordered' };
  }
  
  // Simply reload the page to restore original order
  window.location.reload();
  return { success: true, message: 'Restoring original order...' };
}

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
    
    const mainSocialActivity = postEl.querySelector('.update-v2-social-activity');
    const searchContainer = mainSocialActivity || postEl;
    
    const isInComments = (el: Element): boolean => {
      let parent = el.parentElement;
      while (parent && parent !== postEl) {
        if (parent.className?.includes('comments-')) return true;
        parent = parent.parentElement;
      }
      return false;
    };
    
    let numLikes = 0;
    const reactionsBtns = searchContainer.querySelectorAll('[data-reaction-details]');
    for (const reactionsBtn of reactionsBtns) {
      if (isInComments(reactionsBtn)) continue;
      const ariaLabel = reactionsBtn.getAttribute('aria-label') || '';
      const match = ariaLabel.match(/([\d\s\u00A0]+)/);
      if (match) {
        numLikes = parseNumberWithSpaces(match[1]);
        break;
      }
    }
    
    if (numLikes === 0) {
      const likesCountEls = searchContainer.querySelectorAll('.social-details-social-counts__reactions-count');
      for (const likesCountEl of likesCountEls) {
        if (isInComments(likesCountEl)) continue;
        const likesText = likesCountEl.textContent?.trim() || '';
        numLikes = parseNumberWithSpaces(likesText);
        if (numLikes > 0) break;
      }
    }
    
    if (numLikes === 0) {
      const socialCountsContainers = searchContainer.querySelectorAll('.social-details-social-counts__reactions');
      for (const socialCountsContainer of socialCountsContainers) {
        if (isInComments(socialCountsContainer)) continue;
        const fullText = socialCountsContainer.textContent || '';
        const moreMatch = fullText.match(/(?:и еще|and)\s*([\d\s\u00A0]+)/i);
        if (moreMatch) {
          const additionalCount = parseNumberWithSpaces(moreMatch[1]);
          if (additionalCount > 0) {
            numLikes = 1 + additionalCount;
            break;
          }
        }
      }
    }
    
    let numComments = 0;
    const commentsLinks = searchContainer.querySelectorAll('.social-details-social-counts__comments button');
    for (const commentsLink of commentsLinks) {
      if (isInComments(commentsLink)) continue;
      const ariaLabel = commentsLink.getAttribute('aria-label') || '';
      const match = ariaLabel.match(/([\d\s\u00A0]+)/);
      if (match) {
        numComments = parseNumberWithSpaces(match[1]);
        break;
      }
      
      if (numComments === 0) {
        const text = commentsLink.textContent?.trim() || '';
        numComments = parseNumberWithSpaces(text);
        if (numComments > 0) break;
      }
    }
    
    if (numComments === 0) {
      const commentBtns = searchContainer.querySelectorAll('button[aria-label*="комментар"], button[aria-label*="comment"]');
      for (const commentBtn of commentBtns) {
        if (isInComments(commentBtn)) continue;
        const ariaLabel = commentBtn.getAttribute('aria-label') || '';
        if (ariaLabel.includes('к публикации') || ariaLabel.includes('to post') || ariaLabel.includes('comments on')) {
          const match = ariaLabel.match(/([\d\s\u00A0]+)/);
          if (match) {
            numComments = parseNumberWithSpaces(match[1]);
            break;
          }
        }
      }
    }
    
    let numShares = 0;
    const allButtons = searchContainer.querySelectorAll('.social-details-social-counts button');
    for (const btn of allButtons) {
      if (isInComments(btn)) continue;
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

function collectPostsFromDOM(): Promise<number> {
  return new Promise((resolve) => {
    const postElements = document.querySelectorAll('[data-urn^="urn:li:activity:"], [data-id^="urn:li:activity:"]');
    const posts: any[] = [];
    
    postElements.forEach((postEl) => {
      const post = parsePostElement(postEl);
      if (post) {
        posts.push(post);
      }
    });
    
    if (posts.length > 0) {
      console.log('[LinkedIn Analyzer] Collected', posts.length, 'posts from DOM');
      chrome.runtime.sendMessage({
        type: "DOM_POSTS",
        posts: posts,
      }, () => {
        // Get updated count from background
        chrome.runtime.sendMessage({ type: "GET_COLLECTION_STATE" }, (state) => {
          resolve(state?.currentCount || posts.length);
        });
      });
    } else {
      resolve(0);
    }
  });
}

function initializeAfterLoad() {
  // First check for pending Quick Panel action
  chrome.storage.local.get(['qp_pending'], (result) => {
    const pending = result.qp_pending;
    
    if (pending && pending.sortType && pending.count && (Date.now() - pending.ts < 30000)) {
      // Quick Panel action pending - DON'T do anything else
      // qp_checkPending() will handle everything
      console.log('[LinkedIn Analyzer] QP pending, skipping normal init');
      return;
    }
    
    // No Quick Panel pending - check for active collection from popup
    console.log('[LinkedIn Analyzer] Page ready, checking collection state...');
    
    chrome.runtime.sendMessage({ type: "GET_COLLECTION_STATE" }, (response) => {
      // Double-check QP isn't active now
      if (qp_isActive) return;
      
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

  if (message.type === "REORDER_FEED") {
    // Handle async reorder with full post data
    const postsData: PostData[] = message.postsData || [];
    const sortedUrns: string[] = message.sortedUrns || postsData.map(p => p.activityUrn);
    
    reorderFeedPosts(sortedUrns, postsData).then((result) => {
      sendResponse(result);
    }).catch((error) => {
      console.log('[LinkedIn Analyzer] Reorder error:', error);
      sendResponse({ success: false, reorderedCount: 0, message: error.message });
    });
    return true; // Keep message channel open for async response
  }

  if (message.type === "RESTORE_FEED") {
    const result = restoreOriginalOrder();
    sendResponse(result);
    return true;
  }

  if (message.type === "CACHE_POSTS") {
    cachePostElements();
    sendResponse({ success: true, cachedCount: domElementsCache.size });
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
  
  const state = await new Promise<any>((resolve) => {
    chrome.runtime.sendMessage({ type: "GET_COLLECTION_STATE" }, resolve);
  });
  
  if (state) {
    currentCollectionMode = state.collectionMode || 'precision';
    showOverlay(state.currentCount, state.targetCount);
    console.log('[LinkedIn Analyzer] Collection mode:', currentCollectionMode);
  }
  
  await waitForFeedToLoad();
  
  isAutoScrolling = true;
  lastScrollHeight = 0;
  noChangeCount = 0;
  noNewPostsCount = 0;
  lastPostCount = 0;
  buttonAttempts = 0;
  
  if (currentCollectionMode === 'precision') {
    collectPostsFromDOM();
  }
  
  checkInterval = setInterval(() => {
    if (!isAutoScrolling) {
      if (checkInterval) clearInterval(checkInterval);
      return;
    }
    updateOverlayCount();
    checkIfComplete();
    
    if (currentCollectionMode === 'lite') {
      return;
    }
    
    chrome.runtime.sendMessage({ type: "GET_COLLECTION_STATE" }, (response) => {
      if (response && response.currentCount > 0) {
        syncPostsWithDOM();
      } else if (currentCollectionMode === 'precision') {
        collectPostsFromDOM();
      }
    });
  }, CHECK_INTERVAL);
  
  doScroll();
}

function getScrollContainer(): Element | null {
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
  
  if (currentCollectionMode !== 'lite') {
    setTimeout(() => {
      chrome.runtime.sendMessage({ type: "GET_COLLECTION_STATE" }, (response) => {
        if (response && response.currentCount > 0) {
          syncPostsWithDOM();
        } else if (currentCollectionMode === 'precision') {
          collectPostsFromDOM();
        }
      });
    }, 1000);
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
    
    const isRussianFeedButton = 
      text.includes('показать') && 
      text.includes('результат') && 
      (text.includes('ленте') || text.includes('ленты') || text.includes('обновлен'));
    
    if (isRussianFeedButton) {
      console.log('[LinkedIn Analyzer] Clicking Russian feed button:', text.trim().substring(0, 100));
      btn.click();
      return true;
    }
    
    if ((text.includes('show') || text.includes('see')) && text.includes('new') && text.includes('post')) {
      console.log('[LinkedIn Analyzer] Clicking new posts button:', text.trim().substring(0, 100));
      btn.click();
      return true;
    }
  }
  
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

// Inject sort controls into LinkedIn feed page
function injectSortControls(): void {
  if (document.getElementById('linkedin-analyzer-sort-controls')) return;
  
  let feedToggleWrapper: Element | null = null;
  
  // 1) .feed-sort-toggle-dsa__wrapper
  feedToggleWrapper = document.querySelector('.feed-sort-toggle-dsa__wrapper');
  
  // 2) HR with feed-index-sort-border class (unique to sort dropdown)
  if (!feedToggleWrapper) {
    const hr = document.querySelector('hr.feed-index-sort-border');
    if (hr) {
      feedToggleWrapper = hr.closest('.artdeco-dropdown') || hr.closest('.mb2');
    }
  }
  
  // 3) Dropdown with sort text
  if (!feedToggleWrapper) {
    const buttons = document.querySelectorAll('button.artdeco-dropdown__trigger');
    for (const btn of buttons) {
      const text = btn.textContent || '';
      if (text.includes('Сортировать') || text.includes('Sort by') || text.includes('Sortieren')) {
        feedToggleWrapper = btn.closest('.artdeco-dropdown');
        break;
      }
    }
  }
  
  if (!feedToggleWrapper) {
    console.log('[LinkedIn Analyzer] Feed toggle not found, retrying...');
    setTimeout(injectSortControls, 2000);
    return;
  }
  
  console.log('[LinkedIn Analyzer] Feed toggle found:', feedToggleWrapper.className);
  
  // Load user plan before rendering
  chrome.storage.local.get(['userPlan'], (result) => {
    qp_userPlan = result.userPlan || 'free';
    renderQuickPanel(feedToggleWrapper!);
  });
}

function renderQuickPanel(feedToggleWrapper: Element): void {
  const isFree = qp_userPlan === 'free';
  
  // Create our sort controls container
  const sortControls = document.createElement('div');
  sortControls.id = 'linkedin-analyzer-sort-controls';
  sortControls.innerHTML = `
    <style>
      #linkedin-analyzer-sort-controls {
        display: flex;
        flex-direction: column;
        gap: 10px;
        padding: 12px 16px;
        margin: 8px 0;
        background: white;
        border-radius: 8px;
        box-shadow: 0 1px 3px rgba(0,0,0,0.08), 0 1px 2px rgba(0,0,0,0.06);
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      }
      
      .la-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
      }
      
      .la-title {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      
      .la-icon {
        width: 20px;
        height: 20px;
        color: #0077B5;
      }
      
      .la-title.premium .la-icon {
        color: #d97706;
      }
      
      .la-title-text {
        font-size: 13px;
        font-weight: 600;
        color: #0077B5;
      }
      
      .la-title.premium .la-title-text {
        color: #d97706;
      }
      
      .la-count-selector {
        display: flex;
        align-items: center;
        gap: 6px;
      }
      
      .la-count-label {
        font-size: 11px;
        color: #9ca3af;
      }
      
      .la-count-btn {
        padding: 4px 10px;
        font-size: 11px;
        font-weight: 600;
        border: 1px solid #e5e7eb;
        border-radius: 12px;
        background: white;
        color: #6b7280;
        cursor: pointer;
        transition: all 0.15s ease;
      }
      
      .la-count-btn:hover {
        border-color: #0077B5;
        color: #0077B5;
      }
      
      .la-count-btn.active {
        background: #0077B5;
        color: white;
        border-color: #0077B5;
      }
      
      .la-count-btn.locked {
        opacity: 0.5;
        cursor: pointer;
      }
      
      .la-count-btn.locked:hover {
        border-color: #f59e0b;
        color: #d97706;
        opacity: 0.7;
      }
      
      .la-sort-row {
        display: flex;
        align-items: center;
        gap: 6px;
      }
      
      .la-sort-btn {
        flex: 1;
        padding: 10px 8px;
        font-size: 12px;
        font-weight: 500;
        border: 1px solid #e5e7eb;
        border-radius: 8px;
        background: white;
        color: #374151;
        cursor: pointer;
        transition: all 0.2s ease;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 4px;
      }
      
      .la-sort-btn:hover {
        background: #f0f9ff;
        border-color: #0077B5;
        color: #0077B5;
      }
      
      .la-sort-btn.active {
        background: linear-gradient(135deg, #0077B5 0%, #00A0DC 100%);
        color: white;
        border-color: transparent;
        box-shadow: 0 2px 8px rgba(0, 119, 181, 0.25);
      }
      
      .la-sort-btn.loading {
        opacity: 0.7;
        pointer-events: none;
        animation: la-loading 1.5s ease-in-out infinite;
      }
      
      @keyframes la-loading {
        0%, 100% { opacity: 0.7; }
        50% { opacity: 0.4; }
      }
      
      .la-sort-btn svg {
        width: 18px;
        height: 18px;
      }
      
      .la-sort-btn span {
        font-size: 11px;
      }
      
      .la-restore-btn {
        padding: 8px 16px;
        font-size: 12px;
        font-weight: 500;
        border: 1px solid #fee2e2;
        border-radius: 8px;
        background: #fef2f2;
        color: #dc2626;
        cursor: pointer;
        transition: all 0.2s ease;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
      }
      
      .la-restore-btn:hover {
        background: #fee2e2;
        border-color: #fecaca;
      }
      
      .la-restore-btn svg {
        width: 14px;
        height: 14px;
      }
      
      .la-export-row {
        display: none;
        align-items: center;
        gap: 6px;
      }
      
      .la-export-wrapper {
        flex: 1;
        position: relative;
      }
      
      .la-export-trigger {
        width: 100%;
        padding: 8px 16px;
        font-size: 12px;
        font-weight: 500;
        border: 1px solid #dbeafe;
        border-radius: 8px;
        background: #eff6ff;
        color: #2563eb;
        cursor: pointer;
        transition: all 0.2s ease;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
      }
      
      .la-export-trigger:hover {
        background: #dbeafe;
        border-color: #93c5fd;
      }
      
      .la-export-trigger svg {
        width: 14px;
        height: 14px;
      }
      
      .la-export-dropdown {
        display: none;
        position: absolute;
        bottom: calc(100% + 6px);
        left: 0;
        right: 0;
        background: white;
        border: 1px solid #e5e7eb;
        border-radius: 12px;
        box-shadow: 0 8px 24px rgba(0,0,0,0.12), 0 2px 6px rgba(0,0,0,0.06);
        padding: 8px;
        z-index: 100;
        animation: la-dropdown-in 0.18s ease;
        gap: 6px;
      }
      
      .la-export-dropdown.open {
        display: flex;
        flex-direction: column;
      }
      
      @keyframes la-dropdown-in {
        from { opacity: 0; transform: translateY(6px); }
        to { opacity: 1; transform: translateY(0); }
      }
      
      .la-export-option {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 10px 14px;
        border: 1px solid #e5e7eb;
        background: #fafafa;
        border-radius: 10px;
        font-size: 12px;
        font-weight: 500;
        color: #374151;
        cursor: pointer;
        transition: all 0.15s ease;
        font-family: inherit;
      }
      
      .la-export-option:hover {
        transform: translateY(-1px);
        box-shadow: 0 2px 8px rgba(0,0,0,0.06);
      }
      
      .la-export-option--excel:hover {
        background: #f0fdf4;
        border-color: #86efac;
      }
      
      .la-export-option--csv:hover {
        background: #eff6ff;
        border-color: #93c5fd;
      }
      
      .la-export-option--json:hover {
        background: #fffbeb;
        border-color: #fcd34d;
      }
      
      .la-export-option-icon {
        width: 34px;
        height: 34px;
        border-radius: 8px;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 11px;
        font-weight: 800;
        flex-shrink: 0;
        letter-spacing: -0.3px;
      }
      
      .la-export-option-icon--excel {
        background: #dcfce7;
        color: #16a34a;
        border: 1px solid #bbf7d0;
      }
      
      .la-export-option-icon--csv {
        background: #dbeafe;
        color: #2563eb;
        border: 1px solid #bfdbfe;
      }
      
      .la-export-option-icon--json {
        background: #fef3c7;
        color: #d97706;
        border: 1px solid #fde68a;
      }
      
      .la-export-option-text {
        display: flex;
        flex-direction: column;
        gap: 2px;
        text-align: left;
      }
      
      .la-export-option-text strong {
        font-size: 13px;
        font-weight: 600;
        color: #1a1a1a;
      }
      
      .la-export-option-text span {
        font-size: 11px;
        color: #9ca3af;
      }
      
      .la-status {
        display: none;
        align-items: center;
        justify-content: center;
        gap: 8px;
        padding: 8px;
        background: #f0f9ff;
        border-radius: 6px;
        font-size: 12px;
        color: #0077B5;
      }
      
      .la-status.visible {
        display: flex;
      }
      
      .la-spinner {
        width: 14px;
        height: 14px;
        border: 2px solid #e0f2fe;
        border-top-color: #0077B5;
        border-radius: 50%;
        animation: la-spin 0.8s linear infinite;
      }
      
      @keyframes la-spin {
        to { transform: rotate(360deg); }
      }
      
      #la-premium-modal-backdrop {
        position: fixed;
        top: 0; left: 0;
        width: 100vw; height: 100vh;
        background: rgba(0, 0, 0, 0.6);
        z-index: 999998;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      
      #la-premium-modal {
        background: white;
        border-radius: 16px;
        padding: 32px 28px;
        width: 400px;
        max-width: 90vw;
        position: relative;
        box-shadow: 0 20px 60px rgba(0,0,0,0.3);
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      }
      
      .la-pm-close {
        position: absolute; top: 12px; right: 14px;
        background: none; border: none;
        font-size: 20px; color: #9ca3af;
        cursor: pointer; padding: 4px; line-height: 1;
      }
      .la-pm-close:hover { color: #4b5563; }
      .la-pm-icon { font-size: 36px; text-align: center; margin-bottom: 8px; }
      .la-pm-title { font-size: 22px; font-weight: 700; color: #1a1a1a; text-align: center; margin-bottom: 4px; }
      .la-pm-subtitle { font-size: 14px; color: #6b7280; text-align: center; margin-bottom: 24px; }
      .la-pm-features { display: flex; flex-direction: column; gap: 12px; margin-bottom: 24px; }
      .la-pm-feature { display: flex; align-items: flex-start; gap: 12px; padding: 12px 14px; background: #fefce8; border: 1px solid #fde68a; border-radius: 12px; }
      .la-pm-feature-icon { font-size: 22px; flex-shrink: 0; }
      .la-pm-feature-text { display: flex; flex-direction: column; gap: 2px; }
      .la-pm-feature-text strong { font-size: 14px; font-weight: 600; color: #1a1a1a; }
      .la-pm-feature-text span { font-size: 12px; color: #6b7280; }
      .la-pm-cta {
        width: 100%; padding: 16px 24px;
        background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%);
        color: white; border: none; border-radius: 12px;
        font-size: 16px; font-weight: 700; cursor: pointer;
        transition: all 0.2s ease;
        box-shadow: 0 4px 16px rgba(245, 158, 11, 0.35);
      }
      .la-pm-cta:hover { transform: translateY(-2px); box-shadow: 0 6px 20px rgba(245, 158, 11, 0.5); }
      .la-pm-price { font-size: 13px; color: #9ca3af; text-align: center; margin-top: 12px; }
    </style>
    
    <div class="la-header">
      <div class="la-title${isFree ? '' : ' premium'}">
        <svg class="la-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>
        </svg>
        <span class="la-title-text">LinkedIn Analyzer</span>
      </div>
      
      <div class="la-count-selector">
        <span class="la-count-label">Posts:</span>
        <button class="la-count-btn active" data-count="25">25</button>
        <button class="la-count-btn${isFree ? ' locked' : ''}" data-count="50">50${isFree ? ' 🔒' : ''}</button>
        <button class="la-count-btn${isFree ? ' locked' : ''}" data-count="100">100${isFree ? ' 🔒' : ''}</button>
      </div>
    </div>
    
    <div class="la-sort-row">
      <button class="la-sort-btn" data-sort="likes">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"/>
        </svg>
        <span>Likes</span>
      </button>
      <button class="la-sort-btn" data-sort="comments">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
        </svg>
        <span>Comments</span>
      </button>
      <button class="la-sort-btn" data-sort="shares">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M17 1l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/>
          <path d="M7 23l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>
        </svg>
        <span>Shares</span>
      </button>
      <button class="la-sort-btn" data-sort="engagement">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>
        </svg>
        <span>Best</span>
      </button>
    </div>
    
    <div class="la-status" id="la-status">
      <div class="la-spinner"></div>
      <span id="la-status-text">Collecting posts...</span>
    </div>
    
    <div class="la-export-row" id="la-export-row">
      <div class="la-export-wrapper">
        <button class="la-export-trigger" id="la-export-trigger">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
            <polyline points="7 10 12 15 17 10"/>
            <line x1="12" y1="15" x2="12" y2="3"/>
          </svg>
          Export Data
        </button>
        <div class="la-export-dropdown" id="la-export-dropdown">
        <button class="la-export-option la-export-option--excel" data-export="excel">
          <div class="la-export-option-icon la-export-option-icon--excel">XLS</div>
          <div class="la-export-option-text">
            <strong>Excel</strong>
            <span>Spreadsheet (.xlsx)</span>
          </div>
        </button>
        <button class="la-export-option la-export-option--csv" data-export="csv">
          <div class="la-export-option-icon la-export-option-icon--csv">CSV</div>
          <div class="la-export-option-text">
            <strong>CSV</strong>
            <span>Comma-separated (.csv)</span>
          </div>
        </button>
        <button class="la-export-option la-export-option--json" data-export="json">
          <div class="la-export-option-icon la-export-option-icon--json">{ }</div>
          <div class="la-export-option-text">
            <strong>JSON</strong>
            <span>Raw data (.json)</span>
          </div>
        </button>
      </div>
      </div>
      <button class="la-restore-btn" id="la-restore-btn" style="flex: unset; padding: 8px 12px;">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>
          <path d="M3 3v5h5"/>
        </svg>
        Restore
      </button>
    </div>
  `;
  
  // Insert after the feed toggle
  feedToggleWrapper.parentNode?.insertBefore(sortControls, feedToggleWrapper.nextSibling);
  
  // Add event listeners
  setupSortControlsListeners();
  
  console.log('[LinkedIn Analyzer] Quick Panel injected');
}

// Quick Panel state
let qp_selectedCount = 25;
let qp_userPlan: 'free' | 'premium' = 'free';
let qp_isActive = false;
let qp_sortType: string | null = null;
let qp_targetCount = 25;
let qp_posts: Map<string, any> = new Map();
let qp_sortedPosts: PostData[] = [];
let qp_isScrolling = false;
let qp_scrollTimeout: ReturnType<typeof setTimeout> | null = null;
let qp_checkInterval: ReturnType<typeof setInterval> | null = null;
let qp_lastScrollHeight = 0;
let qp_noChangeCount = 0;
let qp_noNewPostsCount = 0;
let qp_lastPostCount = 0;

const QP_SCROLL_DELAY = 3000;
const QP_CHECK_INTERVAL = 1500;
const QP_MAX_NO_CHANGE = 4;
const QP_MAX_NO_NEW_POSTS = 8;

function setupSortControlsListeners(): void {
  const sortButtons = document.querySelectorAll('.la-sort-btn');
  const countButtons = document.querySelectorAll('.la-count-btn');
  const restoreBtn = document.getElementById('la-restore-btn');
  
  countButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      if (qp_isActive) return;
      
      const count = parseInt(btn.getAttribute('data-count') || '25', 10);
      
      if (btn.classList.contains('locked')) {
        qp_showPremiumModal();
        return;
      }
      
      countButtons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      qp_selectedCount = count;
    });
  });
  
  sortButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const sortType = btn.getAttribute('data-sort');
      if (!sortType || qp_isActive) return;
      
      chrome.storage.local.set({
        qp_pending: { sortType, count: qp_selectedCount, ts: Date.now() }
      }, () => {
        window.location.reload();
      });
    });
  });
  
  if (restoreBtn) {
    restoreBtn.addEventListener('click', () => location.reload());
  }
  
  const exportTrigger = document.getElementById('la-export-trigger');
  const exportDropdown = document.getElementById('la-export-dropdown');
  
  if (exportTrigger && exportDropdown) {
    exportTrigger.addEventListener('click', (e) => {
      e.stopPropagation();
      exportDropdown.classList.toggle('open');
    });
    
    document.addEventListener('click', () => {
      exportDropdown.classList.remove('open');
    });
    
    exportDropdown.addEventListener('click', (e) => {
      e.stopPropagation();
    });
    
    document.querySelectorAll('.la-export-option').forEach(btn => {
      btn.addEventListener('click', () => {
        const format = btn.getAttribute('data-export');
        if (format === 'excel') qp_exportExcel();
        else if (format === 'csv') qp_exportCSV();
        else if (format === 'json') qp_exportJSON();
        exportDropdown.classList.remove('open');
      });
    });
  }
}

function qp_showPremiumModal(): void {
  const existing = document.getElementById('la-premium-modal-backdrop');
  if (existing) existing.remove();
  
  const backdrop = document.createElement('div');
  backdrop.id = 'la-premium-modal-backdrop';
  backdrop.innerHTML = `
    <div id="la-premium-modal">
      <button class="la-pm-close" id="la-pm-close">&times;</button>
      <div class="la-pm-icon">⚡</div>
      <div class="la-pm-title">Upgrade to Premium</div>
      <div class="la-pm-subtitle">Unlock the full power of LinkedIn Analyzer</div>
      <div class="la-pm-features">
        <div class="la-pm-feature">
          <span class="la-pm-feature-icon">📊</span>
          <div class="la-pm-feature-text">
            <strong>Sort up to 2000 posts</strong>
            <span>Free plan is limited to 25 posts</span>
          </div>
        </div>
        <div class="la-pm-feature">
          <span class="la-pm-feature-icon">🔍</span>
          <div class="la-pm-feature-text">
            <strong>Deep feed analysis</strong>
            <span>Analyze large feeds with precision</span>
          </div>
        </div>
        <div class="la-pm-feature">
          <span class="la-pm-feature-icon">⚡</span>
          <div class="la-pm-feature-text">
            <strong>Quick Panel — unlimited</strong>
            <span>Sort 50, 100+ posts directly from feed</span>
          </div>
        </div>
        <div class="la-pm-feature">
          <span class="la-pm-feature-icon">🚀</span>
          <div class="la-pm-feature-text">
            <strong>Priority support</strong>
            <span>Get help faster when you need it</span>
          </div>
        </div>
      </div>
      <button class="la-pm-cta" id="la-pm-cta">Get Premium</button>
      <div class="la-pm-price">Starting at $4.99/month</div>
    </div>
  `;
  document.body.appendChild(backdrop);
  
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) backdrop.remove();
  });
  
  document.getElementById('la-pm-close')?.addEventListener('click', () => backdrop.remove());
  document.getElementById('la-pm-cta')?.addEventListener('click', () => {
    // TODO: link to payment page
    backdrop.remove();
  });
}

function qp_checkPending(): void {
  chrome.storage.local.get(['qp_pending'], (result) => {
    const p = result.qp_pending;
    if (!p || !p.sortType || !p.count || (Date.now() - p.ts > 30000)) {
      chrome.storage.local.remove(['qp_pending']);
      return;
    }
    
    console.log('[QP] Found pending:', p.sortType, p.count);
    chrome.storage.local.remove(['qp_pending']);
    qp_start(p.sortType, p.count);
  });
}

function qp_start(sortType: string, targetCount: number): void {
  if (qp_isActive || qp_isScrolling) return;
  
  console.log('[QP] Starting:', sortType, targetCount);
  
  qp_isActive = true;
  qp_sortType = sortType;
  qp_targetCount = targetCount;
  qp_posts = new Map();
  qp_isScrolling = false;
  qp_lastScrollHeight = 0;
  qp_noChangeCount = 0;
  qp_noNewPostsCount = 0;
  qp_lastPostCount = 0;
  
  qp_updateUI(sortType, targetCount, 'collecting');
  qp_showOverlay(0, targetCount);
  qp_startAutoScroll();
}

async function qp_startAutoScroll(): Promise<void> {
  if (qp_isScrolling) return;
  
  console.log('[QP] Starting auto-scroll');
  qp_isScrolling = true;
  
  qp_collectFromDOM();
  qp_updateOverlay(qp_posts.size, qp_targetCount);
  
  qp_checkInterval = setInterval(() => {
    if (!qp_isScrolling) {
      if (qp_checkInterval) clearInterval(qp_checkInterval);
      return;
    }
    
    qp_collectFromDOM();
    qp_updateOverlay(qp_posts.size, qp_targetCount);
    qp_checkIfComplete();
  }, QP_CHECK_INTERVAL);
  
  qp_doScroll();
}

function qp_doScroll(): void {
  if (!qp_isScrolling) return;
  
  const scrollContainer = getScrollContainer();
  const currentScrollHeight = scrollContainer?.scrollHeight || document.body.scrollHeight;
  
  console.log('[QP] Scrolling to:', currentScrollHeight);
  
  try {
    if (scrollContainer) scrollContainer.scrollTop = currentScrollHeight;
    window.scrollTo({ top: currentScrollHeight, behavior: 'auto' });
    document.documentElement.scrollTop = currentScrollHeight;
    document.body.scrollTop = currentScrollHeight;
  } catch (e) {
    console.log('[QP] Scroll error:', e);
  }
  
  setTimeout(() => {
    qp_collectFromDOM();
    qp_updateOverlay(qp_posts.size, qp_targetCount);
  }, 1200);
  
  if (currentScrollHeight === qp_lastScrollHeight) {
    qp_noChangeCount++;
    console.log('[QP] No scroll change, attempt:', qp_noChangeCount);
    if (qp_noChangeCount >= QP_MAX_NO_CHANGE) qp_tryClickLoadMore();
  } else {
    qp_noChangeCount = 0;
    qp_lastScrollHeight = currentScrollHeight;
  }
  
  qp_scrollTimeout = setTimeout(() => qp_doScroll(), QP_SCROLL_DELAY);
}

function qp_checkIfComplete(): void {
  const currentCount = qp_posts.size;
  console.log('[QP] State:', currentCount, '/', qp_targetCount);
  
  if (currentCount >= qp_targetCount) {
    console.log('[QP] Target reached!');
    qp_stopAutoScroll();
    qp_applySort();
    return;
  }
  
  if (currentCount === qp_lastPostCount) {
    qp_noNewPostsCount++;
    if (qp_noNewPostsCount >= 2 && qp_noNewPostsCount < QP_MAX_NO_NEW_POSTS) {
      qp_tryClickLoadMore();
    }
    if (qp_noNewPostsCount >= QP_MAX_NO_NEW_POSTS) {
      console.log('[QP] No more posts, sorting what we have');
      qp_stopAutoScroll();
      qp_applySort();
    }
  } else {
    qp_noNewPostsCount = 0;
  }
  
  qp_lastPostCount = currentCount;
}

function qp_tryClickLoadMore(): void {
  const buttons = document.querySelectorAll('button');
  
  for (const btn of buttons) {
    const text = btn.textContent?.toLowerCase() || '';
    const isVisible = (btn as HTMLElement).offsetParent !== null;
    if (!isVisible) continue;
    
    if (text.includes('показать') && text.includes('результат')) {
      btn.click();
      qp_noChangeCount = 0;
      return;
    }
    if ((text.includes('show') || text.includes('see')) && text.includes('new')) {
      btn.click();
      qp_noChangeCount = 0;
      return;
    }
    if (text.includes('weitere') || text.includes('mehr')) {
      btn.click();
      qp_noChangeCount = 0;
      return;
    }
  }
}

function qp_collectFromDOM(): void {
  const postElements = document.querySelectorAll('[data-urn^="urn:li:activity:"], [data-id^="urn:li:activity:"]');
  
  postElements.forEach((postEl) => {
    // Skip occluded/empty elements (LinkedIn virtual scroll placeholders)
    const hasVisibleContent = postEl.querySelector('.update-components-actor') ||
                              postEl.querySelector('.feed-shared-update-v2__description') ||
                              postEl.querySelector('.update-components-text') ||
                              postEl.querySelector('.feed-shared-text');
    if (!hasVisibleContent) return;
    
    const urn = postEl.getAttribute('data-urn') || 
                postEl.getAttribute('data-id') ||
                postEl.closest('[data-id]')?.getAttribute('data-id');
    
    if (!urn) return;
    
    const post = parsePostElement(postEl);
    if (post && post.activityUrn) {
      // Update if first time or previous data was incomplete
      const existing = qp_posts.get(post.activityUrn);
      if (!existing || existing.authorName === 'Unknown' || 
          (existing.numLikes === 0 && existing.numComments === 0 && post.numLikes > 0)) {
        qp_posts.set(post.activityUrn, post);
      }
    }
  });
}

function qp_stopAutoScroll(): void {
  qp_isScrolling = false;
  if (qp_scrollTimeout) { clearTimeout(qp_scrollTimeout); qp_scrollTimeout = null; }
  if (qp_checkInterval) { clearInterval(qp_checkInterval); qp_checkInterval = null; }
}

function qp_stop(): void {
  qp_stopAutoScroll();
  qp_hideOverlay();
  qp_isActive = false;
  qp_isScrolling = false;
  qp_sortType = null;
  qp_posts = new Map();
  
  document.querySelectorAll('.la-sort-btn').forEach(b => b.classList.remove('active', 'loading'));
  document.getElementById('la-status')?.classList.remove('visible');
}

async function qp_applySort(): Promise<void> {
  if (!qp_sortType) return;
  
  console.log('[QP] Applying sort:', qp_sortType);
  qp_updateOverlayText('Scrolling to top...');
  
  // Scroll to top first so LinkedIn re-renders posts in DOM
  window.scrollTo({ top: 0, behavior: 'auto' });
  await new Promise(r => setTimeout(r, 1500));
  
  // Re-collect posts that are now visible at the top
  qp_collectFromDOM();
  
  const posts = Array.from(qp_posts.values());
  // Filter out posts with no useful data (occluded when collected)
  const validPosts = posts.filter(p => p.authorName !== 'Unknown' || p.numLikes > 0 || p.numComments > 0);
  console.log('[QP] Got', posts.length, 'total,', validPosts.length, 'with data');
  
  if (validPosts.length === 0) {
    qp_updateOverlayText('No posts found');
    setTimeout(() => qp_finish(), 2000);
    return;
  }
  
  qp_updateOverlayText('Sorting posts...');
  const sorted = sortPosts(validPosts, qp_sortType);
  qp_updateOverlayText(`Applying ${sorted.length} posts...`);
  
  const urns = sorted.map(p => p.activityUrn);
  const data: PostData[] = sorted.map(p => ({
    activityUrn: p.activityUrn,
    authorName: p.authorName || 'Unknown',
    text: p.text || '',
    numLikes: p.numLikes || 0,
    numComments: p.numComments || 0,
    numShares: p.numShares || 0,
  }));
  
  qp_sortedPosts = data;
  
  // skipPlaceholders=true: don't create "Unknown" cards for posts not in DOM
  await reorderFeedPosts(urns, data, true);
  
  qp_updateOverlayText('Done!');
  await new Promise(r => setTimeout(r, 500));
  window.scrollTo({ top: 0, behavior: 'smooth' });
  await new Promise(r => setTimeout(r, 800));
  
  qp_finish();
}

function qp_finish(): void {
  console.log('[QP] Finished with', qp_posts.size, 'posts');
  qp_hideOverlay();
  qp_isActive = false;
  qp_sortType = null;
  
  const restoreBtn = document.getElementById('la-restore-btn');
  if (restoreBtn) restoreBtn.style.display = 'flex';
  
  const exportRow = document.getElementById('la-export-row');
  if (exportRow && qp_sortedPosts.length > 0) exportRow.style.display = 'flex';
  
  document.querySelectorAll('.la-sort-btn').forEach(b => b.classList.remove('loading'));
  document.getElementById('la-status')?.classList.remove('visible');
}

function qp_getExportData() {
  return qp_sortedPosts.map((p, i) => ({
    '#': i + 1,
    'Author': p.authorName || '',
    'Post Text': (p.text || '').substring(0, 500),
    'Likes': p.numLikes || 0,
    'Comments': p.numComments || 0,
    'Shares': p.numShares || 0,
    'Post URL': p.activityUrn ? `https://www.linkedin.com/feed/update/${p.activityUrn}` : '',
  }));
}

function qp_triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function qp_exportExcel(): void {
  const data = qp_getExportData();
  const ws = XLSX.utils.json_to_sheet(data);
  ws['!cols'] = [
    { wch: 4 }, { wch: 25 }, { wch: 60 }, { wch: 8 }, { wch: 10 }, { wch: 8 }, { wch: 50 }
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'LinkedIn Posts');
  const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  qp_triggerDownload(
    new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
    'linkedin-posts.xlsx'
  );
}

function qp_exportCSV(): void {
  const data = qp_getExportData();
  const headers = Object.keys(data[0] || {});
  const csvRows = [
    headers.join(','),
    ...data.map(row =>
      headers.map(h => {
        const val = String((row as any)[h] ?? '');
        return `"${val.replace(/"/g, '""')}"`;
      }).join(',')
    )
  ];
  qp_triggerDownload(
    new Blob(['\uFEFF' + csvRows.join('\n')], { type: 'text/csv;charset=utf-8;' }),
    'linkedin-posts.csv'
  );
}

function qp_exportJSON(): void {
  const data = qp_getExportData();
  qp_triggerDownload(
    new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
    'linkedin-posts.json'
  );
}

function qp_updateUI(sortType: string, count: number, _state: string): void {
  document.querySelectorAll('.la-sort-btn').forEach((btn) => {
    btn.classList.remove('active', 'loading');
    if (btn.getAttribute('data-sort') === sortType) btn.classList.add('active', 'loading');
  });
  
  document.querySelectorAll('.la-count-btn').forEach((btn) => {
    btn.classList.remove('active');
    if (parseInt(btn.getAttribute('data-count') || '0') === count) btn.classList.add('active');
  });
  
  document.getElementById('la-status')?.classList.add('visible');
  const statusText = document.getElementById('la-status-text');
  if (statusText) statusText.textContent = `Collecting ${count} posts...`;
}

function qp_showOverlay(current: number, target: number): void {
  qp_hideOverlay();
  
  const backdrop = document.createElement('div');
  backdrop.id = 'qp-backdrop';
  backdrop.innerHTML = `
    <style>
      #qp-backdrop {
        position: fixed;
        top: 0;
        left: 0;
        width: 100vw;
        height: 100vh;
        background: rgba(0, 0, 0, 0.7);
        z-index: 999998;
      }
    </style>
  `;
  document.body.appendChild(backdrop);
  
  // Create overlay
  const overlay = document.createElement('div');
  overlay.id = 'qp-overlay';
  overlay.innerHTML = `
    <style>
      #qp-overlay {
        position: fixed;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        background: white;
        padding: 40px 60px;
        border-radius: 16px;
        box-shadow: 0 20px 60px rgba(0,0,0,0.5);
        z-index: 999999;
        text-align: center;
        font-family: -apple-system, system-ui, sans-serif;
        min-width: 280px;
      }
      #qp-overlay .spinner {
        width: 60px;
        height: 60px;
        border: 5px solid #e5e7eb;
        border-top-color: #0077B5;
        border-radius: 50%;
        animation: qp-spin 0.8s linear infinite;
        margin: 0 auto 24px;
      }
      @keyframes qp-spin {
        to { transform: rotate(360deg); }
      }
      #qp-overlay .count {
        font-size: 36px;
        font-weight: 700;
        color: #0077B5;
        margin-bottom: 8px;
      }
      #qp-overlay .text {
        font-size: 14px;
        color: #6b7280;
        margin-bottom: 24px;
      }
      #qp-stop-btn {
        background: #dc2626;
        color: white;
        border: none;
        padding: 12px 32px;
        border-radius: 8px;
        font-size: 14px;
        font-weight: 600;
        cursor: pointer;
        transition: background 0.2s;
      }
      #qp-stop-btn:hover {
        background: #b91c1c;
      }
    </style>
    <div class="spinner"></div>
    <div class="count" id="qp-count">${current} / ${target}</div>
    <div class="text" id="qp-text">Collecting posts...</div>
    <button id="qp-stop-btn">Stop Collection</button>
  `;
  document.body.appendChild(overlay);
  
  // Add stop button handler
  const stopBtn = document.getElementById('qp-stop-btn');
  if (stopBtn) {
    stopBtn.addEventListener('click', () => {
      console.log('[QP] Stop button clicked');
      qp_stop();
    });
  }
}

function qp_updateOverlay(current: number, target: number): void {
  const countEl = document.getElementById('qp-count');
  if (countEl) countEl.textContent = `${current} / ${target}`;
}

function qp_updateOverlayText(text: string): void {
  const textEl = document.getElementById('qp-text');
  if (textEl) textEl.textContent = text;
}

function qp_hideOverlay(): void {
  const overlay = document.getElementById('qp-overlay');
  const backdrop = document.getElementById('qp-backdrop');
  if (overlay) overlay.remove();
  if (backdrop) backdrop.remove();
}

// Get collection state from background
function getCollectionState(): Promise<{ 
  currentCount: number; 
  isCollecting: boolean;
  targetCount?: number | 'all';
  collectionMode?: CollectionMode;
}> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "GET_COLLECTION_STATE" }, (response) => {
      resolve(response || { currentCount: 0, isCollecting: false });
    });
  });
}

// Get collected posts from background
function getCollectedPosts(): Promise<any[]> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "GET_POSTS" }, (response) => {
      resolve(response?.posts || []);
    });
  });
}

// Sort posts by criteria
function sortPosts(posts: any[], sortType: string): any[] {
  return [...posts].sort((a, b) => {
    switch (sortType) {
      case 'likes':
        return b.numLikes - a.numLikes;
      case 'comments':
        return b.numComments - a.numComments;
      case 'shares':
        return b.numShares - a.numShares;
      case 'engagement':
        const engA = a.numLikes + a.numComments * 2 + a.numShares * 3;
        const engB = b.numLikes + b.numComments * 2 + b.numShares * 3;
        return engB - engA;
      default:
        return 0;
    }
  });
}

// Initialize inline controls when page is ready
function initInlineControls(): void {
  if (window.location.pathname === '/feed/' || window.location.pathname === '/feed') {
    const checkFeed = setInterval(() => {
      let feedToggle: Element | null = document.querySelector('.feed-sort-toggle-dsa__wrapper');
      if (!feedToggle) {
        const hr = document.querySelector('hr.feed-index-sort-border');
        if (hr) feedToggle = hr.closest('.artdeco-dropdown') || hr.closest('.mb2');
      }
      if (!feedToggle) {
        const buttons = document.querySelectorAll('button.artdeco-dropdown__trigger');
        for (const btn of buttons) {
          const text = btn.textContent || '';
          if (text.includes('Сортировать') || text.includes('Sort by') || text.includes('Sortieren')) {
            feedToggle = btn.closest('.artdeco-dropdown');
            break;
          }
        }
      }
      if (feedToggle) {
        clearInterval(checkFeed);
        injectSortControls();
        checkPendingQuickSort();
      }
    }, 1000);
    setTimeout(() => clearInterval(checkFeed), 30000);
  }
}

// Legacy function - now just calls Quick Panel system
function checkPendingQuickSort(): void {
  qp_checkPending();
}

// Start inline controls
initInlineControls();

// Re-inject if navigating within LinkedIn SPA
let lastUrl = location.href;
new MutationObserver(() => {
  const currentUrl = location.href;
  if (currentUrl !== lastUrl) {
    lastUrl = currentUrl;
    setTimeout(initInlineControls, 1000);
  }
}).observe(document, { subtree: true, childList: true });
