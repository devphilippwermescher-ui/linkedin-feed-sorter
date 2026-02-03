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

export interface CollectionConfig {
  pageType: PageType;
  targetCount: number | 'all';
  tabId?: number;
}

