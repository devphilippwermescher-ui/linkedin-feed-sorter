import { LinkedInPost, LinkedInAPIResponse, SocialActivityCounts } from 'types/linkedin';

export function parseLinkedInResponse(response: LinkedInAPIResponse): LinkedInPost[] {
  const posts: LinkedInPost[] = [];
  
  if (!response.data?.data?.feedDashMainFeedByMainFeed) {
    return posts;
  }

  const elements = response.data.data.feedDashMainFeedByMainFeed['*elements'] || [];
  const included = response.included || [];

  const socialActivityByActivity = new Map<string, SocialActivityCounts>();
  const socialActivityByUgcPost = new Map<string, SocialActivityCounts>();
  const socialActivityByFullUrn = new Map<string, SocialActivityCounts>();
  const updateMap = new Map<string, any>();
  const profileMap = new Map<string, any>();

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
    
    if (!socialActivity && update) {
      const shareUrn = update.metadata?.shareUrn || '';
      if (shareUrn) {
        const ugcMatch = shareUrn.match(/ugcPost:(\d+)/);
        if (ugcMatch) {
          socialActivity = socialActivityByUgcPost.get(ugcMatch[1]);
        }
      }
      
      if (!socialActivity) {
        const socialDetailRef = update['*socialDetail'] || update.socialDetail || '';
        
        if (socialDetailRef) {
          const ugcMatches = socialDetailRef.match(/ugcPost:(\d+)/g) || [];
          for (const match of ugcMatches) {
            const id = match.replace('ugcPost:', '');
            const found = socialActivityByUgcPost.get(id);
            if (found) {
              socialActivity = found;
              break;
            }
          }
          
          if (!socialActivity) {
            const allActivityIds = socialDetailRef.match(/activity:(\d+)/g) || [];
            for (const match of allActivityIds) {
              const id = match.replace('activity:', '');
              const found = socialActivityByActivity.get(id);
              if (found) {
                socialActivity = found;
                break;
              }
              
              const fullUrn = `urn:li:activity:${id}`;
              const foundByUrn = socialActivityByFullUrn.get(fullUrn);
              if (foundByUrn) {
                socialActivity = foundByUrn;
                break;
              }
            }
          }
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
      console.log(`[Parser] Post ${activityId}: Author not found`, {
        activityId,
        activityUrn,
        hasUpdate: !!update,
        updateActor: update?.actor ? {
          urn: update.actor.urn || update.actor.entityUrn || 'none',
          name: update.actor.name || 'none',
          firstName: update.actor.firstName || 'none',
          lastName: update.actor.lastName || 'none',
        } : 'none',
        profileMapSize: profileMap.size,
        updateMapSize: updateMap.size,
      });
    }

    if (socialActivity && (numLikes > 0 || numComments > 0 || numShares > 0)) {
      console.log(`[Parser] Post ${activityId}: Found social activity`, {
        activityId,
        activityUrn,
        authorName,
        numLikes,
        numComments,
        numShares,
        socialActivityUrn: socialActivity.urn,
      });
    } else if (!socialActivity) {
      console.log(`[Parser] Post ${activityId}: No social activity found`, {
        activityId,
        activityUrn,
        authorName,
        hasUpdate: !!update,
        socialDetailRef: update?.['*socialDetail'] || update?.socialDetail || 'none',
      });
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
