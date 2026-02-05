import { LinkedInAPIResponse, LinkedInPost, PageType } from "types/linkedin";
import { parseLinkedInResponse } from "utils/parser";

console.log('[LinkedIn Analyzer] Background script loaded');

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "LINKEDIN_FEED_DATA") {
    handleFeedData(message.data as LinkedInAPIResponse, message.feedType);
    sendResponse({ success: true });
    return true;
  }

  if (message.type === "DOM_POSTS") {
    handleDOMPosts(message.posts);
    sendResponse({ success: true });
    return true;
  }

  if (message.type === "SYNC_DOM_METRICS") {
    syncDOMMetrics(message.updates);
    sendResponse({ success: true });
    return true;
  }

  if (message.type === "GET_POSTS") {
    chrome.storage.local.get(["linkedinPosts", "collectionState"], (result) => {
      const data = result.linkedinPosts || { posts: [], lastUpdate: 0 };
      const state = result.collectionState || {};
      
      if (state.requestedCount && state.requestedCount !== Infinity && data.posts.length > state.requestedCount) {
        data.posts = data.posts.slice(0, state.requestedCount);
      }
      
      sendResponse(data);
    });
    return true;
  }

  if (message.type === "CLEAR_POSTS") {
    chrome.storage.local.set({ linkedinPosts: { posts: [], lastUpdate: 0 } }, () => {
      sendResponse({ success: true });
    });
    return true;
  }

  if (message.type === "START_COLLECTION") {
    const pageType: PageType = message.pageType || 'main-feed';
    const requestedCount = message.targetCount === 'all' ? Infinity : message.targetCount;
    const BUFFER_SIZE = 11;
    const targetCount = requestedCount === Infinity ? Infinity : requestedCount + BUFFER_SIZE;
    
    chrome.storage.local.set({ 
      linkedinPosts: { posts: [], lastUpdate: 0 },
      collectionState: {
        isCollecting: true,
        targetCount: targetCount,
        requestedCount: requestedCount,
        collectAll: message.targetCount === 'all',
        pageType: pageType,
        tabId: message.tabId,
      }
    }, () => {
      console.log('[LinkedIn Analyzer] Collection started, requested:', requestedCount, 'target:', targetCount, 'pageType:', pageType);
      sendResponse({ success: true });
    });
    return true;
  }

  if (message.type === "STOP_COLLECTION") {
    chrome.storage.local.get(["collectionState"], (result) => {
      const state = result.collectionState || {};
      chrome.storage.local.set({
        collectionState: { ...state, isCollecting: false }
      }, () => {
        sendResponse({ success: true });
      });
    });
    return true;
  }

  if (message.type === "GET_COLLECTION_STATE") {
    chrome.storage.local.get(["linkedinPosts", "collectionState"], (result) => {
      const posts = result.linkedinPosts?.posts || [];
      const state = result.collectionState || { isCollecting: false, targetCount: 0, requestedCount: 0, collectAll: false, pageType: 'main-feed' };
      const displayCount = state.requestedCount || state.targetCount;
      
      console.log('[LinkedIn Analyzer] State:', posts.length, '/', displayCount, 'isCollecting:', state.isCollecting);
      
      sendResponse({
        isCollecting: state.isCollecting,
        targetCount: state.collectAll ? 'all' : displayCount,
        currentCount: Math.min(posts.length, displayCount),
        collectAll: state.collectAll,
        pageType: state.pageType,
      });
    });
    return true;
  }

  return false;
});

async function handleFeedData(response: LinkedInAPIResponse, feedType?: 'main' | 'profile') {
  try {
    const mainFeedElements = response.data?.data?.feedDashMainFeedByMainFeed?.['*elements'] || [];
    const profileFeedData = response.data?.data?.feedDashProfileUpdatesByMemberShareFeed;
    let profileFeedElements: any[] = [];
    
    if (profileFeedData) {
      profileFeedElements = profileFeedData['*elements'] || [];
      if (profileFeedElements.length === 0 && profileFeedData.elements) {
        profileFeedElements = profileFeedData.elements.map((el: any) => el['*update'] || el.entityUrn || el.urn).filter(Boolean);
      }
    }
    
    const elements = mainFeedElements.length > 0 ? mainFeedElements : profileFeedElements;
    const included = response.included || [];
    
    console.log('[LinkedIn Analyzer] Feed data:', elements.length, 'elements,', included.length, 'included');
    
    const parsedPosts = parseLinkedInResponse(response, feedType);
    
    if (parsedPosts.length === 0) {
      console.log('[LinkedIn Analyzer] No posts parsed');
      return;
    }

    const postsWithMetrics = parsedPosts.filter(p => p.numLikes > 0 || p.numComments > 0 || p.numShares > 0);
    console.log('[LinkedIn Analyzer] Parsed:', parsedPosts.length, 'posts,', postsWithMetrics.length, 'with metrics');

    const result = await chrome.storage.local.get(["linkedinPosts", "collectionState"]);
    const existingData = result.linkedinPosts || { posts: [], lastUpdate: 0 };
    const collectionState = result.collectionState || { isCollecting: false, targetCount: 0, collectAll: false };
    
    const existingPostsMap = new Map<string, LinkedInPost>(
      existingData.posts.map((p: any) => [p.activityUrn, p as LinkedInPost])
    );
    
    for (const newPost of parsedPosts) {
      const existing = existingPostsMap.get(newPost.activityUrn);
      
      if (existing) {
        const existingScore = existing.numLikes + existing.numComments + existing.numShares;
        const newScore = newPost.numLikes + newPost.numComments + newPost.numShares;
        
        if (newScore > existingScore) {
          existingPostsMap.set(newPost.activityUrn, newPost);
        }
      } else {
        existingPostsMap.set(newPost.activityUrn, newPost);
      }
    }
    
    existingData.posts = Array.from(existingPostsMap.values());
    existingData.lastUpdate = Date.now();

    await chrome.storage.local.set({ linkedinPosts: existingData });

    const targetDisplay = collectionState.collectAll ? 'all' : collectionState.targetCount;
    console.log('[LinkedIn Analyzer] Total posts:', existingData.posts.length, '/', targetDisplay);

    if (collectionState.isCollecting && 
        !collectionState.collectAll &&
        collectionState.targetCount > 0 && 
        existingData.posts.length >= collectionState.targetCount) {
      
      await chrome.storage.local.set({
        collectionState: { ...collectionState, isCollecting: false }
      });
      
      console.log('[LinkedIn Analyzer] Target reached, stopping');
      
      if (collectionState.tabId) {
        chrome.tabs.sendMessage(collectionState.tabId, { 
          type: "STOP_AUTO_SCROLL" 
        }).catch(() => {});
      }
    }
  } catch (error) {
    console.log('[LinkedIn Analyzer] Parse error:', error);
  }
}

