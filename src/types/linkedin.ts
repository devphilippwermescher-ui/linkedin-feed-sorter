export interface LinkedInPost {
  activityUrn: string;
  authorName: string;
  authorUrn: string;
  text?: string;
  numLikes: number;
  numComments: number;
  numShares: number;
  timestamp?: number;
  isSponsored?: boolean;
  hashtags?: string[];
}

export interface SocialActivityCounts {
  numLikes: number;
  numComments: number;
  numShares: number;
  urn: string;
  reactionTypeCounts?: Array<{
    count: number;
    reactionType: string;
  }>;
}

export interface LinkedInAPIResponse {
  data?: {
    data?: {
      feedDashMainFeedByMainFeed?: {
        '*elements'?: string[];
        paging?: {
          count: number;
          start: number;
          total: number;
        };
      };
      feedDashProfileUpdatesByMemberShareFeed?: {
        '*elements'?: string[];
        elements?: any[];
        paging?: {
          count: number;
          start: number;
          total: number;
        };
        metadata?: {
          paginationToken?: string;
          paginationTokenExpiryTime?: number | null;
        };
      };
    };
  };
  included?: any[];
  feedType?: 'main' | 'profile';
}

export type SortOption = 'likes' | 'comments' | 'shares' | 'engagement' | 'default';

export type PageType = 'main-feed' | 'profile-feed' | 'other';

// Collection modes:
// - lite: Fast collection from API only (basic)
// - synced: API + DOM synchronization (balanced)
// - precision: API + DOM sync + DOM fallback (100% accuracy)
export type CollectionMode = 'lite' | 'synced' | 'precision';

export const COLLECTION_MODE_INFO: Record<CollectionMode, { label: string; description: string; premium: boolean }> = {
  lite: { label: 'Lite', description: 'Fast • API only', premium: false },
  synced: { label: 'Synced', description: 'Balanced • API + DOM', premium: true },
  precision: { label: 'Precision', description: 'Best accuracy • Full scan', premium: true },
};

// User plan
export type UserPlan = 'free' | 'premium';

export const PLAN_INFO: Record<UserPlan, { label: string; description: string }> = {
  free: { label: 'Free', description: 'Basic features' },
  premium: { label: 'Premium', description: 'All features unlocked' },
};

// Free plan limits
export const FREE_PLAN_LIMITS = {
  maxPosts: 25,
  allowedModes: ['lite'] as CollectionMode[],
};

export interface CollectionConfig {
  pageType: PageType;
  targetCount: number | 'all';
  tabId?: number;
  mode?: CollectionMode;
}

