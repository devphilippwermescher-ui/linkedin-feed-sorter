import { LinkedInAPIResponse } from "types/linkedin";
import { parseLinkedInResponse } from "utils/parser";

console.log('[LinkedIn Analyzer] Background script loaded');

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "LINKEDIN_FEED_DATA") {
    handleFeedData(message.data as LinkedInAPIResponse);
    sendResponse({ success: true });
    return true;
  }

  if (message.type === "GET_POSTS") {
    chrome.storage.local.get(["linkedinPosts"], (result) => {
      const data = result.linkedinPosts || { posts: [], lastUpdate: 0 };
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
    chrome.storage.local.set({ 
      linkedinPosts: { posts: [], lastUpdate: 0 },
      collectionState: {
        isCollecting: true,
        targetCount: message.targetCount,
        tabId: message.tabId,
      }
    }, () => {
      console.log('[LinkedIn Analyzer] Collection started, target:', message.targetCount);
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
      const state = result.collectionState || { isCollecting: false, targetCount: 0 };
      console.log('[LinkedIn Analyzer] GET_COLLECTION_STATE:', { 
        isCollecting: state.isCollecting, 
        targetCount: state.targetCount, 
        currentCount: posts.length 
      });
      sendResponse({
        isCollecting: state.isCollecting,
        targetCount: state.targetCount,
        currentCount: posts.length,
      });
    });
    return true;
  }

  return false;
});

async function handleFeedData(response: LinkedInAPIResponse) {
  try {
    const elements = response.data?.data?.feedDashMainFeedByMainFeed?.['*elements'] || [];
    const included = response.included || [];
    
    console.log('[LinkedIn Analyzer] Processing feed data:', {
      elementsCount: elements.length,
      includedCount: included.length,
      socialActivityCount: included.filter((i: any) => i.$type === 'com.linkedin.voyager.dash.feed.SocialActivityCounts').length,
      updateCount: included.filter((i: any) => i.$type?.includes('Update')).length,
    });
    
    const parsedPosts = parseLinkedInResponse(response);
    
    if (parsedPosts.length === 0) {
      console.log('[LinkedIn Analyzer] No posts parsed from response');
      return;
    }

    const postsWithMetrics = parsedPosts.filter(p => p.numLikes > 0 || p.numComments > 0 || p.numShares > 0);
    console.log('[LinkedIn Analyzer] Parsed posts:', {
      total: parsedPosts.length,
      withMetrics: postsWithMetrics.length,
      withoutMetrics: parsedPosts.length - postsWithMetrics.length,
      sample: parsedPosts.slice(0, 3).map(p => ({
        author: p.authorName,
        likes: p.numLikes,
        comments: p.numComments,
        shares: p.numShares,
      })),
    });

    const result = await chrome.storage.local.get(["linkedinPosts", "collectionState"]);
    const existingData = result.linkedinPosts || { posts: [], lastUpdate: 0 };
    const collectionState = result.collectionState || { isCollecting: false, targetCount: 0 };
    
    const existingUrns = new Set(existingData.posts.map((p: any) => p.activityUrn));
    const newPosts = parsedPosts.filter((p) => !existingUrns.has(p.activityUrn));
    
    existingData.posts = [...existingData.posts, ...newPosts];
    existingData.lastUpdate = Date.now();

    await chrome.storage.local.set({ linkedinPosts: existingData });

    console.log('[LinkedIn Analyzer] Posts collected:', existingData.posts.length, '/', collectionState.targetCount);

    if (collectionState.isCollecting && 
        collectionState.targetCount > 0 && 
        existingData.posts.length >= collectionState.targetCount) {
      
      await chrome.storage.local.set({
        collectionState: { ...collectionState, isCollecting: false }
      });
      
      console.log('[LinkedIn Analyzer] Target reached, stopping collection');
      
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