async function syncDOMMetrics(updates: Array<{
  activityUrn: string;
  numLikes: number;
  numComments: number;
  numShares: number;
  authorName?: string;
}>) {
  try {
    if (!updates || updates.length === 0) return;

    const result = await chrome.storage.local.get(["linkedinPosts"]);
    const existingData = result.linkedinPosts || { posts: [], lastUpdate: 0 };
    
    if (existingData.posts.length === 0) return;
    
    const postsMap = new Map<string, LinkedInPost>(
      existingData.posts.map((p: any) => [p.activityUrn, p as LinkedInPost])
    );
    
    let updatedCount = 0;
    
    for (const update of updates) {
      const existing = postsMap.get(update.activityUrn);
      
      if (existing) {
        const existingScore = existing.numLikes + existing.numComments + existing.numShares;
        const domScore = update.numLikes + update.numComments + update.numShares;
        
        if (domScore > existingScore) {
          existing.numLikes = Math.max(existing.numLikes, update.numLikes);
          existing.numComments = Math.max(existing.numComments, update.numComments);
          existing.numShares = Math.max(existing.numShares, update.numShares);
          
          if (existing.authorName === 'Unknown' && update.authorName && update.authorName !== 'Unknown') {
            existing.authorName = update.authorName;
          }
          
          postsMap.set(update.activityUrn, existing);
          updatedCount++;
        }
      }
    }
    
    if (updatedCount > 0) {
      existingData.posts = Array.from(postsMap.values());
      existingData.lastUpdate = Date.now();
      await chrome.storage.local.set({ linkedinPosts: existingData });
      console.log('[LinkedIn Analyzer] DOM sync updated', updatedCount, 'posts');
    }
  } catch (error) {
    console.log('[LinkedIn Analyzer] DOM sync error:', error);
  }
}

async function handleDOMPosts(posts: LinkedInPost[]) {
  try {
    if (!posts || posts.length === 0) {
      console.log('[LinkedIn Analyzer] No DOM posts received');
      return;
    }

    console.log('[LinkedIn Analyzer] Processing DOM posts:', posts.length);

    const result = await chrome.storage.local.get(["linkedinPosts", "collectionState"]);
    const existingData = result.linkedinPosts || { posts: [], lastUpdate: 0 };
    const collectionState = result.collectionState || { isCollecting: false };
    
    if (!collectionState.isCollecting) {
      console.log('[LinkedIn Analyzer] Not collecting, ignoring DOM posts');
      return;
    }
    
    const existingPostsMap = new Map<string, LinkedInPost>(
      existingData.posts.map((p: any) => [p.activityUrn, p as LinkedInPost])
    );
    
    for (const domPost of posts) {
      const existing = existingPostsMap.get(domPost.activityUrn);
      
      if (existing) {
        const existingScore = existing.numLikes + existing.numComments + existing.numShares;
        const domScore = domPost.numLikes + domPost.numComments + domPost.numShares;
        
        if (domScore > existingScore) {
          existingPostsMap.set(domPost.activityUrn, domPost);
        }
      } else {
        console.log('[LinkedIn Analyzer] Adding DOM post:', domPost.authorName, 'likes:', domPost.numLikes);
        existingPostsMap.set(domPost.activityUrn, domPost);
      }
    }
    
    existingData.posts = Array.from(existingPostsMap.values());
    existingData.lastUpdate = Date.now();

    await chrome.storage.local.set({ linkedinPosts: existingData });
    
    console.log('[LinkedIn Analyzer] DOM posts added, total:', existingData.posts.length);
  } catch (error) {
    console.log('[LinkedIn Analyzer] DOM posts error:', error);
  }
}
