import { LinkedInPost, LinkedInAPIResponse, SocialActivityCounts } from 'types/linkedin';

export function parseLinkedInResponse(response: LinkedInAPIResponse, feedType?: 'main' | 'profile'): LinkedInPost[] {
  const posts: LinkedInPost[] = [];
  
  let elements: any[] = [];
  const included = response.included || [];
  
  if (response.data?.data?.feedDashMainFeedByMainFeed) {
    elements = response.data.data.feedDashMainFeedByMainFeed['*elements'] || [];
    console.log('[Parser] Parsing main feed, elements:', elements.length);
  } else if (response.data?.data?.feedDashProfileUpdatesByMemberShareFeed) {
    const profileFeed = response.data.data.feedDashProfileUpdatesByMemberShareFeed;
    elements = profileFeed['*elements'] || [];
    
    if (elements.length === 0 && profileFeed.elements) {
      elements = profileFeed.elements.map((el: any) => el['*update'] || el.entityUrn || el.urn).filter(Boolean);
    }
    console.log('[Parser] Parsing profile feed, elements:', elements.length);
  }
  
  if (elements.length === 0) {
    console.log('[Parser] No elements found in response');
    return posts;
  }

  const socialActivityByActivity = new Map<string, SocialActivityCounts>();
  const socialActivityByUgcPost = new Map<string, SocialActivityCounts>();
  const socialActivityByFullUrn = new Map<string, SocialActivityCounts>();
  const updateMap = new Map<string, any>();
  const profileMap = new Map<string, any>();
  const socialDetailMap = new Map<string, any>();

  included.forEach((item: any) => {
    if (!item) return;

    if (item.$type === 'com.linkedin.voyager.dash.feed.SocialActivityCounts') {
      const urn = item.urn || '';
      const entityUrn = item.entityUrn || '';
      const fullUrn = urn || entityUrn;
      
      if (fullUrn) {
        socialActivityByFullUrn.set(fullUrn, {
          numLikes: item.numLikes || 0,
          numComments: item.numComments || 0,
          numShares: item.numShares || 0,
          urn: fullUrn,
        });
      }
      
      const activityMatch = urn.match(/activity:(\d+)/) || entityUrn.match(/activity:(\d+)/);
      if (activityMatch) {
        const activityId = activityMatch[1];
        socialActivityByActivity.set(activityId, {
          numLikes: item.numLikes || 0,
          numComments: item.numComments || 0,
          numShares: item.numShares || 0,
          urn: fullUrn,
        });
      }
      
      const ugcMatch = urn.match(/ugcPost:(\d+)/) || entityUrn.match(/ugcPost:(\d+)/);
      if (ugcMatch) {
        const ugcId = ugcMatch[1];
        socialActivityByUgcPost.set(ugcId, {
          numLikes: item.numLikes || 0,
          numComments: item.numComments || 0,
          numShares: item.numShares || 0,
          urn: fullUrn,
        });
      }
    }
    
    if (item.$type === 'com.linkedin.voyager.dash.social.SocialDetail') {
      const entityUrn = item.entityUrn || '';
      if (entityUrn) {
        socialDetailMap.set(entityUrn, item);
        
        const activityMatches = entityUrn.match(/activity:(\d+)/g) || [];
        for (const match of activityMatches) {
          const id = match.replace('activity:', '');
          socialDetailMap.set(id, item);
        }
      }
      
      if (item['*totalSocialActivityCounts']) {
        const countsRef = item['*totalSocialActivityCounts'];
        const activityMatch = countsRef.match(/activity:(\d+)/);
        if (activityMatch) {
          socialDetailMap.set(`counts:${activityMatch[1]}`, countsRef);
        }
      }
    }

    if (item.$type === 'com.linkedin.voyager.dash.feed.Update' || 
        item.$type === 'com.linkedin.voyager.dash.feed.UpdateV2') {
      const entityUrn = item.entityUrn || item.urn || '';
      if (entityUrn) {
        updateMap.set(entityUrn, item);
        
        const activityMatch = entityUrn.match(/activity:(\d+)/);
        if (activityMatch) {
          const activityId = activityMatch[1];
          updateMap.set(activityId, item);
          updateMap.set(`urn:li:activity:${activityId}`, item);
        }
        
        const ugcMatch = entityUrn.match(/ugcPost:(\d+)/);
        if (ugcMatch) {
          updateMap.set(ugcMatch[1], item);
        }
      }
    }

    if (item.$type?.includes('Profile') || 
        item.$type?.includes('Member') ||
        item.$type === 'com.linkedin.voyager.identity.shared.MiniProfile') {
      const urn = item.entityUrn || item.urn || item.trackingUrn || '';
      if (urn) {
        let name = '';
        
        if (item.name?.text) {
          name = item.name.text;
        } else if (typeof item.name === 'string') {
          name = item.name;
        } else if (item.firstName || item.lastName) {
          name = `${item.firstName || ''} ${item.lastName || ''}`.trim();
        }
        
        if (name) {
          profileMap.set(urn, { name, urn });
          
          if (item.trackingUrn && item.trackingUrn !== urn) {
            profileMap.set(item.trackingUrn, { name, urn });
          }
        }
      }
    }
  });

  for (const [key, ref] of socialDetailMap.entries()) {
    if (key.startsWith('counts:') && typeof ref === 'string') {
      const activityId = key.replace('counts:', '');
      const countsObj = socialActivityByFullUrn.get(ref);
      if (countsObj && !socialActivityByActivity.has(activityId)) {
        socialActivityByActivity.set(activityId, countsObj);
      }
    }
  }

  elements.forEach((elementUrn: string) => {
    if (!elementUrn || typeof elementUrn !== 'string') return;

    let activityId: string | null = null;
    let activityUrn = '';
    
    const activityMatch = elementUrn.match(/activity:(\d+)/);
    if (activityMatch) {
      activityId = activityMatch[1];
      activityUrn = `urn:li:activity:${activityId}`;
    } else {
      const urnMatch = elementUrn.match(/urn:li:activity:(\d+)/);
      if (urnMatch) {
        activityId = urnMatch[1];
        activityUrn = elementUrn;
      } else {
        return;
      }
    }

    if (!activityId) return;

    let update = updateMap.get(activityId) || 
                 updateMap.get(activityUrn) ||
                 updateMap.get(`urn:li:activity:${activityId}`);
    
    if (!update) {
      for (const [key, value] of updateMap.entries()) {
        if (key.includes(activityId)) {
          update = value;
          break;
        }
      }
    }
    
    let socialActivity: SocialActivityCounts | undefined;
    
    socialActivity = socialActivityByActivity.get(activityId);
    
    if (!socialActivity) {
      socialActivity = socialActivityByFullUrn.get(activityUrn);
    }
    
    if (!socialActivity) {
      const fsdCountsUrn = `urn:li:fsd_socialActivityCounts:urn:li:activity:${activityId}`;
      socialActivity = socialActivityByFullUrn.get(fsdCountsUrn);
    }
    
    if (!socialActivity && update) {
      const socialDetailRef = update['*socialDetail'] || '';
      if (socialDetailRef) {
        const threadMatch = socialDetailRef.match(/activity:(\d+)/);
        if (threadMatch) {
          const threadActivityId = threadMatch[1];
          socialActivity = socialActivityByActivity.get(threadActivityId);
          
          if (!socialActivity) {
            const fsdCountsUrn = `urn:li:fsd_socialActivityCounts:urn:li:activity:${threadActivityId}`;
            socialActivity = socialActivityByFullUrn.get(fsdCountsUrn);
          }
        }
        
        if (!socialActivity) {
          const ugcMatches = socialDetailRef.match(/ugcPost:(\d+)/g) || [];
          for (const match of ugcMatches) {
            const id = match.replace('ugcPost:', '');
            const found = socialActivityByUgcPost.get(id);
            if (found) {
              socialActivity = found;
              break;
            }
          }
        }
      }
      
      if (!socialActivity) {
        const shareUrn = update.metadata?.shareUrn || '';
        if (shareUrn) {
          const ugcMatch = shareUrn.match(/ugcPost:(\d+)/);
          if (ugcMatch) {
            socialActivity = socialActivityByUgcPost.get(ugcMatch[1]);
          }
          
          const shareMatch = shareUrn.match(/share:(\d+)/);
          if (!socialActivity && shareMatch) {
            const shareId = shareMatch[1];
            for (const [urn, counts] of socialActivityByFullUrn.entries()) {
              if (urn.includes(shareId)) {
                socialActivity = counts;
                break;
              }
            }
          }
        }
      }
    }
    
    if (!socialActivity) {
      for (const [urn, counts] of socialActivityByFullUrn.entries()) {
        if (urn.includes(activityId)) {
          socialActivity = counts;
          break;
        }
      }
    }

    const numLikes = socialActivity?.numLikes || 0;
    const numComments = socialActivity?.numComments || 0;
    const numShares = socialActivity?.numShares || 0;

    let authorName = 'Unknown';
    let authorUrn = '';
    let text = '';

    if (update) {
      if (update.actor) {
        if (update.actor.name?.text) {
          authorName = update.actor.name.text;
        } else if (typeof update.actor.name === 'string') {
          authorName = update.actor.name;
        } else if (update.actor.firstName || update.actor.lastName) {
          authorName = `${update.actor.firstName || ''} ${update.actor.lastName || ''}`.trim();
        }
        
        authorUrn = update.actor.urn || 
                    update.actor.entityUrn || 
                    update.actor.backendUrn ||
                    update.actor.trackingUrn ||
                    '';
      }

      if (update.commentary?.text?.text) {
        text = update.commentary.text.text;
      } else if (typeof update.commentary?.text === 'string') {
        text = update.commentary.text;
      } else if (update.commentary) {
        text = String(update.commentary);
      }
    } else {
      for (const item of included) {
        if (!item) continue;
        
        const itemUrn = item.entityUrn || item.urn || '';
        if (itemUrn && itemUrn.includes(activityId)) {
          if (item.$type?.includes('Update')) {
            if (item.actor?.name?.text) {
              authorName = item.actor.name.text;
            }
            authorUrn = item.actor?.urn || item.actor?.entityUrn || item.actor?.backendUrn || '';
            
            if (item.commentary?.text?.text) {
              text = item.commentary.text.text;
            } else if (typeof item.commentary?.text === 'string') {
              text = item.commentary.text;
            }
            break;
          }
        }
      }
    }

    const hashtags: string[] = [];
    const hashtagRegex = /#(\w+)/g;
    let match;
    while ((match = hashtagRegex.exec(text)) !== null) {
      hashtags.push(match[1]);
    }

    const isSponsored = elementUrn.includes('sponsored');

    if (authorName === 'Unknown') {
      console.log(`[Parser] Post ${activityId}: Author not found`);
    }

    if (socialActivity && (numLikes > 0 || numComments > 0 || numShares > 0)) {
      console.log(`[Parser] Post ${activityId}:`, authorName, `- likes: ${numLikes}, comments: ${numComments}, shares: ${numShares}`);
    } else if (!socialActivity) {
      console.log(`[Parser] Post ${activityId}: No social activity found`);
    }

    posts.push({
      activityUrn,
      authorName,
      authorUrn,
      text,
      numLikes,
      numComments,
      numShares,
      hashtags: hashtags.length > 0 ? hashtags : undefined,
      isSponsored,
    });
  });

  return posts;
}

export function extractActivityUrnFromElement(elementUrn: string): string | null {
  const match = elementUrn.match(/urn:li:activity:(\d+)/);
  return match ? `urn:li:activity:${match[1]}` : null;
}
